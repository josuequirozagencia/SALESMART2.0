// M3.2 — Campos personalizados (ADR-44). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione y que haya prueba A↔B):
//   GET /v1/custom-fields · POST /v1/custom-fields · PUT /v1/custom-fields/order · PATCH /v1/custom-fields/:id · POST /v1/custom-fields/:id/archive · POST /v1/custom-fields/:id/restore
// y la integración con contactos (POST/PATCH/GET /v1/contacts con `custom_fields`).
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
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};

interface Field { id: string; entity: string; name: string; key: string; type: string; options: string[] | null; required: boolean; show_in_form: boolean; position: number; archived_at: string | null; created_at: string }
interface FieldList { items: Field[]; access: { manage: boolean } }
interface Contact { id: string; name: string; custom_fields: Record<string, unknown> }
interface ContactPage { items: Contact[] }
interface ErrBody { error: { code: string; message: string; details: Array<{ path: string; code: string; message: string }> } }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE custom_field_values, custom_field_definitions, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
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
let T: Record<'alice' | 'carol' | 'bob' | 'dave' | 'root', string>;

/** Crea un campo (espera 201). */
const mk = async (t: string, body: Record<string, unknown>): Promise<Field> => {
  const r = await call('POST', '/custom-fields', t, body);
  expect(r.status, JSON.stringify(body)).toBe(201);
  return json<Field>(r);
};
const fields = async (t: string, qs = ''): Promise<FieldList> => {
  const r = await call('GET', `/custom-fields${qs}`, t);
  expect(r.status).toBe(200);
  return json<FieldList>(r);
};
const errOf = async (r: Response): Promise<ErrBody['error']> => (await json<ErrBody>(r)).error;
const contact = (t: string, body: Record<string, unknown>) => call('POST', '/contacts', t, body);
const mkContact = async (t: string, body: Record<string, unknown>): Promise<Contact> => {
  const r = await contact(t, body);
  expect(r.status, JSON.stringify(body)).toBe(201);
  return json<Contact>(r);
};
const getContact = async (t: string, id: string): Promise<Contact> => {
  const r = await call('GET', `/contacts/${id}`, t);
  expect(r.status).toBe(200);
  return json<Contact>(r);
};
const audits = async (entityType: string, entityId?: string) =>
  (await admin.query(`SELECT entity_type, entity_id, field, old_value, new_value, actor_user_id, acting_as, acting_org_id, organization_id FROM audit_logs WHERE entity_type = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY at, id`, entityId ? [entityType, entityId] : [entityType])).rows as Array<{ entity_id: string; field: string | null; old_value: unknown; new_value: unknown; actor_user_id: string; acting_as: string | null; acting_org_id: string | null; organization_id: string }>;

/** Un campo de cada tipo, con las variables que usan las pruebas de valores. */
async function typedSet(t: string): Promise<Record<string, Field>> {
  const spec: Array<[string, string, string[]?]> = [
    ['Ciudad', 'text'], ['Notas', 'long_text'], ['Edad', 'number'], ['Presupuesto', 'currency'], ['Nivel', 'percent'], ['Nacimiento', 'date'], ['Cuando', 'datetime'],
    ['Vip', 'boolean'], ['Correo 2', 'email'], ['Tel 2', 'phone'], ['Sitio', 'url'], ['Interés', 'select', ['Uñas', 'Repostería', 'Barbería']], ['Horarios', 'multiselect', ['Mañana', 'Tarde', 'Noche']],
  ];
  const out: Record<string, Field> = {};
  for (const [name, type, options] of spec) {
    const f = await mk(t, { name, type, ...(options ? { options } : {}) });
    out[f.key] = f;
  }
  return out;
}

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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('acceso y permisos', () => {
  it('sin sesión 401 y la plataforma (sin empresa) 403 en todas las rutas', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/custom-fields'], ['POST', '/custom-fields', { name: 'X', type: 'text' }], ['PUT', '/custom-fields/order', { ids: [id] }],
      ['PATCH', `/custom-fields/${id}`, { name: 'X' }], ['POST', `/custom-fields/${id}/archive`], ['POST', `/custom-fields/${id}/restore`],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('el asesor lee las definiciones (las necesita para el formulario) pero no las administra; el administrador sí', async () => {
    const f = await mk(T.alice, { name: 'Ciudad', type: 'text' });
    const asAdvisor = await fields(T.carol);
    expect(asAdvisor.items.map((x) => x.key)).toEqual(['ciudad']);
    expect(asAdvisor.access).toEqual({ manage: false });
    expect((await fields(T.alice)).access).toEqual({ manage: true });
    expect((await call('POST', '/custom-fields', T.carol, { name: 'Otro', type: 'text' })).status).toBe(403);
    expect((await call('PATCH', `/custom-fields/${f.id}`, T.carol, { name: 'Hackeado' })).status).toBe(403);
    expect((await call('POST', `/custom-fields/${f.id}/archive`, T.carol)).status).toBe(403);
    expect((await call('POST', `/custom-fields/${f.id}/restore`, T.carol)).status).toBe(403);
    expect((await call('PUT', '/custom-fields/order', T.carol, { ids: [f.id] })).status).toBe(403);
    expect((await fields(T.alice)).items[0]!.name).toBe('Ciudad');
  });

  it('una agencia con nivel administrador administra los campos del cliente; con nivel lectura solo los ve', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    const f = await mk(T.dave, { name: 'Interés', type: 'text' });
    expect((await fields(T.dave)).access.manage).toBe(true);
    const a = (await audits('custom_field', f.id))[0]!;
    expect(a).toMatchObject({ organization_id: ORG_A, actor_user_id: IDS.dave, acting_as: 'agency', acting_org_id: AG1 });

    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await fields(T.dave)).access.manage).toBe(false);
    expect((await call('POST', '/custom-fields', T.dave, { name: 'No', type: 'text' })).status).toBe(403);
    expect((await call('PATCH', `/custom-fields/${f.id}`, T.dave, { name: 'No' })).status).toBe(403);
  });
});

describe('aislamiento A↔B (otra empresa)', () => {
  it('B no ve, edita, archiva, restaura ni ordena los campos de A (404/409 sin filtrar nada) y puede tener la misma variable', async () => {
    const a = await mk(T.alice, { name: 'Ciudad', type: 'text' });
    const b = await mk(T.bob, { name: 'Ciudad', type: 'select', options: ['Quito'] }); // misma variable en otra empresa: permitido
    expect([a.key, b.key]).toEqual(['ciudad', 'ciudad']);
    expect(a.id).not.toBe(b.id);
    expect((await fields(T.bob)).items.map((x) => x.id)).toEqual([b.id]);
    expect((await fields(T.alice)).items.map((x) => x.id)).toEqual([a.id]);
    for (const [m, p, body] of [['PATCH', `/custom-fields/${a.id}`, { name: 'Hackeado' }], ['POST', `/custom-fields/${a.id}/archive`, undefined], ['POST', `/custom-fields/${a.id}/restore`, undefined]] as const) {
      expect((await call(m, p, T.bob, body)).status, `B ${m} ${p}`).toBe(404);
    }
    for (const [m, p, body] of [['PATCH', `/custom-fields/${b.id}`, { name: 'Hackeado' }], ['POST', `/custom-fields/${b.id}/archive`, undefined]] as const) {
      expect((await call(m, p, T.alice, body)).status, `A ${m} ${p}`).toBe(404);
    }
    const stale = await call('PUT', '/custom-fields/order', T.bob, { ids: [a.id] }); // un id ajeno nunca cuenta como propio
    expect(stale.status).toBe(409);
    expect((await errOf(stale)).code).toBe('CUSTOM_FIELD_ORDER_STALE');
    expect((await admin.query(`SELECT name, archived_at FROM custom_field_definitions WHERE id = $1`, [a.id])).rows[0]).toMatchObject({ name: 'Ciudad', archived_at: null });
  });

  it('un contacto de B no acepta las variables de A ni ve sus valores; con la misma variable cada empresa tiene los suyos', async () => {
    await mk(T.alice, { name: 'Interés', type: 'text' });
    const r = await contact(T.bob, { name: 'Cliente de B', custom_fields: { interes: 'x' } });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toEqual([{ path: 'custom_fields.interes', code: 'unknown_field', message: 'Ese campo no existe o está archivado' }]);
    await mk(T.bob, { name: 'Interés', type: 'text' });
    const ca = await mkContact(T.alice, { name: 'Ana', custom_fields: { interes: 'Uñas' } });
    const cb = await mkContact(T.bob, { name: 'Beto', custom_fields: { interes: 'Pelo' } });
    expect(ca.custom_fields).toEqual({ interes: 'Uñas' });
    expect(cb.custom_fields).toEqual({ interes: 'Pelo' });
    expect((await call('GET', `/contacts/${ca.id}`, T.bob)).status).toBe(404);
    expect((await json<ContactPage>(await call('GET', '/contacts', T.bob))).items.map((c) => c.custom_fields)).toEqual([{ interes: 'Pelo' }]);
  });
});

describe('definiciones', () => {
  it('crea un campo de cada tipo, con la variable sacada del nombre, en el orden en que se crean', async () => {
    const set = await typedSet(T.alice);
    expect(Object.keys(set)).toEqual(['ciudad', 'notas', 'edad', 'presupuesto', 'nivel', 'nacimiento', 'cuando', 'vip', 'correo_2', 'tel_2', 'sitio', 'interes', 'horarios']);
    const list = (await fields(T.alice)).items;
    expect(list.map((f) => f.position)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(list.map((f) => f.type)).toEqual(['text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'email', 'phone', 'url', 'select', 'multiselect']);
    expect(set['interes']).toMatchObject({ entity: 'contact', name: 'Interés', options: ['Uñas', 'Repostería', 'Barbería'], required: false, show_in_form: true, archived_at: null });
    expect(set['ciudad']!.options).toBeNull();
  });

  it('la variable: sin acentos ni símbolos, empieza con letra, tiene tope; las reservadas y las repetidas (con otro acento o mayúsculas) se rechazan', async () => {
    const key = async (name: string) => (await mk(T.alice, { name, type: 'text' })).key;
    expect(await key('Teléfono 2')).toBe('telefono_2');
    expect(await key('¿Qué curso te interesa?')).toBe('que_curso_te_interesa');
    expect(await key('2025 meta')).toBe('campo_2025_meta');
    expect(await key('###')).toBe('campo');
    expect((await key('x'.repeat(80))).length).toBeLessThanOrEqual(40);
    for (const name of ['Nombre', 'WhatsApp', 'Correo', 'Responsable', 'Fuente', 'ID', 'Etiquetas']) {
      const r = await call('POST', '/custom-fields', T.alice, { name, type: 'text' });
      expect(r.status, name).toBe(409);
      expect((await errOf(r)).code, name).toBe('CUSTOM_FIELD_KEY_RESERVED');
    }
    await mk(T.alice, { name: 'Ciudad', type: 'text' });
    for (const name of ['ciudad', 'CIUDAD', 'Cíudad', '  Ciudad  ']) {
      const r = await call('POST', '/custom-fields', T.alice, { name, type: 'text' });
      expect(r.status, name).toBe(409);
      expect((await errOf(r)).code, name).toBe('CUSTOM_FIELD_EXISTS');
    }
  });

  it('las opciones: obligatorias en los campos de selección (1 a 50, sin repetidas), prohibidas en los demás, recortadas y sin vacías', async () => {
    const bad = async (body: Record<string, unknown>, label: string) => {
      const r = await call('POST', '/custom-fields', T.alice, body);
      expect(r.status, label).toBe(400);
      expect((await errOf(r)).code, label).toBe('VALIDATION_ERROR');
    };
    await bad({ name: 'A', type: 'select' }, 'sin opciones');
    await bad({ name: 'B', type: 'select', options: [] }, 'vacías');
    await bad({ name: 'C', type: 'select', options: ['  ', ''] }, 'solo en blanco');
    await bad({ name: 'D', type: 'multiselect', options: ['Uno', 'uno'] }, 'repetida sin distinguir mayúsculas');
    await bad({ name: 'E', type: 'text', options: ['Uno'] }, 'texto con opciones');
    await bad({ name: 'F', type: 'select', options: Array.from({ length: 51 }, (_, i) => `Opción ${i}`) }, '51 opciones');
    await bad({ name: 'G', type: 'select', options: ['x'.repeat(101)] }, 'opción larga');
    const ok = await mk(T.alice, { name: 'H', type: 'select', options: ['  Uno ', '', 'Dos'] });
    expect(ok.options).toEqual(['Uno', 'Dos']);
    expect((await mk(T.alice, { name: 'I', type: 'text', options: [] })).options).toBeNull();
    await bad({ name: 'J', type: 'text', required: 'sí' }, 'tipo de dato');
    await bad({ name: 'K', type: 'text', key: 'mia' }, 'la variable no se envía');
    await bad({ name: '', type: 'text' }, 'nombre vacío');
    await bad({ name: 'L', type: 'archivo' }, 'tipo inexistente');
    await bad({ name: 'M', type: 'text', entity: 'company' }, 'entidad aún no disponible');
  });

  it('obligatorio solo si se muestra en el formulario: ocultar un campo obligatorio lo deja de ser, y pedir obligatorio uno oculto es un error', async () => {
    const r = await call('POST', '/custom-fields', T.alice, { name: 'A', type: 'text', required: true, show_in_form: false });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details[0]).toMatchObject({ path: 'required', code: 'requires_form' });
    const f = await mk(T.alice, { name: 'Cédula', type: 'text', required: true });
    expect(f).toMatchObject({ required: true, show_in_form: true });
    const hidden = await json<Field>(await call('PATCH', `/custom-fields/${f.id}`, T.alice, { show_in_form: false }));
    expect(hidden).toMatchObject({ required: false, show_in_form: false });
    const again = await call('PATCH', `/custom-fields/${f.id}`, T.alice, { required: true });
    expect(again.status).toBe(400);
    const both = await json<Field>(await call('PATCH', `/custom-fields/${f.id}`, T.alice, { show_in_form: true, required: true }));
    expect(both).toMatchObject({ required: true, show_in_form: true });
    const fields2 = (await audits('custom_field', f.id)).map((a) => a.field).filter(Boolean);
    expect(fields2.sort()).toEqual(['required', 'required', 'show_in_form', 'show_in_form']);
  });

  it('PATCH cambia nombre, opciones y visibilidad; el tipo y la variable no se pueden cambiar; sin cambios reales no deja rastro', async () => {
    const f = await mk(T.alice, { name: 'Interés', type: 'select', options: ['Uñas', 'Barbería'] });
    const r = await json<Field>(await call('PATCH', `/custom-fields/${f.id}`, T.alice, { name: 'Interés principal', options: ['Uñas', 'Barbería', 'Cejas'] }));
    expect(r).toMatchObject({ name: 'Interés principal', key: 'interes', type: 'select', options: ['Uñas', 'Barbería', 'Cejas'] });
    for (const body of [{ type: 'text' }, { key: 'otra' }, { entity: 'company' }, {}]) expect((await call('PATCH', `/custom-fields/${f.id}`, T.alice, body)).status, JSON.stringify(body)).toBe(400);
    expect((await call('PATCH', `/custom-fields/${f.id}`, T.alice, { options: [] })).status).toBe(400);
    const text = await mk(T.alice, { name: 'Ciudad', type: 'text' });
    const o = await call('PATCH', `/custom-fields/${text.id}`, T.alice, { options: ['x'] });
    expect(o.status).toBe(400);
    expect((await errOf(o)).details[0]).toMatchObject({ path: 'options', code: 'not_applicable' });
    const before = (await audits('custom_field', f.id)).length;
    const same = await call('PATCH', `/custom-fields/${f.id}`, T.alice, { name: 'Interés principal', options: ['Uñas', 'Barbería', 'Cejas'], show_in_form: true });
    expect(same.status).toBe(200);
    expect((await audits('custom_field', f.id)).length).toBe(before);
    expect((await audits('custom_field', f.id)).map((a) => a.field).filter(Boolean).sort()).toEqual(['name', 'options']);
  });

  it('archivar es reversible e idempotente; un campo archivado no se edita, no sale por defecto y su variable sigue reservada', async () => {
    const f = await mk(T.alice, { name: 'Ciudad', type: 'text' });
    const g = await mk(T.alice, { name: 'Interés', type: 'text' });
    const a = await json<Field>(await call('POST', `/custom-fields/${f.id}/archive`, T.alice));
    expect(a.archived_at).not.toBeNull();
    expect((await json<Field>(await call('POST', `/custom-fields/${f.id}/archive`, T.alice))).archived_at).toBe(a.archived_at); // idempotente
    expect((await fields(T.alice)).items.map((x) => x.key)).toEqual(['interes']);
    expect((await fields(T.alice, '?archived=include')).items.map((x) => x.key)).toEqual(['ciudad', 'interes']);
    const edit = await call('PATCH', `/custom-fields/${f.id}`, T.alice, { name: 'Otra' });
    expect(edit.status).toBe(409);
    expect((await errOf(edit)).code).toBe('CUSTOM_FIELD_ARCHIVED');
    const dup = await call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' });
    expect(dup.status).toBe(409);
    expect((await errOf(dup)).message).toMatch(/archivado/);
    const back = await json<Field>(await call('POST', `/custom-fields/${f.id}/restore`, T.alice));
    expect(back.archived_at).toBeNull();
    expect((await json<Field>(await call('POST', `/custom-fields/${f.id}/restore`, T.alice))).archived_at).toBeNull();
    expect((await fields(T.alice)).items.map((x) => x.key)).toEqual(['ciudad', 'interes']);
    expect(g.archived_at).toBeNull();
    expect((await audits('custom_field', f.id)).map((x) => x.field).filter(Boolean)).toEqual(['archived_at', 'archived_at']);
    expect((await call('POST', `/custom-fields/00000000-0000-4000-8000-000000000001/archive`, T.alice)).status).toBe(404);
    expect((await call('POST', `/custom-fields/no-es-uuid/archive`, T.alice)).status).toBe(400);
  });

  it('tope de 50 campos activos por entidad: el 51.º se rechaza, archivar libera un lugar y restaurar con la lista llena se rechaza', async () => {
    for (let i = 0; i < 50; i++) await mk(T.alice, { name: `Campo ${i}`, type: 'text' });
    const over = await call('POST', '/custom-fields', T.alice, { name: 'Uno más', type: 'text' });
    expect(over.status).toBe(409);
    expect((await errOf(over)).code).toBe('CUSTOM_FIELD_LIMIT');
    const first = (await fields(T.alice)).items[0]!;
    await call('POST', `/custom-fields/${first.id}/archive`, T.alice);
    const extra = await mk(T.alice, { name: 'Uno más', type: 'text' });
    expect(extra.position).toBe(50);
    const full = await call('POST', `/custom-fields/${first.id}/restore`, T.alice);
    expect(full.status).toBe(409);
    expect((await errOf(full)).code).toBe('CUSTOM_FIELD_LIMIT');
    expect((await fields(T.bob)).items).toEqual([]); // el tope es por empresa
    await mk(T.bob, { name: 'Campo 0', type: 'text' });
  }, 60_000);

  it('reordena: debe llegar el conjunto exacto de los campos activos; los archivados quedan al final; una lista desactualizada es 409', async () => {
    const a = await mk(T.alice, { name: 'A', type: 'text' });
    const b = await mk(T.alice, { name: 'B', type: 'text' });
    const c = await mk(T.alice, { name: 'C', type: 'text' });
    const d = await mk(T.alice, { name: 'D', type: 'text' });
    await call('POST', `/custom-fields/${b.id}/archive`, T.alice);
    const r = await call('PUT', '/custom-fields/order', T.alice, { ids: [c.id, d.id, a.id] });
    expect(r.status).toBe(200);
    const items = (await json<{ items: Field[] }>(r)).items;
    expect(items.map((x) => [x.key, x.position])).toEqual([['c', 0], ['d', 1], ['a', 2], ['b', 3]]);
    expect((await fields(T.alice)).items.map((x) => x.key)).toEqual(['c', 'd', 'a']);
    for (const ids of [[c.id, d.id], [c.id, d.id, a.id, b.id], [c.id, d.id, d.id], [c.id, d.id, '00000000-0000-4000-8000-000000000001']]) {
      const s = await call('PUT', '/custom-fields/order', T.alice, { ids });
      expect([400, 409], JSON.stringify(ids)).toContain(s.status);
    }
    expect((await audits('custom_field')).filter((x) => x.field === 'position').length).toBeGreaterThan(0);
    // un campo nuevo va al final
    expect((await mk(T.alice, { name: 'E', type: 'text' })).position).toBe(4);
  });

  it('concurrencia: el mismo nombre en paralelo crea uno solo; nombres distintos en paralelo no repiten posición ni pasan del tope', async () => {
    const same = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' })));
    expect(same.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    const distinct = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/custom-fields', T.alice, { name: `Paralelo ${i}`, type: 'text' })));
    expect(distinct.every((r) => r.status === 201)).toBe(true);
    const positions = (await fields(T.alice)).items.map((f) => f.position);
    expect(new Set(positions).size).toBe(positions.length);
    // 41 existentes (1 + 8 + 32) → solo caben 9 más de 10 intentos
    for (let i = 0; i < 32; i++) await mk(T.alice, { name: `Relleno ${i}`, type: 'text' });
    const race = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/custom-fields', T.alice, { name: `Carrera ${i}`, type: 'text' })));
    expect(race.filter((r) => r.status === 201).length).toBe(9);
    expect((await fields(T.alice)).items.length).toBe(50);
  }, 60_000);

  it('la auditoría deja el alta con todos sus datos y cada campo cambiado (misma transacción, con la persona que lo hizo)', async () => {
    const f = await mk(T.alice, { name: 'Interés', type: 'select', options: ['Uñas'], required: true });
    const first = (await audits('custom_field', f.id))[0]!;
    expect(first).toMatchObject({ field: null, actor_user_id: IDS.alice, acting_as: null, organization_id: ORG_A, new_value: { name: 'Interés', key: 'interes', type: 'select', options: ['Uñas'], required: true, show_in_form: true } });
    await call('PATCH', `/custom-fields/${f.id}`, T.alice, { name: 'Interés principal' });
    const upd = (await audits('custom_field', f.id)).find((x) => x.field === 'name')!;
    expect(upd).toMatchObject({ old_value: 'Interés', new_value: 'Interés principal' });
  });
});

describe('valores en los contactos', () => {
  it('guarda y devuelve los valores de todos los tipos en su forma canónica, también en el listado y el detalle', async () => {
    await typedSet(T.alice);
    const c = await mkContact(T.alice, {
      name: 'Ana',
      custom_fields: {
        ciudad: '  Guayaquil ', notas: 'Línea 1\nLínea 2', edad: '34', presupuesto: 1500.5, nivel: '12.50', nacimiento: '1990-05-17', cuando: '2026-10-20T10:00:00-05:00',
        vip: false, correo_2: 'Ana@Correo.TEST', tel_2: '+593984217730', sitio: 'https://ejemplo.com/a?b=1', interes: 'Uñas', horarios: ['Noche', 'Mañana'],
      },
    });
    const expected = {
      ciudad: 'Guayaquil', notas: 'Línea 1\nLínea 2', edad: 34, presupuesto: 1500.5, nivel: 12.5, nacimiento: '1990-05-17', cuando: '2026-10-20T15:00:00.000Z',
      vip: false, correo_2: 'ana@correo.test', tel_2: '+593984217730', sitio: 'https://ejemplo.com/a?b=1', interes: 'Uñas', horarios: ['Mañana', 'Noche'],
    };
    expect(c.custom_fields).toEqual(expected);
    expect((await getContact(T.alice, c.id)).custom_fields).toEqual(expected);
    const sin = await mkContact(T.alice, { name: 'Sin campos' });
    expect(sin.custom_fields).toEqual({});
    const page = await json<ContactPage>(await call('GET', '/contacts', T.alice));
    expect(Object.fromEntries(page.items.map((i) => [i.name, i.custom_fields]))).toEqual({ Ana: expected, 'Sin campos': {} });
    const row = (await admin.query(`SELECT d.var_key, v.value_text, v.value_number::text AS n, v.value_bool, v.value_date::text AS d, v.value_datetime, v.value_json FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.definition_id WHERE v.entity_id = $1 ORDER BY d.position`, [c.id])).rows;
    expect(row).toHaveLength(13);
    for (const r of row) {
      const filled = [r.value_text, r.n, r.value_bool, r.d, r.value_datetime, r.value_json].filter((x) => x !== null).length;
      expect(filled, r.var_key).toBe(1); // una sola columna con valor por fila
    }
  });

  it('valida cada tipo en el servidor, informa TODOS los errores a la vez con su ruta y no crea nada', async () => {
    await typedSet(T.alice);
    const r = await contact(T.alice, {
      name: 'X',
      custom_fields: {
        edad: 'abc', nacimiento: '2026-02-30', presupuesto: 1e10, nivel: '1.1234567', interes: 'Pintura', horarios: ['Mañana', 'Mañana'], vip: 'sí', sitio: 'ftp://x.test', correo_2: 'no-es-correo',
        tel_2: '0984217730', cuando: '2026-10-20 10:00', ciudad: 'x'.repeat(501), fantasma: 'zzz', notas: 'a\u0000b',
      },
    });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.code).toBe('VALIDATION_ERROR');
    const byPath = Object.fromEntries(e.details.map((d) => [d.path, d.code]));
    expect(byPath).toEqual({
      'custom_fields.edad': 'invalid', 'custom_fields.nacimiento': 'invalid', 'custom_fields.presupuesto': 'invalid', 'custom_fields.nivel': 'invalid', 'custom_fields.interes': 'invalid_option',
      'custom_fields.horarios': 'invalid', 'custom_fields.vip': 'invalid', 'custom_fields.sitio': 'invalid', 'custom_fields.correo_2': 'invalid', 'custom_fields.tel_2': 'invalid',
      'custom_fields.cuando': 'invalid', 'custom_fields.ciudad': 'too_long', 'custom_fields.fantasma': 'unknown_field', 'custom_fields.notas': 'invalid',
    });
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(0);
    expect((await admin.query('SELECT count(*)::int AS n FROM custom_field_values')).rows[0].n).toBe(0);
    // la forma del cuerpo la acota el esquema
    for (const bad of [{ 'Ciudad': 'x' }, { ciudad: { a: 1 } }, { ciudad: 5, x: [1] }]) expect((await contact(T.alice, { name: 'X', custom_fields: bad })).status, JSON.stringify(bad)).toBe(400);
    expect((await contact(T.alice, { name: 'X', custom_fields: 'x' })).status).toBe(400);
  });

  it('vaciar: null, texto en blanco o lista vacía borran el valor; false y 0 SON valores', async () => {
    await typedSet(T.alice);
    const c = await mkContact(T.alice, { name: 'Ana', custom_fields: { ciudad: 'Quito', interes: 'Uñas', horarios: ['Tarde'], vip: false, edad: 0, notas: 'x' } });
    expect(c.custom_fields).toEqual({ ciudad: 'Quito', interes: 'Uñas', horarios: ['Tarde'], vip: false, edad: 0, notas: 'x' });
    const r = await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { ciudad: null, interes: '', horarios: [], notas: '   ' } });
    expect(r.status).toBe(200);
    expect((await json<Contact>(r)).custom_fields).toEqual({ vip: false, edad: 0 });
    expect((await getContact(T.alice, c.id)).custom_fields).toEqual({ vip: false, edad: 0 });
    // la fila queda con todo en NULL (no se borra) y sigue pudiendo recibir un valor nuevo
    expect((await admin.query(`SELECT count(*)::int AS n FROM custom_field_values WHERE entity_id = $1`, [c.id])).rows[0].n).toBe(6);
    const back = await json<Contact>(await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { ciudad: 'Cuenca' } }));
    expect(back.custom_fields).toEqual({ ciudad: 'Cuenca', vip: false, edad: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM custom_field_values WHERE entity_id = $1`, [c.id])).rows[0].n).toBe(6);
  });

  it('PATCH solo toca las claves enviadas, audita una fila por campo cambiado (custom.<variable>) y un valor igual al guardado no deja rastro', async () => {
    await typedSet(T.alice);
    const c = await mkContact(T.alice, { name: 'Ana', custom_fields: { ciudad: 'Quito', edad: 30 } });
    const created = (await audits('contact', c.id))[0]!;
    expect(created.new_value).toMatchObject({ custom_fields: { ciudad: 'Quito', edad: 30 } });
    const r = await json<Contact>(await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { ciudad: 'Cuenca', interes: 'Uñas' } }));
    expect(r.custom_fields).toEqual({ ciudad: 'Cuenca', edad: 30, interes: 'Uñas' });
    const rows = (await audits('contact', c.id)).filter((a) => a.field?.startsWith('custom.')).sort((x, y) => (x.field ?? '').localeCompare(y.field ?? ''));
    expect(rows.map((a) => [a.field, a.old_value, a.new_value])).toEqual([['custom.ciudad', 'Quito', 'Cuenca'], ['custom.interes', null, 'Uñas']]);
    const before = (await audits('contact', c.id)).length;
    const same = await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { ciudad: 'Cuenca', edad: 30 } });
    expect(same.status).toBe(200);
    expect((await audits('contact', c.id)).length).toBe(before);
    // solo un cambio de campo personalizado también actualiza la fecha de modificación del contacto
    const prev = (await getContact(T.alice, c.id)) as Contact & { updated_at: string };
    await new Promise((res) => setTimeout(res, 15));
    const after = await json<Contact & { updated_at: string }>(await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { edad: 31 } }));
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(prev.updated_at).getTime());
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { fantasma: 'x' } })).status).toBe(400);
  });

  it('los obligatorios: se exigen al crear, no se pueden vaciar, pero editar otra cosa de un contacto anterior sin ese valor no falla', async () => {
    const viejo = await mkContact(T.alice, { name: 'Antiguo' }); // creado antes de que existiera el campo obligatorio
    const f = await mk(T.alice, { name: 'Cédula', type: 'text', required: true });
    const hidden = await mk(T.alice, { name: 'Referencia', type: 'text', show_in_form: false });
    expect(hidden.required).toBe(false);

    const falta = await contact(T.alice, { name: 'Nuevo' });
    expect(falta.status).toBe(400);
    expect((await errOf(falta)).details).toEqual([{ path: 'custom_fields.cedula', code: 'required', message: '«Cédula» es obligatorio' }]);
    expect((await contact(T.alice, { name: 'Nuevo', custom_fields: { cedula: '   ' } })).status).toBe(400);
    expect((await contact(T.alice, { name: 'Nuevo', custom_fields: { cedula: null } })).status).toBe(400);
    const ok = await mkContact(T.alice, { name: 'Nuevo', custom_fields: { cedula: '0912345678' } });
    expect(ok.custom_fields).toEqual({ cedula: '0912345678' });

    expect((await call('PATCH', `/contacts/${viejo.id}`, T.alice, { name: 'Antiguo editado' })).status).toBe(200); // no se le exige a un contacto anterior
    expect((await call('PATCH', `/contacts/${viejo.id}`, T.alice, { custom_fields: { referencia: 'x' } })).status).toBe(200);
    const vaciar = await call('PATCH', `/contacts/${ok.id}`, T.alice, { custom_fields: { cedula: null } });
    expect(vaciar.status).toBe(400);
    expect((await errOf(vaciar)).details[0]).toMatchObject({ path: 'custom_fields.cedula', code: 'required' });
    expect((await call('PATCH', `/contacts/${ok.id}`, T.alice, { custom_fields: { cedula: '0999999999' } })).status).toBe(200);
    // el servidor lo exige también al asesor; archivar el campo deja de exigirlo
    expect((await contact(T.carol, { name: 'De Carol' })).status).toBe(400);
    await call('POST', `/custom-fields/${f.id}/archive`, T.alice);
    expect((await contact(T.carol, { name: 'De Carol' })).status).toBe(201);
  });

  it('un campo archivado deja de verse y de aceptarse, y sus valores vuelven al restaurarlo; cambiar las opciones no toca los valores guardados', async () => {
    const set = await typedSet(T.alice);
    const c = await mkContact(T.alice, { name: 'Ana', custom_fields: { ciudad: 'Quito', interes: 'Barbería' } });
    await call('POST', `/custom-fields/${set['ciudad']!.id}/archive`, T.alice);
    expect((await getContact(T.alice, c.id)).custom_fields).toEqual({ interes: 'Barbería' });
    const r = await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { ciudad: 'Lima' } });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details[0]).toMatchObject({ code: 'unknown_field' });
    await call('POST', `/custom-fields/${set['ciudad']!.id}/restore`, T.alice);
    expect((await getContact(T.alice, c.id)).custom_fields).toEqual({ ciudad: 'Quito', interes: 'Barbería' });
    // se quita la opción «Barbería»: el valor ya guardado se conserva tal cual; uno nuevo ya no puede ser esa opción
    await call('PATCH', `/custom-fields/${set['interes']!.id}`, T.alice, { options: ['Uñas', 'Repostería'] });
    expect((await getContact(T.alice, c.id)).custom_fields).toEqual({ ciudad: 'Quito', interes: 'Barbería' });
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { custom_fields: { interes: 'Barbería' } })).status).toBe(400);
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { name: 'Ana María' })).status).toBe(200); // editar otra cosa no revalida lo guardado
  });

  it('el asesor llena los campos de SUS contactos y no ve ni toca los ajenos; la agencia en el cliente deja la marca «actuando como»', async () => {
    await typedSet(T.alice);
    const mio = await mkContact(T.carol, { name: 'De Carol', custom_fields: { ciudad: 'Quito' } });
    const ajeno = await mkContact(T.alice, { name: 'De Alicia', custom_fields: { ciudad: 'Lima' } });
    expect((await json<ContactPage>(await call('GET', '/contacts', T.carol))).items.map((i) => [i.name, i.custom_fields])).toEqual([['De Carol', { ciudad: 'Quito' }]]);
    expect((await call('GET', `/contacts/${ajeno.id}`, T.carol)).status).toBe(404);
    expect((await call('PATCH', `/contacts/${ajeno.id}`, T.carol, { custom_fields: { ciudad: 'x' } })).status).toBe(404);
    expect((await json<Contact>(await call('PATCH', `/contacts/${mio.id}`, T.carol, { custom_fields: { ciudad: 'Cuenca' } }))).custom_fields).toEqual({ ciudad: 'Cuenca' });

    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    const viaAgency = await mkContact(T.dave, { name: 'Por la agencia', custom_fields: { interes: 'Uñas' } });
    const a = (await audits('contact', viaAgency.id))[0]!;
    expect(a).toMatchObject({ organization_id: ORG_A, actor_user_id: IDS.dave, acting_as: 'agency', acting_org_id: AG1 });
    expect(a.new_value).toMatchObject({ custom_fields: { interes: 'Uñas' } });
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await call('PATCH', `/contacts/${viaAgency.id}`, T.dave, { custom_fields: { interes: 'Uñas' } })).status).toBe(403);
  });
});

describe('base de datos: roles y restricciones', () => {
  const as = async (url: string, q: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(q, params);
    } finally {
      await c.end();
    }
  };

  it('app_rw no puede borrar ni vaciar; app_platform y app_identity no ven las tablas', async () => {
    for (const t of ['custom_field_definitions', 'custom_field_values']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `rw DELETE ${t}`).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `rw TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });

  it('la RLS: sin organización activa app_rw no ve nada; con la de A solo ve lo de A y no inserta en B', async () => {
    await mk(T.alice, { name: 'Ciudad', type: 'text' });
    await mk(T.bob, { name: 'Pais', type: 'text' });
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      expect((await c.query(`SELECT name FROM custom_field_definitions`)).rows).toEqual([]);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query(`SELECT name FROM custom_field_definitions`)).rows).toEqual([{ name: 'Ciudad' }]);
      await expect(c.query(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_B}', gen_random_uuid(), 'contact', 'Intruso', 'intruso', 'text', 0)`)).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('las restricciones protegen la forma de los datos: tipo, variable, opciones, obligatorio, un solo valor por fila y la FK compuesta con la definición', async () => {
    const a = await mk(T.alice, { name: 'Ciudad', type: 'text' });
    const b = await mk(T.bob, { name: 'Ciudad', type: 'text' });
    const ctc = await mkContact(T.alice, { name: 'Ana' });
    const bad = (sql: string) => admin.query(sql);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'otra', 'X', 'x', 'text', 0)`)).rejects.toThrow(/custom_field_definitions_entity_valid/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', 'x', 'archivo', 0)`)).rejects.toThrow(/custom_field_definitions_type_valid/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', '   ', 'x', 'text', 0)`)).rejects.toThrow(/custom_field_definitions_name_shape/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', 'Mi Clave', 'text', 0)`)).rejects.toThrow(/custom_field_definitions_var_key_shape/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', '1abc', 'text', 0)`)).rejects.toThrow(/custom_field_definitions_var_key_shape/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', 'x', 'select', 0)`)).rejects.toThrow(/custom_field_definitions_options_by_type/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position, options) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', 'x', 'text', 0, '["a"]')`)).rejects.toThrow(/custom_field_definitions_options_by_type/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position, options) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', 'x', 'select', 0, '{"a":1}')`)).rejects.toThrow(/custom_field_definitions_options_by_type/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position, required, show_in_form) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', 'x', 'text', 0, true, false)`)).rejects.toThrow(/custom_field_definitions_required_in_form/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'X', 'x', 'text', -1)`)).rejects.toThrow(/custom_field_definitions_position_valid/);
    await expect(bad(`INSERT INTO custom_field_definitions(organization_id, id, entity, name, var_key, type, position) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', 'Otra', 'ciudad', 'text', 9)`)).rejects.toThrow(/custom_field_definitions_org_entity_key_uq/);

    const val = (org: string, defId: string, entity: string, cols: string) => `INSERT INTO custom_field_values(organization_id, id, entity, entity_id, definition_id, ${cols.split('=')[0]}) VALUES ('${org}', gen_random_uuid(), '${entity}', '${ctc.id}', '${defId}', ${cols.split('=')[1]})`;
    await expect(bad(`INSERT INTO custom_field_values(organization_id, id, entity, entity_id, definition_id, value_text, value_bool) VALUES ('${ORG_A}', gen_random_uuid(), 'contact', '${ctc.id}', '${a.id}', 'x', true)`)).rejects.toThrow(/custom_field_values_at_most_one/);
    await expect(bad(val(ORG_A, a.id, 'contact', "value_json='{\"a\":1}'"))).rejects.toThrow(/custom_field_values_json_is_array/);
    await expect(bad(val(ORG_A, b.id, 'contact', "value_text='x'"))).rejects.toThrow(/custom_field_values_definition_fk/); // definición de OTRA empresa
    await expect(bad(val(ORG_A, a.id, 'company', "value_text='x'"))).rejects.toThrow(/custom_field_values_definition_fk/); // de otra entidad
    await expect(bad(val(ORG_A, a.id, 'persona', "value_text='x'"))).rejects.toThrow(/custom_field_values_entity_valid/);
    await bad(val(ORG_A, a.id, 'contact', "value_text='ok'"));
    await expect(bad(val(ORG_A, a.id, 'contact', "value_text='otra vez'"))).rejects.toThrow(/custom_field_values_org_entity_def_uq/);
  });
});
