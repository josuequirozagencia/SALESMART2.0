// M3.1 — Contactos (ADR-32 #2/#3, ADR-43). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione y que haya prueba A↔B):
//   GET /v1/contacts · GET /v1/contacts/owners · GET /v1/contacts/:id · POST /v1/contacts · PATCH /v1/contacts/:id · DELETE /v1/contacts/:id
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
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  carlos: 'c0000000-0000-4000-8000-0000000000c4', // asesor de A
  gone: 'c0000000-0000-4000-8000-0000000000c5', // ex asesor de A (membresía revocada)
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  bea: 'b0000000-0000-4000-8000-0000000000b2', // asesora de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const P1 = '+593984217730';
const P2 = '+593991112233';
const P3 = '+34612345678';

interface View { id: string; name: string; email: string | null; phones: Array<{ e164: string; primary: boolean }>; owner: { id: string; name: string } | null; source: string; consent: string; consent_updated_at: string | null; created_at: string; updated_at: string }
interface Page { items: View[]; next_cursor: string | null; total: number | null }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.carlos, 'carlos@a.test', 'Carlos Mena'], [IDS.gone, 'gone@a.test', 'Gonzalo Paz'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.bea, 'bea@b.test', 'Bea Ríos'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.carlos, ORG_A, 'advisor', null], [IDS.gone, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.bea, ORG_B, 'advisor', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
  for (const [u, o, r, lv] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, lv]);
  await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1`, [IDS.gone]);
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
let T: Record<'alice' | 'carol' | 'carlos' | 'bob' | 'bea' | 'dave' | 'root', string>;
const create = (t: string, body: unknown) => call('POST', '/contacts', t, body);
const make = async (t: string, body: unknown): Promise<View> => {
  const r = await create(t, body);
  expect(r.status, JSON.stringify(body)).toBe(201);
  return json<View>(r);
};
const list = async (t: string, qs = ''): Promise<Page> => {
  const r = await call('GET', `/contacts${qs}`, t);
  expect(r.status, qs).toBe(200);
  return json<Page>(r);
};
const names = (p: Page): string[] => p.items.map((i) => i.name);
const audits = async (entityId?: string) => (await admin.query(`SELECT entity_type, entity_id, field, old_value, new_value, actor_user_id, acting_as, acting_org_id, organization_id, source FROM audit_logs WHERE entity_type = 'contact' ${entityId ? 'AND entity_id = $1' : ''} ORDER BY at, id`, entityId ? [entityId] : [])).rows as Array<{ field: string | null; old_value: unknown; new_value: unknown; actor_user_id: string; acting_as: string | null; acting_org_id: string | null; organization_id: string }>;

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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), carlos: await login('carlos@a.test'), bob: await login('bob@b.test'), bea: await login('bea@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('acceso', () => {
  it('sin sesión 401 en todas las rutas; la plataforma (sin empresa) 403', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const routes: Array<[string, string, unknown?]> = [['GET', '/contacts'], ['GET', '/contacts/owners'], ['GET', `/contacts/${id}`], ['POST', '/contacts', { name: 'X' }], ['PATCH', `/contacts/${id}`, { name: 'X' }], ['DELETE', `/contacts/${id}`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('el asesor puede leer y escribir, pero NO borrar ni ver las personas asignables; el administrador sí todo', async () => {
    const c = await make(T.alice, { name: 'Contacto Uno' });
    expect((await call('DELETE', `/contacts/${c.id}`, T.carol)).status).toBe(403);
    expect((await call('GET', '/contacts/owners', T.carol)).status).toBe(403);
    expect((await call('GET', '/contacts/owners', T.alice)).status).toBe(200);
    expect((await call('DELETE', `/contacts/${c.id}`, T.alice)).status).toBe(200);
  });

  it('el listado informa qué puede hacer quien consulta (ayuda para la UI): administrador todo, asesor solo lo suyo, la agencia en «lectura» solo ve', async () => {
    const access = async (t: string) => (await json<Page & { access: { view_all: boolean; write: boolean; delete: boolean } }>(await call('GET', '/contacts', t))).access;
    expect(await access(T.alice)).toEqual({ view_all: true, write: true, delete: true });
    expect(await access(T.carol)).toEqual({ view_all: false, write: true, delete: false });
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    expect(await access(T.dave)).toEqual({ view_all: true, write: true, delete: true });
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect(await access(T.dave)).toEqual({ view_all: true, write: false, delete: false });
  });

  it('una id mal formada es 400 y una inexistente 404', async () => {
    expect((await call('GET', '/contacts/no-es-uuid', T.alice)).status).toBe(400);
    expect((await call('GET', '/contacts/00000000-0000-4000-8000-000000000001', T.alice)).status).toBe(404);
  });
});

describe('aislamiento A↔B (otra empresa)', () => {
  it('B no ve, lee, edita ni borra nada de A (404) y la lista de B no trae filas de A; con A pasa lo mismo al revés', async () => {
    const a = await make(T.alice, { name: 'Ana de A', phones: [P1], email: 'ana@a.test' });
    const b = await make(T.bob, { name: 'Beto de B', phones: [P2] });
    expect(names(await list(T.bob))).toEqual(['Beto de B']);
    expect(names(await list(T.alice))).toEqual(['Ana de A']);
    expect((await list(T.bob)).total).toBe(1);
    for (const [m, body] of [['GET', undefined], ['PATCH', { name: 'Hackeado' }], ['DELETE', undefined]] as const) {
      expect((await call(m, `/contacts/${a.id}`, T.bob, body)).status, `B ${m} contacto de A`).toBe(404);
      expect((await call(m, `/contacts/${b.id}`, T.alice, body)).status, `A ${m} contacto de B`).toBe(404);
    }
    expect((await call('GET', `/contacts/${a.id}`, T.alice)).status).toBe(200);
    expect((await call('GET', `/contacts?q=ana`, T.bob)).status).toBe(200);
    expect(names(await list(T.bob, '?q=ana'))).toEqual([]); // la búsqueda tampoco cruza empresas
    expect((await admin.query(`SELECT name FROM contacts WHERE id = $1`, [a.id])).rows[0].name).toBe('Ana de A'); // nada cambió
  });

  it('el mismo teléfono puede existir en dos empresas (la unicidad es por empresa) y B no puede forjar la empresa', async () => {
    await make(T.alice, { name: 'Ana de A', phones: [P1] });
    const b = await make(T.bob, { name: 'Ana en B', phones: [P1] });
    expect(b.phones).toEqual([{ e164: P1, primary: true }]);
    for (const extra of [{ organization_id: ORG_A }, { org_id: ORG_A }, { source: 'import' }, { created_by: IDS.alice }, { deleted_at: '2020-01-01' }]) {
      expect((await create(T.bob, { name: 'Intruso', ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
  });

  it('un asesor de B no ve contactos de A ni siendo «dueño» de otro: sus listas son de su empresa', async () => {
    await make(T.alice, { name: 'Ana de A' });
    await make(T.bea, { name: 'De Bea' });
    expect(names(await list(T.bea))).toEqual(['De Bea']);
    const forged = await call('GET', `/contacts?owner=${IDS.carol}`, T.bob); // filtro por un dueño de A
    expect(((await forged.json()) as Page).items).toEqual([]);
  });
});

describe('alcance propio del asesor (ADR-32)', () => {
  it('crea contactos asignados a sí mismo; mandar otro dueño es 403; cada asesor ve solo los suyos y el administrador todos', async () => {
    const mine = await make(T.carol, { name: 'De Carolina', phones: [P1] });
    expect(mine.owner).toEqual({ id: IDS.carol, name: 'Carolina Vera' });
    expect(mine.source).toBe('manual');
    const r = await create(T.carol, { name: 'Para Carlos', owner_id: IDS.carlos });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('OWNER_NOT_ALLOWED');
    expect((await create(T.carol, { name: 'Para mí', owner_id: IDS.carol })).status).toBe(201);
    await make(T.carlos, { name: 'De Carlos' });
    await make(T.alice, { name: 'Sin dueño' });

    expect(names(await list(T.carol, '?sort=name&order=asc'))).toEqual(['De Carolina', 'Para mí']);
    expect(names(await list(T.carlos))).toEqual(['De Carlos']);
    const all = await list(T.alice, '?sort=name&order=asc');
    expect(names(all)).toEqual(['De Carlos', 'De Carolina', 'Para mí', 'Sin dueño']);
    expect(all.total).toBe(4);
  });

  it('un contacto ajeno es un 404 uniforme para el asesor (leer, editar), igual que uno inexistente; no puede cambiar el dueño', async () => {
    const theirs = await make(T.carlos, { name: 'De Carlos' });
    const unassigned = await make(T.alice, { name: 'Sin dueño' });
    for (const id of [theirs.id, unassigned.id]) {
      expect((await call('GET', `/contacts/${id}`, T.carol)).status).toBe(404);
      expect((await call('PATCH', `/contacts/${id}`, T.carol, { name: 'Mío ahora' })).status).toBe(404);
    }
    const shape = async (r: Response) => { const e = (await r.json() as { error: { code: string; message: string } }).error; return [r.status, e.code, e.message]; };
    const missing = await call('GET', '/contacts/00000000-0000-4000-8000-000000000001', T.carol);
    const foreign = await call('GET', `/contacts/${theirs.id}`, T.carol);
    expect(await shape(foreign)).toEqual(await shape(missing)); // ajeno e inexistente son indistinguibles
    const mine = await make(T.carol, { name: 'De Carolina' });
    const r = await call('PATCH', `/contacts/${mine.id}`, T.carol, { owner_id: IDS.carlos });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('OWNER_NOT_ALLOWED');
    expect((await call('PATCH', `/contacts/${mine.id}`, T.carol, { name: 'De Carolina (editado)' })).status).toBe(200);
  });

  it('el filtro por dueño solo existe con contacts.view_all: el asesor no puede ampliarse el alcance con él', async () => {
    await make(T.carlos, { name: 'De Carlos' });
    await make(T.carol, { name: 'De Carolina' });
    expect(names(await list(T.carol, `?owner=${IDS.carlos}`))).toEqual(['De Carolina']);
    expect(names(await list(T.carol, '?owner=none'))).toEqual(['De Carolina']);
    expect(names(await list(T.alice, `?owner=${IDS.carlos}`))).toEqual(['De Carlos']);
    expect(names(await list(T.alice, '?owner=me'))).toEqual([]);
  });

  it('el administrador asigna y reasigna solo a personas que pueden recibir contactos (no a otra empresa, ex miembros ni agencias)', async () => {
    const c = await make(T.alice, { name: 'Sin dueño' });
    expect(c.owner).toBeNull();
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { owner_id: IDS.carol })).status).toBe(200);
    expect((await call('GET', `/contacts/${c.id}`, T.carol)).status).toBe(200); // ahora es suyo
    for (const owner of [IDS.bob, IDS.gone, IDS.dave, IDS.root, '00000000-0000-4000-8000-000000000001']) {
      const r = await call('PATCH', `/contacts/${c.id}`, T.alice, { owner_id: owner });
      expect(r.status, owner).toBe(400);
      expect(((await r.json()) as { error: { details: Array<{ path: string; code: string }> } }).error.details[0]).toMatchObject({ path: 'owner_id', code: 'invalid_owner' });
    }
    expect((await create(T.alice, { name: 'X', owner_id: IDS.bob })).status).toBe(400);
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { owner_id: null })).status).toBe(200);
    expect((await call('GET', `/contacts/${c.id}`, T.carol)).status).toBe(404); // dejó de ser suyo
  });

  it('las personas asignables son los administradores y asesores VIGENTES de SU empresa', async () => {
    const r = await json<{ items: Array<{ id: string; name: string; role: string }> }>(await call('GET', '/contacts/owners', T.alice));
    expect(r.items.map((i) => i.name).sort()).toEqual(['Alicia Torres', 'Carlos Mena', 'Carolina Vera']);
    expect(r.items.find((i) => i.name === 'Alicia Torres')?.role).toBe('client_admin');
    const b = await json<{ items: Array<{ name: string }> }>(await call('GET', '/contacts/owners', T.bob));
    expect(b.items.map((i) => i.name).sort()).toEqual(['Beto Luna', 'Bea Ríos'].sort());
  });
});

describe('altas y ediciones', () => {
  it('crea con teléfonos (el primero es el principal), correo en minúsculas y consentimiento; queda auditado', async () => {
    const c = await make(T.alice, { name: '  Ana Pérez  ', email: 'ANA@Correo.TEST', phones: [P1, P2], consent: 'granted' });
    expect(c).toMatchObject({ name: 'Ana Pérez', email: 'ana@correo.test', source: 'manual', consent: 'granted', phones: [{ e164: P1, primary: true }, { e164: P2, primary: false }], owner: null });
    expect(c.consent_updated_at).not.toBeNull();
    const a = await audits(c.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ field: null, actor_user_id: IDS.alice, acting_as: null, organization_id: ORG_A, new_value: { name: 'Ana Pérez', email: 'ana@correo.test', consent: 'granted', phones: [P1, P2], source: 'manual' } });
  });

  it('validación: nombre, correo, teléfonos, consentimiento y campos extra → 400 sin tocar nada', async () => {
    const bad: Array<[string, unknown]> = [
      ['sin nombre', {}],
      ['nombre vacío', { name: '   ' }],
      ['nombre largo', { name: 'x'.repeat(201) }],
      ['nombre con control', { name: 'a\u0007b' }],
      ['correo inválido', { name: 'X', email: 'no-es-correo' }],
      ['teléfono sin +', { name: 'X', phones: ['0984217730'] }],
      ['teléfono corto', { name: 'X', phones: ['+5939'] }],
      ['teléfono largo', { name: 'X', phones: ['+5939842177301234567'] }],
      ['6 teléfonos', { name: 'X', phones: ['+34600000001', '+34600000002', '+34600000003', '+34600000004', '+34600000005', '+34600000006'] }],
      ['teléfonos repetidos', { name: 'X', phones: [P1, P1] }],
      ['consentimiento', { name: 'X', consent: 'si' }],
      ['dueño no UUID', { name: 'X', owner_id: 'juan' }],
    ];
    for (const [name, body] of bad) expect((await create(T.alice, body)).status, name).toBe(400);
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts`)).rows[0].n).toBe(0);
  });

  it('edita por partes: solo cambia lo enviado, deja un registro por campo con su valor anterior y nuevo, y un cambio vacío no deja rastro', async () => {
    const c = await make(T.alice, { name: 'Ana', email: 'ana@a.test', phones: [P1] });
    const r = await call('PATCH', `/contacts/${c.id}`, T.alice, { name: 'Ana María', email: null, consent: 'revoked' });
    expect(r.status).toBe(200);
    const v = await json<View>(r);
    expect(v).toMatchObject({ name: 'Ana María', email: null, consent: 'revoked', phones: [{ e164: P1, primary: true }] });
    expect(new Date(v.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(c.updated_at).getTime());
    const a = (await audits(c.id)).slice(1);
    // Las filas de una misma transacción comparten `at` y su desempate por id no es el orden de escritura: se compara sin depender del orden
    const byField = (x: { field: string | null }, y: { field: string | null }): number => (x.field ?? '').localeCompare(y.field ?? '');
    expect([...a].sort(byField).map((x) => [x.field, x.old_value, x.new_value])).toEqual([['consent', 'unknown', 'revoked'], ['email', 'ana@a.test', null], ['name', 'Ana', 'Ana María']]);

    const before = (await audits(c.id)).length;
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { name: 'Ana María', phones: [P1] })).status).toBe(200); // sin cambios reales
    expect((await audits(c.id)).length).toBe(before);
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, {})).status).toBe(400);
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { source: 'import' })).status).toBe(400);
  });

  it('los teléfonos se reemplazan como lista: se quitan, se agregan y el principal cambia sin chocar con el índice de «un solo principal»', async () => {
    const c = await make(T.alice, { name: 'Ana', phones: [P1, P2] });
    let v = await json<View>(await call('PATCH', `/contacts/${c.id}`, T.alice, { phones: [P2, P3] }));
    expect(v.phones).toEqual([{ e164: P2, primary: true }, { e164: P3, primary: false }]);
    v = await json<View>(await call('PATCH', `/contacts/${c.id}`, T.alice, { phones: [P3, P2] }));
    expect(v.phones).toEqual([{ e164: P3, primary: true }, { e164: P2, primary: false }]);
    v = await json<View>(await call('PATCH', `/contacts/${c.id}`, T.alice, { phones: [] }));
    expect(v.phones).toEqual([]);
    const rows = (await admin.query(`SELECT e164, is_primary, deleted_at IS NOT NULL AS gone FROM contact_phones WHERE contact_id = $1 ORDER BY created_at, e164`, [c.id])).rows;
    expect(rows.filter((r) => !r.gone)).toEqual([]);
    expect((await audits(c.id)).filter((x) => x.field === 'phones').map((x) => x.new_value)).toEqual([[P2, P3], [P3, P2], []]);
  });

  it('el teléfono es único por empresa entre contactos vigentes: 409 con la posición del repetido, al crear y al editar', async () => {
    const a = await make(T.alice, { name: 'Ana', phones: [P1] });
    const r = await create(T.alice, { name: 'Otra Ana', phones: [P2, P1] });
    expect(r.status).toBe(409);
    expect(await code(r.clone())).toBe('PHONE_TAKEN');
    expect(((await r.json()) as { error: { details: Array<{ path: string }> } }).error.details).toEqual([{ path: 'phones.1', code: 'duplicate', message: 'Ya existe un contacto con este teléfono' }]);
    const b = await make(T.alice, { name: 'Beto', phones: [P2] });
    const e = await call('PATCH', `/contacts/${b.id}`, T.alice, { phones: [P2, P1] });
    expect(e.status).toBe(409);
    expect((await call('PATCH', `/contacts/${a.id}`, T.alice, { phones: [P1, P3] })).status).toBe(200); // conservar el propio no choca
    expect(names(await list(T.alice, '?sort=name&order=asc'))).toEqual(['Ana', 'Beto']);
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts`)).rows[0].n).toBe(2); // el rechazado no dejó medio contacto
  });

  it('dos altas simultáneas del mismo número: una gana, las demás 409, sin contactos a medias', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => create(T.alice, { name: `Carrera ${i}`, phones: [P1] })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts`)).rows[0].n).toBe(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM contact_phones WHERE deleted_at IS NULL`)).rows[0].n).toBe(1);
  });

  it('el asesor edita sus contactos con sus propias reglas de teléfono y no toca los ajenos', async () => {
    const mine = await make(T.carol, { name: 'De Carolina', phones: [P1] });
    const v = await json<View>(await call('PATCH', `/contacts/${mine.id}`, T.carol, { name: 'De Carolina V.', phones: [P1, P2] }));
    expect(v.phones.map((p) => p.e164)).toEqual([P1, P2]);
    const clash = await make(T.carlos, { name: 'De Carlos', phones: [P3] });
    expect(clash.owner?.id).toBe(IDS.carlos);
    const r = await call('PATCH', `/contacts/${mine.id}`, T.carol, { phones: [P3] }); // el número existe en un contacto que ella no ve
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain(clash.id); // y no se le revela cuál
  });
});

describe('borrado lógico', () => {
  it('borra (solo con permiso), conserva los datos marcados, libera los teléfonos y lo deja auditado; borrar de nuevo es 404', async () => {
    const c = await make(T.alice, { name: 'Ana', phones: [P1] });
    expect(await json(await call('DELETE', `/contacts/${c.id}`, T.alice))).toEqual({ id: c.id, deleted: true });
    expect((await call('GET', `/contacts/${c.id}`, T.alice)).status).toBe(404);
    expect((await call('DELETE', `/contacts/${c.id}`, T.alice)).status).toBe(404);
    expect(names(await list(T.alice))).toEqual([]);
    expect((await list(T.alice)).total).toBe(0);
    const row = (await admin.query(`SELECT deleted_at IS NOT NULL AS gone, name FROM contacts WHERE id = $1`, [c.id])).rows[0];
    expect(row).toEqual({ gone: true, name: 'Ana' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM contact_phones WHERE contact_id = $1 AND deleted_at IS NULL`, [c.id])).rows[0].n).toBe(0);
    expect(await make(T.alice, { name: 'Ana otra vez', phones: [P1] })).toMatchObject({ phones: [{ e164: P1, primary: true }] }); // el número volvió a estar libre
    const a = (await audits(c.id)).at(-1)!;
    expect(a).toMatchObject({ field: null, new_value: null, old_value: { name: 'Ana', phones: [P1] } });
  });

  it('un contacto borrado no se puede editar y no cuenta en búsquedas ni totales', async () => {
    const c = await make(T.alice, { name: 'Fantasma' });
    await call('DELETE', `/contacts/${c.id}`, T.alice);
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { name: 'Revivido' })).status).toBe(404);
    expect(names(await list(T.alice, '?q=fantasma'))).toEqual([]);
  });
});

describe('listado: búsqueda, orden y páginas', () => {
  beforeEach(async () => {
    for (const [n, e, p] of [['Ana Torres', 'ana@a.test', P1], ['Beatriz Mena', 'bea@mena.test', P2], ['Carlos 100%', null, P3], ['ana maría', null, null]] as const) {
      await make(T.alice, { name: n, ...(e ? { email: e } : {}), ...(p ? { phones: [p] } : {}) });
    }
  });

  it('busca por nombre (sin distinguir mayúsculas), correo y dígitos del teléfono; el % se busca literal', async () => {
    expect(names(await list(T.alice, '?q=ANA&sort=name&order=asc'))).toEqual(['ana maría', 'Ana Torres']);
    expect(names(await list(T.alice, '?q=mena.test'))).toEqual(['Beatriz Mena']);
    expect(names(await list(T.alice, '?q=991112'))).toEqual(['Beatriz Mena']);
    expect(names(await list(T.alice, '?q=%2B34%20612'))).toEqual(['Carlos 100%']);
    expect(names(await list(T.alice, '?q=100%25'))).toEqual(['Carlos 100%']);
    expect(names(await list(T.alice, '?q=%25'))).toEqual(['Carlos 100%']); // «%» solo coincide con el nombre que lo trae
    expect(names(await list(T.alice, '?q=_'))).toEqual([]);
    expect((await list(T.alice, '?q=zzz')).total).toBe(0);
  });

  it('ordena por nombre o fechas, ascendente o descendente', async () => {
    expect(names(await list(T.alice, '?sort=name&order=asc'))).toEqual(['ana maría', 'Ana Torres', 'Beatriz Mena', 'Carlos 100%']);
    expect(names(await list(T.alice, '?sort=name&order=desc'))).toEqual(['Carlos 100%', 'Beatriz Mena', 'Ana Torres', 'ana maría']);
    expect(names(await list(T.alice, '?sort=created_at&order=asc'))).toEqual(['Ana Torres', 'Beatriz Mena', 'Carlos 100%', 'ana maría']);
    expect(names(await list(T.alice))).toEqual(['ana maría', 'Carlos 100%', 'Beatriz Mena', 'Ana Torres']);
  });

  it('pagina por cursor sin repetir ni saltar, aun con fechas idénticas; el total solo viene en la primera página', async () => {
    await admin.query(`UPDATE contacts SET created_at = '2026-01-01T10:00:00.123456Z', updated_at = '2026-01-01T10:00:00.123456Z'`);
    for (const qs of ['?limit=2', '?limit=2&sort=name&order=asc', '?limit=3&sort=updated_at&order=asc']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let first = true;
      for (let i = 0; i < 6; i++) {
        const p = await list(T.alice, `${qs}${cursor ? `&cursor=${cursor}` : ''}`);
        if (first) expect(p.total).toBe(4);
        else expect(p.total).toBeNull();
        first = false;
        seen.push(...p.items.map((x) => x.id));
        cursor = p.next_cursor;
        if (!cursor) break;
      }
      expect(seen, qs).toHaveLength(4);
      expect(new Set(seen).size, qs).toBe(4);
    }
  });

  it('cursor inválido, de otro orden o filtros desconocidos → 400', async () => {
    const p = await list(T.alice, '?limit=2');
    const cur = p.next_cursor!;
    for (const qs of ['?cursor=basura', `?cursor=${cur}&sort=name`, `?cursor=${cur}&order=asc`, '?limit=0', '?limit=101', '?sort=email', '?owner=juan', '?foo=1', '?organization_id=' + ORG_B]) {
      expect((await call('GET', `/contacts${qs}`, T.alice)).status, qs).toBe(400);
    }
  });

  it('cada página trae sus teléfonos y el dueño con su nombre', async () => {
    const c = await make(T.alice, { name: 'Con dueño', phones: [P2 + '5'], owner_id: IDS.carol });
    const p = await list(T.alice, '?q=con%20due%C3%B1o');
    expect(p.items[0]).toMatchObject({ id: c.id, phones: [{ e164: P2 + '5', primary: true }], owner: { id: IDS.carol, name: 'Carolina Vera' } });
  });
});

describe('agencia dentro del cliente (ADR-41)', () => {
  it('con nivel administrador crea y edita (queda «actuando como agencia» en la auditoría DEL CLIENTE); con nivel lectura solo lee', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    const c = await make(T.dave, { name: 'Creado por la agencia' });
    const a = (await audits(c.id))[0]!;
    expect(a).toMatchObject({ organization_id: ORG_A, actor_user_id: IDS.dave, acting_as: 'agency', acting_org_id: AG1 });
    expect(names(await list(T.dave))).toEqual(['Creado por la agencia']);

    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect(names(await list(T.dave))).toEqual(['Creado por la agencia']); // leer, sí
    expect((await create(T.dave, { name: 'No debería' })).status).toBe(403);
    expect((await call('PATCH', `/contacts/${c.id}`, T.dave, { name: 'No' })).status).toBe(403);
    expect((await call('DELETE', `/contacts/${c.id}`, T.dave)).status).toBe(403);
  });
});

describe('base de datos: roles y restricciones', () => {
  it('app_rw no puede borrar ni vaciar; app_platform y app_identity no ven las tablas', async () => {
    const as = async (url: string, q: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        return await c.query(q);
      } finally {
        await c.end();
      }
    };
    for (const t of ['contacts', 'contact_phones']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `rw DELETE ${t}`).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `rw TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), `${t}`).rejects.toThrow(/permission denied/);
    }
  });

  it('la RLS: sin organización activa app_rw no ve nada; con la de A solo ve lo de A', async () => {
    await make(T.alice, { name: 'Ana de A', phones: [P1] });
    await make(T.bob, { name: 'Beto de B', phones: [P2] });
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query(`SELECT name FROM contacts`)).rows).toEqual([{ name: 'Ana de A' }]);
      expect((await c.query(`SELECT e164 FROM contact_phones`)).rows).toEqual([{ e164: P1 }]);
      await expect(c.query(`INSERT INTO contacts(organization_id, id, name) VALUES ('${ORG_B}', gen_random_uuid(), 'Intruso')`)).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('las restricciones protegen la forma de los datos y la FK compuesta impide colgar un teléfono de un contacto de otra empresa', async () => {
    const a = await make(T.alice, { name: 'Ana de A' });
    const bad = (sql: string) => admin.query(sql);
    await expect(bad(`INSERT INTO contacts(organization_id, id, name, email) VALUES ('${ORG_A}', gen_random_uuid(), 'X', 'MAYUS@a.test')`)).rejects.toThrow(/contacts_email_shape/);
    await expect(bad(`INSERT INTO contacts(organization_id, id, name, email) VALUES ('${ORG_A}', gen_random_uuid(), 'X', 'sin-arroba')`)).rejects.toThrow(/contacts_email_shape/);
    await expect(bad(`INSERT INTO contacts(organization_id, id, name) VALUES ('${ORG_A}', gen_random_uuid(), '   ')`)).rejects.toThrow(/contacts_name_shape/);
    await expect(bad(`INSERT INTO contacts(organization_id, id, name, consent) VALUES ('${ORG_A}', gen_random_uuid(), 'X', 'tal vez')`)).rejects.toThrow(/contacts_consent_valid/);
    await expect(bad(`INSERT INTO contacts(organization_id, id, name, source) VALUES ('${ORG_A}', gen_random_uuid(), 'X', 'Mi Fuente')`)).rejects.toThrow(/contacts_source_shape/);
    await expect(bad(`INSERT INTO contact_phones(organization_id, id, contact_id, e164) VALUES ('${ORG_A}', gen_random_uuid(), '${a.id}', '0984217730')`)).rejects.toThrow(/contact_phones_e164_shape/);
    await expect(bad(`INSERT INTO contact_phones(organization_id, id, contact_id, e164) VALUES ('${ORG_B}', gen_random_uuid(), '${a.id}', '+593984217731')`)).rejects.toThrow(/contact_phones_contact_fk/);
    await expect(bad(`INSERT INTO contacts(organization_id, id, name, owner_id) VALUES ('${ORG_A}', gen_random_uuid(), 'X', gen_random_uuid())`)).rejects.toThrow(/contacts_owner_id_users_id_fk/);
  });
});
