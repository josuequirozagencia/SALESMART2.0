// M3.6 — Empresas, notas y tareas (ADR-48). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/companies
//   POST /v1/companies
//   GET /v1/companies/:id
//   PATCH /v1/companies/:id
//   DELETE /v1/companies/:id
//   GET /v1/companies/:id/contacts
//   POST /v1/companies/:id/contacts
//   POST /v1/companies/:id/contacts/remove
//   GET /v1/companies/:id/notes
//   POST /v1/companies/:id/notes
//   POST /v1/contacts/:contactId/companies/:companyId
//   DELETE /v1/contacts/:contactId/companies/:companyId
//   GET /v1/contacts/:contactId/notes
//   POST /v1/contacts/:contactId/notes
//   PATCH /v1/notes/:id
//   DELETE /v1/notes/:id
//   GET /v1/tasks
//   POST /v1/tasks
//   GET /v1/tasks/:id
//   PATCH /v1/tasks/:id
//   DELETE /v1/tasks/:id
//   POST /v1/tasks/:id/complete
//   POST /v1/tasks/:id/reopen
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  erin: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';

interface Company { id: string; name: string; website: string | null; phone: string | null; email: string | null; contact_count: number }
interface Page<T> { items: T[]; next_cursor: string | null; total?: number | null }
interface Note { id: string; body: string; author: { id: string; name: string }; edited_at: string | null; can_edit: boolean; can_delete: boolean }
interface Task { id: string; title: string; description: string | null; due_at: string | null; status: string; completed_at: string | null; assignee: { id: string; name: string }; contact: { id: string; name: string } | null; company: { id: string; name: string } | null; overdue: boolean; can_edit: boolean; can_complete: boolean }
interface Contact { id: string; name: string; companies: Array<{ id: string; name: string }> }
interface Err { error: { code: string; message: string; details: Array<{ path: string; code: string; message: string }> } }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE tasks, notes, contact_companies, companies, contact_import_rows, contact_imports, contact_list_members, contact_lists, contact_tags, tags, meta_events, custom_field_values, custom_field_definitions, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.erin, 'erin@a.test', 'Erika Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.erin, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
  for (const [u, o, r, lv] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, lv]);
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
let T: Record<'alice' | 'carol' | 'erin' | 'bob' | 'dave' | 'root', string>;
const code = async (r: Response): Promise<string> => (await json<Err>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};

const mkCompany = async (t: string, name: string, extra: Record<string, unknown> = {}): Promise<Company> => ok<Company>(await call('POST', '/companies', t, { name, ...extra }), 201);
const mkContact = async (t: string, name: string, phone: string, extra: Record<string, unknown> = {}): Promise<Contact> => ok<Contact>(await call('POST', '/contacts', t, { name, phones: [phone], ...extra }), 201);
const mkTask = async (t: string, body: Record<string, unknown>): Promise<Task> => ok<Task>(await call('POST', '/tasks', t, body), 201);
const getContact = async (t: string, id: string): Promise<Contact> => ok<Contact>(await call('GET', `/contacts/${id}`, t));
const audits = async (entityType: string, entityId?: string) =>
  (await admin.query(`SELECT entity_id, field, old_value, new_value FROM audit_logs WHERE entity_type = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY at, id`, entityId ? [entityType, entityId] : [entityType])).rows as Array<{ entity_id: string; field: string | null; old_value: unknown; new_value: Record<string, unknown> }>;
const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), erin: await login('erin@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('permisos', () => {
  it('sin sesión 401 y la plataforma 403 en todas las rutas', async () => {
    const id = NOBODY;
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/companies'], ['POST', '/companies', { name: 'x' }], ['GET', `/companies/${id}`], ['PATCH', `/companies/${id}`, { name: 'y' }], ['DELETE', `/companies/${id}`],
      ['GET', `/companies/${id}/contacts`], ['POST', `/companies/${id}/contacts`, { contact_ids: [id] }], ['POST', `/companies/${id}/contacts/remove`, { contact_ids: [id] }], ['GET', `/companies/${id}/notes`], ['POST', `/companies/${id}/notes`, { body: 'x' }],
      ['POST', `/contacts/${id}/companies/${id}`], ['DELETE', `/contacts/${id}/companies/${id}`], ['GET', `/contacts/${id}/notes`], ['POST', `/contacts/${id}/notes`, { body: 'x' }], ['PATCH', `/notes/${id}`, { body: 'x' }], ['DELETE', `/notes/${id}`],
      ['GET', '/tasks'], ['POST', '/tasks', { title: 'x' }], ['GET', `/tasks/${id}`], ['PATCH', `/tasks/${id}`, { title: 'x' }], ['DELETE', `/tasks/${id}`], ['POST', `/tasks/${id}/complete`], ['POST', `/tasks/${id}/reopen`],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('solo el administrador crea, edita y borra empresas; el asesor las lee y escribe notas y tareas; la agencia en «lectura» solo lee', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    expect((await call('GET', '/companies', T.carol)).status).toBe(200);
    expect((await ok<{ access: { manage: boolean; write: boolean } }>(await call('GET', '/companies', T.carol))).access).toEqual({ manage: false, write: true });
    expect((await ok<{ access: { manage: boolean; write: boolean } }>(await call('GET', '/companies', T.alice))).access).toEqual({ manage: true, write: true });
    expect((await call('POST', '/companies', T.carol, { name: 'De Carolina' })).status).toBe(403);
    expect((await call('PATCH', `/companies/${co.id}`, T.carol, { website: 'acme.test' })).status).toBe(403);
    expect((await call('DELETE', `/companies/${co.id}`, T.carol)).status).toBe(403);
    expect((await call('POST', `/companies/${co.id}/contacts`, T.carol, { contact_ids: [NOBODY] })).status).toBe(403);
    expect((await call('POST', `/companies/${co.id}/contacts/remove`, T.carol, { contact_ids: [NOBODY] })).status).toBe(403);
    expect((await call('POST', `/contacts/${NOBODY}/companies/${co.id}`, T.carol)).status).toBe(403);
    expect((await call('DELETE', `/contacts/${NOBODY}/companies/${co.id}`, T.carol)).status).toBe(403);
    // las notas y tareas de una empresa sí las escribe el asesor
    expect((await call('POST', `/companies/${co.id}/notes`, T.carol, { body: 'Cuenta clave' })).status).toBe(201);
    expect((await call('POST', '/tasks', T.carol, { title: 'Llamar', company_id: co.id })).status).toBe(201);
    expect((await call('PATCH', `/companies/${co.id}`, T.alice, { website: 'acme.test' })).status).toBe(200);
    expect((await call('DELETE', `/companies/${co.id}`, T.alice)).status).toBe(200);

    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    const keep = await mkCompany(T.alice, 'Otra');
    expect((await call('GET', '/companies', T.dave)).status).toBe(200);
    expect((await call('GET', '/tasks?assignee=all', T.dave)).status).toBe(200);
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await call('GET', '/companies', T.dave)).status).toBe(200);
    expect((await call('POST', '/companies', T.dave, { name: 'No' })).status).toBe(403);
    expect((await call('PATCH', `/companies/${keep.id}`, T.dave, { name: 'No' })).status).toBe(403);
    expect((await call('POST', `/companies/${keep.id}/notes`, T.dave, { body: 'No' })).status).toBe(403);
    expect((await call('POST', '/tasks', T.dave, { title: 'No' })).status).toBe(403);
  });
});

describe('empresas', () => {
  it('alta, lectura, edición parcial y borrado lógico; el nombre se compara sin mayúsculas y se libera al borrar', async () => {
    const co = await ok<Company>(await call('POST', '/companies', T.alice, { name: '  Acme SA  ', website: 'acme.test', phone: '+593984217730', email: 'Info@Acme.TEST' }), 201);
    expect(co).toMatchObject({ name: 'Acme SA', website: 'acme.test', phone: '+593984217730', email: 'info@acme.test', contact_count: 0 });
    const dup = await call('POST', '/companies', T.alice, { name: 'ACME sa' });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('COMPANY_EXISTS');
    const other = await mkCompany(T.alice, 'Otra');
    const clash = await call('PATCH', `/companies/${other.id}`, T.alice, { name: 'acme SA' });
    expect(await code(clash)).toBe('COMPANY_EXISTS');

    const edited = await ok<Company>(await call('PATCH', `/companies/${co.id}`, T.alice, { website: null, phone: '+34612345678' }));
    expect(edited).toMatchObject({ name: 'Acme SA', website: null, phone: '+34612345678', email: 'info@acme.test' });
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.alice))).phone).toBe('+34612345678');

    await ok(await call('DELETE', `/companies/${co.id}`, T.alice));
    expect((await call('GET', `/companies/${co.id}`, T.alice)).status).toBe(404);
    expect((await call('DELETE', `/companies/${co.id}`, T.alice)).status).toBe(404);
    expect((await call('POST', '/companies', T.alice, { name: 'Acme SA' })).status).toBe(201); // el nombre quedó libre
    expect((await ok<Page<Company>>(await call('GET', '/companies', T.alice))).items.map((c) => c.name)).toEqual(['Acme SA', 'Otra']);
  });

  it('valida los datos: nombre obligatorio y acotado, teléfono en E.164, correo, sin campos desconocidos ni cambios vacíos', async () => {
    const bad = async (body: unknown, label: string) => expect((await call('POST', '/companies', T.alice, body)).status, label).toBe(400);
    await bad({}, 'sin nombre');
    await bad({ name: '   ' }, 'nombre en blanco');
    await bad({ name: 'x'.repeat(121) }, 'nombre largo');
    await bad({ name: 'Ok', phone: '0984217730' }, 'teléfono sin formato internacional');
    await bad({ name: 'Ok', email: 'no-es-correo' }, 'correo');
    await bad({ name: 'Ok', website: 'con espacios.test' }, 'sitio con espacios');
    await bad({ name: 'Ok', secreto: 1 }, 'campo desconocido');
    const co = await mkCompany(T.alice, 'Valida');
    expect((await call('PATCH', `/companies/${co.id}`, T.alice, {})).status).toBe(400);
    expect((await call('GET', '/companies?limit=0', T.alice)).status).toBe(400);
    expect((await call('GET', '/companies?cursor=basura', T.alice)).status).toBe(400);
  });

  it('lista por nombre con búsqueda y paginación por cursor', async () => {
    for (const n of ['Delta', 'alfa', 'Beta', 'Gamma', 'Epsilon']) await mkCompany(T.alice, n);
    const p1 = await ok<Page<Company>>(await call('GET', '/companies?limit=2', T.alice));
    expect(p1.items.map((c) => c.name)).toEqual(['alfa', 'Beta']);
    const p2 = await ok<Page<Company>>(await call('GET', `/companies?limit=2&cursor=${p1.next_cursor}`, T.alice));
    expect(p2.items.map((c) => c.name)).toEqual(['Delta', 'Epsilon']);
    const p3 = await ok<Page<Company>>(await call('GET', `/companies?limit=2&cursor=${p2.next_cursor}`, T.alice));
    expect(p3.items.map((c) => c.name)).toEqual(['Gamma']);
    expect(p3.next_cursor).toBeNull();
    expect((await ok<Page<Company>>(await call('GET', '/companies?q=ta', T.alice))).items.map((c) => c.name)).toEqual(['Beta', 'Delta']);
    expect((await ok<Page<Company>>(await call('GET', '/companies?q=%25', T.alice))).items).toEqual([]); // el comodín se toma literal
  });

  it('auditoría: alta, cambios por campo y borrado quedan registrados', async () => {
    const co = await mkCompany(T.alice, 'Auditada');
    await call('PATCH', `/companies/${co.id}`, T.alice, { name: 'Auditada 2', website: 'a.test' });
    await call('DELETE', `/companies/${co.id}`, T.alice);
    const a = await audits('company', co.id);
    expect(a.map((x) => x.field)).toEqual([null, 'name', 'website', 'deleted']);
    expect(a[1]).toMatchObject({ old_value: 'Auditada', new_value: 'Auditada 2' });
  });
});

describe('vínculos contacto ↔ empresa', () => {
  it('vincula y desvincula desde la empresa y desde la ficha; la ficha lista sus empresas; vincular dos veces es inocuo', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    const beto = await mkContact(T.alice, 'Beto', '+593991112233');
    expect(await ok(await call('POST', `/companies/${co.id}/contacts`, T.alice, { contact_ids: [ana.id, beto.id] }))).toEqual({ added: 2, skipped: 0 });
    expect(await ok(await call('POST', `/companies/${co.id}/contacts`, T.alice, { contact_ids: [ana.id] }))).toEqual({ added: 0, skipped: 1 });
    expect((await getContact(T.alice, ana.id)).companies).toEqual([{ id: co.id, name: 'Acme' }]);
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.alice))).contact_count).toBe(2);
    const members = await ok<Page<{ id: string; name: string; email: string | null; phone: string | null }>>(await call('GET', `/companies/${co.id}/contacts`, T.alice));
    expect(members.items.map((c) => [c.name, c.phone])).toEqual([['Ana', '+593984217730'], ['Beto', '+593991112233']]);

    expect(await ok(await call('DELETE', `/contacts/${beto.id}/companies/${co.id}`, T.alice))).toEqual({ unlinked: true });
    expect(await ok(await call('POST', `/companies/${co.id}/contacts/remove`, T.alice, { contact_ids: [ana.id, beto.id] }))).toEqual({ removed: 1 });
    expect(await ok(await call('POST', `/contacts/${ana.id}/companies/${co.id}`, T.alice))).toEqual({ linked: true });
    expect(await ok(await call('POST', `/contacts/${ana.id}/companies/${co.id}`, T.alice))).toEqual({ linked: true });
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.alice))).contact_count).toBe(1);
    const a = await audits('company', co.id);
    expect(a.map((x) => x.field)).toEqual([null, 'contacts_linked', 'contacts_unlinked', 'contacts_unlinked', 'contacts_linked']);
    // el vínculo de la ficha también queda en la auditoría del contacto
    expect((await audits('contact', ana.id)).map((x) => x.field)).toContain('company_linked');
  });

  it('el asesor no vincula, y de cada empresa ve solo los contactos que su alcance permite; el total es el que ÉL puede ver', async () => {
    const co = await mkCompany(T.alice, 'Compartida');
    const mine = await mkContact(T.carol, 'De Carolina', '+593984217730');
    const hers = await mkContact(T.erin, 'De Erika', '+593991112233');
    const adminOwned = await mkContact(T.alice, 'Sin asignar', '+593987654321');
    expect((await call('POST', `/companies/${co.id}/contacts`, T.carol, { contact_ids: [mine.id] })).status).toBe(403);
    await ok(await call('POST', `/companies/${co.id}/contacts`, T.alice, { contact_ids: [mine.id, hers.id, adminOwned.id] }));
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.alice))).contact_count).toBe(3);
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.carol))).contact_count).toBe(1);
    expect((await ok<Page<{ name: string }>>(await call('GET', `/companies/${co.id}/contacts`, T.carol))).items.map((c) => c.name)).toEqual(['De Carolina']);
    expect((await ok<Page<{ name: string }>>(await call('GET', `/companies/${co.id}/contacts`, T.alice))).items.map((c) => c.name)).toEqual(['De Carolina', 'De Erika', 'Sin asignar']);
    // la ficha del contacto ajeno y sus empresas: 404 uniforme para el asesor; el administrador sí
    expect((await call('GET', `/contacts/${hers.id}`, T.carol)).status).toBe(404);
    expect((await getContact(T.carol, mine.id)).companies.map((c) => c.name)).toEqual(['Compartida']);
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.alice))).contact_count).toBe(3);
  });

  it('un contacto pertenece a 5 empresas como máximo (409 desde la ficha; en lote se informa como omitido); las empresas borradas no cuentan ni se muestran', async () => {
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    const cos: Company[] = [];
    for (let i = 1; i <= 6; i++) cos.push(await mkCompany(T.alice, `Empresa ${i}`));
    for (const c of cos.slice(0, 5)) await ok(await call('POST', `/contacts/${ana.id}/companies/${c.id}`, T.alice));
    const over = await call('POST', `/contacts/${ana.id}/companies/${cos[5]!.id}`, T.alice);
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('COMPANY_LIMIT');
    expect(await ok(await call('POST', `/companies/${cos[5]!.id}/contacts`, T.alice, { contact_ids: [ana.id] }))).toEqual({ added: 0, skipped: 1 });
    await call('DELETE', `/companies/${cos[0]!.id}`, T.alice);
    expect((await getContact(T.alice, ana.id)).companies.map((c) => c.name)).toEqual(['Empresa 2', 'Empresa 3', 'Empresa 4', 'Empresa 5']);
    expect((await call('POST', `/contacts/${ana.id}/companies/${cos[5]!.id}`, T.alice)).status).toBe(200); // la borrada ya no cuenta
  });

  it('filtro por empresa (M10.2): GET /contacts?company= devuelve solo sus contactos, respeta el alcance del asesor, se combina con otros filtros, entra en listas dinámicas y exportación, y una empresa ajena no da nada', async () => {
    const acme = await mkCompany(T.alice, 'Acme');
    const otra = await mkCompany(T.alice, 'Otra');
    const mine = await mkContact(T.carol, 'Ana de Carolina', '+593984217730');
    const hers = await mkContact(T.erin, 'Beto de Erika', '+593991112233');
    const free = await mkContact(T.alice, 'Cata sin dueño', '+593987654321');
    await ok(await call('POST', `/companies/${acme.id}/contacts`, T.alice, { contact_ids: [mine.id, hers.id] }));
    await ok(await call('POST', `/companies/${otra.id}/contacts`, T.alice, { contact_ids: [free.id] }));
    const names = async (t: string, qs: string): Promise<string[]> => (await ok<Page<{ name: string }>>(await call('GET', `/contacts?${qs}`, t))).items.map((c) => c.name).sort();
    expect(await names(T.alice, `company=${acme.id}`)).toEqual(['Ana de Carolina', 'Beto de Erika']);
    expect(await names(T.alice, `company=${otra.id}`)).toEqual(['Cata sin dueño']);
    // el total que informa es el del filtro
    expect((await ok<Page<unknown>>(await call('GET', `/contacts?company=${acme.id}`, T.alice))).total).toBe(2);
    // el asesor ve solo los suyos aunque la empresa tenga más
    expect(await names(T.carol, `company=${acme.id}`)).toEqual(['Ana de Carolina']);
    expect(await names(T.carol, `company=${otra.id}`)).toEqual([]);
    // combinado con la búsqueda y con el responsable
    expect(await names(T.alice, `company=${acme.id}&q=beto`)).toEqual(['Beto de Erika']);
    expect(await names(T.alice, `company=${acme.id}&owner=${IDS.carol}`)).toEqual(['Ana de Carolina']);
    // una empresa borrada o que no existe no coincide con nadie; un identificador mal formado es un 400
    expect(await names(T.alice, `company=${NOBODY}`)).toEqual([]);
    expect((await call('GET', '/contacts?company=no-uuid', T.alice)).status).toBe(400);
    // desvincular saca al contacto del filtro
    await ok(await call('DELETE', `/contacts/${hers.id}/companies/${acme.id}`, T.alice));
    expect(await names(T.alice, `company=${acme.id}`)).toEqual(['Ana de Carolina']);
    // una lista dinámica guarda el filtro por empresa y se abre con él
    const list = await ok<{ id: string; filters: Record<string, unknown> }>(await call('POST', '/contact-lists', T.alice, { name: 'De Acme', kind: 'dynamic', filters: { company: acme.id } }), 201);
    expect(list.filters).toEqual({ company: acme.id });
    expect(await names(T.alice, `list=${list.id}`)).toEqual(['Ana de Carolina']);
    // la exportación del listado filtrado (alcance «view») lleva solo esos contactos y deja el filtro en la auditoría
    const exp = await call('POST', '/contacts/export', T.alice, { scope: 'view', company: acme.id });
    expect(exp.status).toBe(200);
    const csv = await exp.text();
    expect(csv).toContain('Ana de Carolina');
    expect(csv).not.toContain('Cata sin dueño');
    const log = (await admin.query("SELECT new_value FROM audit_logs WHERE entity_type = 'contact_export' ORDER BY id DESC LIMIT 1")).rows[0]?.new_value as { filters?: { company?: string | null } } | undefined;
    expect(log?.filters?.company).toBe(acme.id);
  });

  it('el filtro por empresa de otra organización no devuelve ni revela nada (A↔B)', async () => {
    const acme = await mkCompany(T.alice, 'Acme');
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    await ok(await call('POST', `/companies/${acme.id}/contacts`, T.alice, { contact_ids: [ana.id] }));
    await mkContact(T.bob, 'Contacto de B', '+593984217731');
    const r = await ok<Page<unknown>>(await call('GET', `/contacts?company=${acme.id}`, T.bob));
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('vincular exige que la empresa y el contacto existan; un contacto borrado desaparece de la empresa', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    expect((await call('POST', `/contacts/${ana.id}/companies/${NOBODY}`, T.alice)).status).toBe(404);
    expect((await call('POST', `/contacts/${NOBODY}/companies/${co.id}`, T.alice)).status).toBe(404);
    expect((await call('POST', `/companies/${NOBODY}/contacts`, T.alice, { contact_ids: [ana.id] })).status).toBe(404);
    expect((await call('POST', `/companies/${co.id}/contacts`, T.alice, { contact_ids: [] })).status).toBe(400);
    expect((await call('POST', `/companies/${co.id}/contacts`, T.alice, { contact_ids: [ana.id, ana.id] })).status).toBe(400);
    await call('POST', `/contacts/${ana.id}/companies/${co.id}`, T.alice);
    await call('DELETE', `/contacts/${ana.id}`, T.alice);
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.alice))).contact_count).toBe(0);
  });
});

describe('notas', () => {
  it('crea y lista notas de un contacto (la más reciente primero) con paginación; la nota lleva a su autor y qué puede hacer quien consulta', async () => {
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    for (const n of ['uno', 'dos', 'tres']) await ok(await call('POST', `/contacts/${ana.id}/notes`, T.alice, { body: n }), 201);
    const p1 = await ok<Page<Note>>(await call('GET', `/contacts/${ana.id}/notes?limit=2`, T.alice));
    expect(p1.items.map((n) => n.body)).toEqual(['tres', 'dos']);
    expect(p1.items[0]).toMatchObject({ author: { id: IDS.alice, name: 'Alicia Torres' }, edited_at: null, can_edit: true, can_delete: true });
    const p2 = await ok<Page<Note>>(await call('GET', `/contacts/${ana.id}/notes?limit=2&cursor=${p1.next_cursor}`, T.alice));
    expect(p2.items.map((n) => n.body)).toEqual(['uno']);
    expect(p2.next_cursor).toBeNull();
    expect((await call('GET', `/contacts/${ana.id}/notes?cursor=basura`, T.alice)).status).toBe(400);
  });

  it('valida el texto (1 a 5 000 caracteres, saltos de línea sí, caracteres de control no)', async () => {
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    const post = (body: unknown) => call('POST', `/contacts/${ana.id}/notes`, T.alice, body);
    expect((await post({ body: '' })).status).toBe(400);
    expect((await post({ body: '   ' })).status).toBe(400);
    expect((await post({ body: 'x'.repeat(5001) })).status).toBe(400);
    expect((await post({ body: 'a\u0000b' })).status).toBe(400);
    expect((await post({ body: 'x', extra: 1 })).status).toBe(400);
    expect((await ok<Note>(await post({ body: 'línea 1\nlínea 2\tcon tab' }), 201)).body).toBe('línea 1\nlínea 2\tcon tab');
    expect((await post({ body: 'x'.repeat(5000) })).status).toBe(201);
  });

  it('solo el autor edita (queda marcada «editada»); borra el autor o el administrador; el resto recibe 403', async () => {
    const mine = await mkContact(T.carol, 'De Carolina', '+593984217730');
    const note = await ok<Note>(await call('POST', `/contacts/${mine.id}/notes`, T.carol, { body: 'Prefiere por la tarde' }), 201);
    const asAdmin = await call('PATCH', `/notes/${note.id}`, T.alice, { body: 'Reescrita por el admin' });
    expect(asAdmin.status).toBe(403);
    expect(await code(asAdmin)).toBe('NOTE_NOT_YOURS');
    const edited = await ok<Note>(await call('PATCH', `/notes/${note.id}`, T.carol, { body: 'Prefiere por la mañana' }));
    expect(edited).toMatchObject({ body: 'Prefiere por la mañana', can_edit: true });
    expect(edited.edited_at).not.toBeNull();
    const seenByAdmin = (await ok<Page<Note>>(await call('GET', `/contacts/${mine.id}/notes`, T.alice))).items[0]!;
    expect(seenByAdmin).toMatchObject({ can_edit: false, can_delete: true });

    // la asesora de al lado no ve el contacto: 404 en todo
    expect((await call('GET', `/contacts/${mine.id}/notes`, T.erin)).status).toBe(404);
    expect((await call('POST', `/contacts/${mine.id}/notes`, T.erin, { body: 'intruso' })).status).toBe(404);
    expect((await call('PATCH', `/notes/${note.id}`, T.erin, { body: 'intruso' })).status).toBe(404);
    expect((await call('DELETE', `/notes/${note.id}`, T.erin)).status).toBe(404);

    // el administrador puede borrar una ajena; la asesora, solo la suya
    const other = await ok<Note>(await call('POST', `/contacts/${mine.id}/notes`, T.alice, { body: 'Nota del admin' }), 201);
    const denied = await call('DELETE', `/notes/${other.id}`, T.carol);
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('NOTE_NOT_YOURS');
    await ok(await call('DELETE', `/notes/${note.id}`, T.carol));
    await ok(await call('DELETE', `/notes/${other.id}`, T.alice));
    expect((await ok<Page<Note>>(await call('GET', `/contacts/${mine.id}/notes`, T.alice))).items).toEqual([]);
    expect((await call('DELETE', `/notes/${note.id}`, T.alice)).status).toBe(404);
  });

  it('notas de una empresa: las ve y crea cualquiera con acceso; desaparecen con la empresa', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    await ok(await call('POST', `/companies/${co.id}/notes`, T.carol, { body: 'Cuenta clave' }), 201);
    expect((await ok<Page<Note>>(await call('GET', `/companies/${co.id}/notes`, T.erin))).items.map((n) => n.body)).toEqual(['Cuenta clave']);
    await call('DELETE', `/companies/${co.id}`, T.alice);
    expect((await call('GET', `/companies/${co.id}/notes`, T.alice)).status).toBe(404);
    expect((await call('POST', `/companies/${co.id}/notes`, T.alice, { body: 'x' })).status).toBe(404);
  });

  it('la auditoría registra la nota sin copiar su texto', async () => {
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    const note = await ok<Note>(await call('POST', `/contacts/${ana.id}/notes`, T.alice, { body: 'Dato personal sensible' }), 201);
    await call('PATCH', `/notes/${note.id}`, T.alice, { body: 'Otro dato personal sensible, más largo' });
    await call('DELETE', `/notes/${note.id}`, T.alice);
    const a = await audits('note', note.id);
    expect(a.map((x) => x.field)).toEqual([null, 'body', 'deleted']);
    expect(a[0]!.new_value).toMatchObject({ contact_id: ana.id, length: 22 });
    expect(JSON.stringify(a)).not.toContain('personal sensible');
  });
});

describe('tareas', () => {
  it('crea una tarea para uno mismo por defecto; el administrador asigna a otra persona de la empresa; el asesor no asigna a otros', async () => {
    const mine = await mkTask(T.carol, { title: 'Llamar a Ana', due_at: inDays(1) });
    expect(mine).toMatchObject({ title: 'Llamar a Ana', status: 'open', assignee: { id: IDS.carol }, overdue: false, can_edit: true, can_complete: true });
    const given = await mkTask(T.alice, { title: 'Revisar leads', assignee_id: IDS.carol });
    expect(given).toMatchObject({ assignee: { id: IDS.carol, name: 'Carolina Vera' }, can_edit: true });
    const denied = await call('POST', '/tasks', T.carol, { title: 'Para Erika', assignee_id: IDS.erin });
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('TASK_ASSIGNEE_NOT_ALLOWED');
    expect((await call('POST', '/tasks', T.carol, { title: 'A mí', assignee_id: IDS.carol })).status).toBe(201);
    expect((await call('POST', '/tasks', T.alice, { title: 'De otra empresa', assignee_id: IDS.bob })).status).toBe(400);
    expect((await call('POST', '/tasks', T.alice, { title: 'Nadie', assignee_id: NOBODY })).status).toBe(400);
  });

  it('valida los datos: título, descripción, fecha ISO, un solo vínculo y campos desconocidos', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    const bad = async (body: unknown, label: string) => expect((await call('POST', '/tasks', T.alice, body)).status, label).toBe(400);
    await bad({}, 'sin título');
    await bad({ title: ' ' }, 'título en blanco');
    await bad({ title: 'x'.repeat(201) }, 'título largo');
    await bad({ title: 'ok', description: 'x'.repeat(2001) }, 'descripción larga');
    await bad({ title: 'ok', due_at: 'mañana' }, 'fecha');
    await bad({ title: 'ok', contact_id: ana.id, company_id: co.id }, 'contacto y empresa a la vez');
    await bad({ title: 'ok', otro: 1 }, 'campo desconocido');
    expect((await call('POST', '/tasks', T.alice, { title: 'ok', due_at: '2026-12-01T10:00:00-05:00' })).status).toBe(201);
    expect((await call('POST', '/tasks', T.alice, { title: 'con contacto inexistente', contact_id: NOBODY })).status).toBe(404);
    expect((await call('POST', '/tasks', T.alice, { title: 'con empresa inexistente', company_id: NOBODY })).status).toBe(404);
  });

  it('el asesor solo ve las suyas (asignadas a él o creadas por él); el administrador ve todas y puede filtrar por persona', async () => {
    await mkTask(T.carol, { title: 'De Carolina' });
    await mkTask(T.erin, { title: 'De Erika' });
    await mkTask(T.alice, { title: 'Del admin para Carolina', assignee_id: IDS.carol });
    await mkTask(T.alice, { title: 'Del admin' });
    const titles = async (t: string, q = '') => (await ok<Page<Task>>(await call('GET', `/tasks?sort=created${q}`, t))).items.map((x) => x.title).sort();
    expect(await titles(T.carol)).toEqual(['De Carolina', 'Del admin para Carolina']);
    expect(await titles(T.erin)).toEqual(['De Erika']);
    expect(await titles(T.alice)).toEqual(['Del admin']);
    expect(await titles(T.alice, '&assignee=all')).toEqual(['De Carolina', 'De Erika', 'Del admin', 'Del admin para Carolina']);
    expect(await titles(T.alice, `&assignee=${IDS.erin}`)).toEqual(['De Erika']);
    for (const q of ['assignee=all', `assignee=${IDS.erin}`]) {
      const r = await call('GET', `/tasks?${q}`, T.carol);
      expect(r.status, q).toBe(403);
      expect(await code(r)).toBe('TASK_SCOPE');
    }
    // una tarea ajena responde 404 igual que una inexistente
    const erika = (await ok<Page<Task>>(await call('GET', '/tasks', T.erin))).items[0]!;
    expect((await call('GET', `/tasks/${erika.id}`, T.carol)).status).toBe(404);
    expect((await call('GET', `/tasks/${erika.id}`, T.alice)).status).toBe(200);
  });

  it('filtra por estado, vencidas, contacto y empresa; ordena por vencimiento (las sin fecha al final) con paginación por cursor y total en la primera página', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    const late = await mkTask(T.alice, { title: 'Vencida', due_at: inDays(-2), contact_id: ana.id });
    await mkTask(T.alice, { title: 'Pronto', due_at: inDays(1), company_id: co.id });
    await mkTask(T.alice, { title: 'Después', due_at: inDays(5) });
    await mkTask(T.alice, { title: 'Sin fecha A' });
    await mkTask(T.alice, { title: 'Sin fecha B' });
    expect(late.overdue).toBe(true);

    const p1 = await ok<Page<Task>>(await call('GET', '/tasks?limit=2', T.alice));
    expect(p1.items.map((t) => t.title)).toEqual(['Vencida', 'Pronto']);
    expect(p1.total).toBe(5);
    const p2 = await ok<Page<Task>>(await call('GET', `/tasks?limit=2&cursor=${p1.next_cursor}`, T.alice));
    expect(p2.items.map((t) => t.title)).toEqual(['Después', 'Sin fecha A']);
    expect(p2.total).toBeNull();
    const p3 = await ok<Page<Task>>(await call('GET', `/tasks?limit=2&cursor=${p2.next_cursor}`, T.alice));
    expect(p3.items.map((t) => t.title)).toEqual(['Sin fecha B']);
    expect(p3.next_cursor).toBeNull();

    const created = await ok<Page<Task>>(await call('GET', '/tasks?sort=created&limit=2', T.alice));
    expect(created.items.map((t) => t.title)).toEqual(['Sin fecha B', 'Sin fecha A']);
    const created2 = await ok<Page<Task>>(await call('GET', `/tasks?sort=created&limit=2&cursor=${created.next_cursor}`, T.alice));
    expect(created2.items.map((t) => t.title)).toEqual(['Después', 'Pronto']);

    const only = async (q: string) => (await ok<Page<Task>>(await call('GET', `/tasks?${q}`, T.alice))).items.map((t) => t.title);
    expect(await only('overdue=true')).toEqual(['Vencida']);
    expect(await only(`contact=${ana.id}`)).toEqual(['Vencida']);
    expect(await only(`company=${co.id}`)).toEqual(['Pronto']);
    await call('POST', `/tasks/${late.id}/complete`, T.alice);
    expect(await only('overdue=true')).toEqual([]); // una hecha ya no está vencida
    expect(await only('status=done')).toEqual(['Vencida']);
    expect((await only('status=all')).length).toBe(5);
    expect((await call('GET', '/tasks?cursor=basura', T.alice)).status).toBe(400);
    expect((await call('GET', '/tasks?status=otra', T.alice)).status).toBe(400);
  });

  it('completar y reabrir: lo hace su responsable, quien la creó o el administrador; queda quién y cuándo', async () => {
    const t = await mkTask(T.alice, { title: 'Para Carolina', assignee_id: IDS.carol });
    const done = await ok<Task>(await call('POST', `/tasks/${t.id}/complete`, T.carol));
    expect(done).toMatchObject({ status: 'done', can_complete: true });
    expect(done.completed_at).not.toBeNull();
    expect((await admin.query('SELECT completed_by FROM tasks WHERE id = $1', [t.id])).rows[0].completed_by).toBe(IDS.carol);
    expect(await ok<Task>(await call('POST', `/tasks/${t.id}/complete`, T.carol))).toMatchObject({ status: 'done' }); // repetir es inocuo
    expect((await ok<Task>(await call('POST', `/tasks/${t.id}/reopen`, T.alice))).completed_at).toBeNull();
    expect((await admin.query('SELECT completed_by FROM tasks WHERE id = $1', [t.id])).rows[0].completed_by).toBeNull();
    // quien no la ve, 404
    expect((await call('POST', `/tasks/${t.id}/complete`, T.erin)).status).toBe(404);
    expect((await audits('task', t.id)).filter((a) => a.field === 'status').map((a) => a.new_value)).toEqual(['done', 'open']);
  });

  it('editar y borrar: quien la creó o el administrador; el responsable solo completa (403 con código)', async () => {
    const t = await mkTask(T.alice, { title: 'Del admin', assignee_id: IDS.carol, description: 'Detalle privado' });
    const noEdit = await call('PATCH', `/tasks/${t.id}`, T.carol, { title: 'Cambiada' });
    expect(noEdit.status).toBe(403);
    expect(await code(noEdit)).toBe('TASK_NOT_YOURS');
    expect((await call('DELETE', `/tasks/${t.id}`, T.carol)).status).toBe(403);
    expect((await ok<Task>(await call('GET', `/tasks/${t.id}`, T.carol))).can_edit).toBe(false);

    const own = await mkTask(T.carol, { title: 'Mía' });
    const edited = await ok<Task>(await call('PATCH', `/tasks/${own.id}`, T.carol, { title: 'Mía, cambiada', due_at: inDays(3), description: 'nueva' }));
    expect(edited).toMatchObject({ title: 'Mía, cambiada', description: 'nueva' });
    expect((await ok<Task>(await call('PATCH', `/tasks/${own.id}`, T.carol, { due_at: null, description: null }))).due_at).toBeNull();
    expect((await call('PATCH', `/tasks/${own.id}`, T.carol, {})).status).toBe(400);
    expect((await call('PATCH', `/tasks/${own.id}`, T.carol, { assignee_id: IDS.erin })).status).toBe(403);
    expect((await ok<Task>(await call('PATCH', `/tasks/${t.id}`, T.alice, { assignee_id: IDS.erin }))).assignee.id).toBe(IDS.erin);

    await ok(await call('DELETE', `/tasks/${own.id}`, T.carol));
    expect((await call('GET', `/tasks/${own.id}`, T.carol)).status).toBe(404);
    await ok(await call('DELETE', `/tasks/${t.id}`, T.alice));
    // la auditoría no copia la descripción
    expect(JSON.stringify(await audits('task'))).not.toContain('Detalle privado');
    expect(JSON.stringify(await audits('task'))).not.toContain('nueva');
  });

  it('vínculos: el asesor solo vincula contactos que ve; cambiar el vínculo quita el otro; una empresa o contacto borrados dejan de mostrarse', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    const mine = await mkContact(T.carol, 'De Carolina', '+593984217730');
    const hers = await mkContact(T.erin, 'De Erika', '+593991112233');
    expect((await call('POST', '/tasks', T.carol, { title: 'x', contact_id: hers.id })).status).toBe(404);
    const t = await mkTask(T.carol, { title: 'Llamar', contact_id: mine.id });
    expect(t.contact).toEqual({ id: mine.id, name: 'De Carolina' });
    const moved = await ok<Task>(await call('PATCH', `/tasks/${t.id}`, T.carol, { company_id: co.id }));
    expect(moved.contact).toBeNull();
    expect(moved.company).toEqual({ id: co.id, name: 'Acme' });
    expect((await call('PATCH', `/tasks/${t.id}`, T.carol, { contact_id: hers.id })).status).toBe(404);
    expect((await ok<Task>(await call('PATCH', `/tasks/${t.id}`, T.carol, { company_id: null }))).company).toBeNull();
    const again = await ok<Task>(await call('PATCH', `/tasks/${t.id}`, T.carol, { contact_id: mine.id }));
    expect(again.contact?.id).toBe(mine.id);
    await call('DELETE', `/contacts/${mine.id}`, T.alice);
    expect((await ok<Task>(await call('GET', `/tasks/${t.id}`, T.carol))).contact).toBeNull();
    expect((await call('PATCH', `/tasks/${t.id}`, T.carol, { contact_id: NOBODY, company_id: co.id })).status).toBe(400);
  });
});

describe('aislamiento A↔B', () => {
  it('B no ve ni cambia las empresas, notas y tareas de A (404); los nombres y los teléfonos se comparan por empresa; los ids de A no sirven en B', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    await call('POST', `/contacts/${ana.id}/companies/${co.id}`, T.alice);
    const note = await ok<Note>(await call('POST', `/contacts/${ana.id}/notes`, T.alice, { body: 'Nota de A' }), 201);
    const cnote = await ok<Note>(await call('POST', `/companies/${co.id}/notes`, T.alice, { body: 'Nota de empresa de A' }), 201);
    const task = await mkTask(T.alice, { title: 'Tarea de A', contact_id: ana.id });

    expect((await ok<Page<Company>>(await call('GET', '/companies', T.bob))).items).toEqual([]);
    expect((await ok<Page<Task>>(await call('GET', '/tasks?assignee=all', T.bob))).items).toEqual([]);
    for (const [m, p, b] of [
      ['GET', `/companies/${co.id}`], ['PATCH', `/companies/${co.id}`, { name: 'Robada' }], ['DELETE', `/companies/${co.id}`], ['GET', `/companies/${co.id}/contacts`], ['POST', `/companies/${co.id}/contacts`, { contact_ids: [ana.id] }],
      ['POST', `/companies/${co.id}/contacts/remove`, { contact_ids: [ana.id] }], ['GET', `/companies/${co.id}/notes`], ['POST', `/companies/${co.id}/notes`, { body: 'x' }], ['POST', `/contacts/${ana.id}/companies/${co.id}`], ['DELETE', `/contacts/${ana.id}/companies/${co.id}`],
      ['GET', `/contacts/${ana.id}/notes`], ['POST', `/contacts/${ana.id}/notes`, { body: 'x' }], ['PATCH', `/notes/${note.id}`, { body: 'x' }], ['DELETE', `/notes/${cnote.id}`],
      ['GET', `/tasks/${task.id}`], ['PATCH', `/tasks/${task.id}`, { title: 'Robada' }], ['POST', `/tasks/${task.id}/complete`], ['POST', `/tasks/${task.id}/reopen`], ['DELETE', `/tasks/${task.id}`],
    ] as const) {
      const r = await call(m, p, T.bob, b);
      expect([404], `${m} ${p}`).toContain(r.status);
    }
    // en lote no hay error: los ids ajenos simplemente no entran
    const bco = await mkCompany(T.bob, 'Acme'); // el mismo nombre en otra empresa es válido
    expect(await ok(await call('POST', `/companies/${bco.id}/contacts`, T.bob, { contact_ids: [ana.id] }))).toEqual({ added: 0, skipped: 1 });
    expect((await call('POST', '/tasks', T.bob, { title: 'x', contact_id: ana.id })).status).toBe(404);
    expect((await call('POST', '/tasks', T.bob, { title: 'x', company_id: co.id })).status).toBe(404);
    // nada de A cambió
    expect((await ok<Company>(await call('GET', `/companies/${co.id}`, T.alice))).name).toBe('Acme');
    expect((await ok<Task>(await call('GET', `/tasks/${task.id}`, T.alice))).title).toBe('Tarea de A');
    expect((await getContact(T.alice, ana.id)).companies).toHaveLength(1);
  });
});

describe('base de datos: privilegios y restricciones', () => {
  const as = async (url: string, sql: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  };

  it('app_rw no borra ni vacía (salvo desvincular en el pivote); platform e identity no ven las tablas', async () => {
    for (const t of ['companies', 'notes', 'tasks']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `DELETE ${t}`).rejects.toThrow(/permission denied/);
    }
    for (const t of ['companies', 'contact_companies', 'notes', 'tasks']) {
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await c.query('DELETE FROM contact_companies'); // permitido (0 filas)
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('las restricciones protegen la forma de los datos y las claves foráneas impiden cruzar empresas', async () => {
    const co = await mkCompany(T.alice, 'Acme');
    const ana = await mkContact(T.alice, 'Ana', '+593984217730');
    const bco = await mkCompany(T.bob, 'De B');
    const bad = (sql: string) => admin.query(sql);
    const ins = (table: string, cols: string, vals: string, org = ORG_A) => (table === 'contact_companies' ? `INSERT INTO ${table}(organization_id, ${cols}) VALUES ('${org}', ${vals})` : `INSERT INTO ${table}(organization_id, id, ${cols}) VALUES ('${org}', gen_random_uuid(), ${vals})`);
    await expect(bad(ins('companies', 'name', `'  '`))).rejects.toThrow(/companies_name_shape/);
    await expect(bad(ins('companies', 'name, phone', `'X', '0984217730'`))).rejects.toThrow(/companies_phone_e164/);
    await expect(bad(ins('companies', 'name', `'acme'`))).rejects.toThrow(/companies_org_name_uq/);
    await expect(bad(ins('contact_companies', 'contact_id, company_id', `'${ana.id}', '${bco.id}'`))).rejects.toThrow(/contact_companies_company_fk/); // empresa de otra organización
    await expect(bad(ins('notes', 'body, author_id', `'x', '${IDS.alice}'`))).rejects.toThrow(/notes_target_one/); // sin destino
    await expect(bad(ins('notes', 'contact_id, company_id, body, author_id', `'${ana.id}', '${co.id}', 'x', '${IDS.alice}'`))).rejects.toThrow(/notes_target_one/); // dos destinos
    await expect(bad(ins('notes', 'contact_id, body, author_id', `'${ana.id}', '   ', '${IDS.alice}'`))).rejects.toThrow(/notes_body_len/);
    await expect(bad(ins('notes', 'company_id, body, author_id', `'${bco.id}', 'x', '${IDS.alice}'`))).rejects.toThrow(/notes_company_fk/);
    await expect(bad(ins('tasks', 'title, assignee_id, created_by, status', `'T', '${IDS.alice}', '${IDS.alice}', 'rara'`))).rejects.toThrow(/tasks_status_valid/);
    await expect(bad(ins('tasks', 'title, assignee_id, created_by, status', `'T', '${IDS.alice}', '${IDS.alice}', 'done'`))).rejects.toThrow(/tasks_completion_consistent/);
    await expect(bad(ins('tasks', 'title, assignee_id, created_by, completed_at', `'T', '${IDS.alice}', '${IDS.alice}', now()`))).rejects.toThrow(/tasks_completion_consistent/);
    await expect(bad(ins('tasks', 'title, assignee_id, created_by, contact_id, company_id', `'T', '${IDS.alice}', '${IDS.alice}', '${ana.id}', '${co.id}'`))).rejects.toThrow(/tasks_one_target/);
    await expect(bad(ins('tasks', 'title, assignee_id, created_by', `'${'x'.repeat(201)}', '${IDS.alice}', '${IDS.alice}'`))).rejects.toThrow(/tasks_title_len/);
    await expect(bad(ins('tasks', 'title, assignee_id, created_by, contact_id', `'T', '${IDS.alice}', '${IDS.alice}', '${ana.id}'`, ORG_B))).rejects.toThrow(/tasks_contact_fk/);
  });

  it('la RLS: sin organización activa app_rw no ve nada; con la de A no ve lo de B', async () => {
    await mkCompany(T.alice, 'De A');
    await mkCompany(T.bob, 'De B');
    await mkTask(T.alice, { title: 'T de A' });
    await mkTask(T.bob, { title: 'T de B' });
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const t of ['companies', 'tasks']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      for (const t of ['companies', 'tasks']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(1);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
