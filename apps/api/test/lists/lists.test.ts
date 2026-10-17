// M3.4 — Etiquetas personalizadas, filtros, listas y columnas (ADR-46). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   POST /v1/tags · PATCH /v1/tags/:id · DELETE /v1/tags/:id · GET /v1/contact-lists · POST /v1/contact-lists · PATCH /v1/contact-lists/:id · DELETE /v1/contact-lists/:id
//   POST /v1/contact-lists/:id/members · POST /v1/contact-lists/:id/members/remove  (y GET /v1/contacts con los filtros nuevos, list=, tag_ids)
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { OrganizationsModule } from '../../src/modules/organizations';
import { SystemTagsService } from '../../src/modules/tags';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
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
  carlos: 'c0000000-0000-4000-8000-0000000000c4', // asesor de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};

interface Tag { id: string; name: string; color: string; system_key: string | null; is_system: boolean }
interface Contact { id: string; name: string; tags: Tag[]; custom_fields: Record<string, unknown> }
interface Page { items: Contact[]; next_cursor: string | null; total: number | null }
interface List { id: string; name: string; kind: 'dynamic' | 'fixed'; filters: Record<string, unknown>; columns: string[] | null; sort: { key: string; order: string } | null; shared: boolean; mine: boolean; member_count: number | null }
interface Field { id: string; key: string }
interface Err { error: { code: string; message: string; details: Array<{ path: string; code: string; message: string }> } }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE contact_list_members, contact_lists, contact_tags, tags, meta_events, custom_field_values, custom_field_definitions, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.carlos, 'carlos@a.test', 'Carlos Mena'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.carlos, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
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
let T: Record<'alice' | 'carol' | 'carlos' | 'bob' | 'dave' | 'root', string>;
const code = async (r: Response): Promise<string> => (await json<Err>(r)).error.code;

const mkTag = async (t: string, name: string, color?: string): Promise<Tag> => {
  const r = await call('POST', '/tags', t, { name, ...(color ? { color } : {}) });
  expect(r.status, name).toBe(201);
  return json<Tag>(r);
};
const mkContact = async (t: string, body: Record<string, unknown>): Promise<Contact> => {
  const r = await call('POST', '/contacts', t, body);
  expect(r.status, JSON.stringify(body)).toBe(201);
  return json<Contact>(r);
};
const getContact = async (t: string, id: string): Promise<Contact> => json<Contact>(await call('GET', `/contacts/${id}`, t));
const page = async (t: string, qs = ''): Promise<Page> => {
  const r = await call('GET', `/contacts${qs}`, t);
  expect(r.status, qs).toBe(200);
  return json<Page>(r);
};
const names = (p: Page): string[] => p.items.map((c) => c.name).sort();
const mkList = async (t: string, body: Record<string, unknown>): Promise<List> => {
  const r = await call('POST', '/contact-lists', t, body);
  expect(r.status, JSON.stringify(body)).toBe(201);
  return json<List>(r);
};
const lists = async (t: string): Promise<List[]> => (await json<{ items: List[] }>(await call('GET', '/contact-lists', t))).items;
const mkField = async (t: string, body: Record<string, unknown>): Promise<Field> => {
  const r = await call('POST', '/custom-fields', t, body);
  expect(r.status).toBe(201);
  return json<Field>(r);
};
const audits = async (entityType: string, entityId?: string) =>
  (await admin.query(`SELECT field, old_value, new_value, acting_as FROM audit_logs WHERE entity_type = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY at, id`, entityId ? [entityType, entityId] : [entityType])).rows as Array<{ field: string | null; old_value: unknown; new_value: unknown; acting_as: string | null }>;
const q = (...p: string[]): string => `?${p.join('&')}`;
const cf = (f: string): string => `cf=${encodeURIComponent(f)}`;

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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), carlos: await login('carlos@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('etiquetas personalizadas', () => {
  it('solo el administrador las administra; el asesor las lee; sin sesión 401 y la plataforma 403', async () => {
    const t = await mkTag(T.alice, 'VIP', '#FF0000');
    expect(t).toMatchObject({ name: 'VIP', color: '#ff0000', is_system: false, system_key: null });
    expect((await call('POST', '/tags', T.carol, { name: 'X' })).status).toBe(403);
    expect((await call('PATCH', `/tags/${t.id}`, T.carol, { name: 'X' })).status).toBe(403);
    expect((await call('DELETE', `/tags/${t.id}`, T.carol)).status).toBe(403);
    const read = await json<{ items: Tag[]; access: { manage: boolean } }>(await call('GET', '/tags', T.carol));
    expect(read.access).toEqual({ manage: false });
    expect(read.items.map((x) => x.name)).toContain('VIP');
    expect((await json<{ access: { manage: boolean } }>(await call('GET', '/tags', T.alice))).access.manage).toBe(true);
    for (const [m, p] of [['POST', '/tags'], ['PATCH', `/tags/${t.id}`], ['DELETE', `/tags/${t.id}`]] as const) {
      expect((await call(m, p, undefined, {})).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, {})).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('valida nombre y color, el nombre es único sin distinguir mayúsculas (también frente a las del sistema) y se puede renombrar y recolorear', async () => {
    const t = await mkTag(T.alice, 'Cliente frecuente');
    expect(t.color).toBe('#6a44f2');
    for (const body of [{ name: '' }, { name: 'x'.repeat(61) }, { name: 'A', color: 'rojo' }, { name: 'A', color: '#12345' }, { name: 'A', extra: 1 }, {}]) expect((await call('POST', '/tags', T.alice, body)).status, JSON.stringify(body)).toBe(400);
    for (const name of ['cliente FRECUENTE', 'Lead', 'venta']) {
      const r = await call('POST', '/tags', T.alice, { name });
      expect(r.status, name).toBe(409);
      expect(await code(r), name).toBe('TAG_EXISTS');
    }
    const r = await json<Tag>(await call('PATCH', `/tags/${t.id}`, T.alice, { name: 'Frecuente', color: '#00FF00' }));
    expect(r).toMatchObject({ name: 'Frecuente', color: '#00ff00' });
    await mkTag(T.alice, 'Otra');
    expect(await code(await call('PATCH', `/tags/${t.id}`, T.alice, { name: 'otra' }))).toBe('TAG_EXISTS');
    expect((await call('PATCH', `/tags/${t.id}`, T.alice, {})).status).toBe(400);
    expect((await audits('tag', t.id)).map((a) => a.field).filter(Boolean).sort()).toEqual(['color', 'name']);
  });

  it('las del sistema no se renombran ni se borran (409); borrar una personalizada la oculta de la lista y de los contactos pero no borra contactos', async () => {
    const sys = (await json<{ items: Tag[] }>(await call('GET', '/tags', T.alice))).items.find((x) => x.system_key === 'lead')!;
    expect(await code(await call('PATCH', `/tags/${sys.id}`, T.alice, { name: 'Otra' }))).toBe('TAG_SYSTEM');
    expect(await code(await call('DELETE', `/tags/${sys.id}`, T.alice))).toBe('TAG_SYSTEM');
    const t = await mkTag(T.alice, 'Temporal');
    const c = await mkContact(T.alice, { name: 'Ana', tag_ids: [t.id] });
    expect(c.tags.map((x) => x.name)).toEqual(['Temporal']);
    expect((await call('DELETE', `/tags/${t.id}`, T.alice)).status).toBe(200);
    expect((await getContact(T.alice, c.id)).tags).toEqual([]);
    expect((await json<{ items: Tag[] }>(await call('GET', '/tags', T.alice))).items.map((x) => x.name)).not.toContain('Temporal');
    expect((await call('DELETE', `/tags/${t.id}`, T.alice)).status).toBe(404);
    expect((await call('PATCH', `/tags/${t.id}`, T.alice, { name: 'Revivida' })).status).toBe(404);
    await mkTag(T.alice, 'Temporal'); // el nombre vuelve a estar libre
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(1);
  });

  it('tope de 100 etiquetas personalizadas por empresa', async () => {
    for (let i = 0; i < 100; i++) await mkTag(T.alice, `Etiqueta ${i}`);
    const over = await call('POST', '/tags', T.alice, { name: 'Una más' });
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('TAG_LIMIT');
    await mkTag(T.bob, 'Etiqueta 0'); // el tope es por empresa
  }, 60_000);

  it('aislamiento A↔B: B no ve, cambia ni borra las de A (404) y no puede ponerlas a sus contactos', async () => {
    const a = await mkTag(T.alice, 'De A');
    const b = await mkTag(T.bob, 'De B');
    expect((await json<{ items: Tag[] }>(await call('GET', '/tags', T.bob))).items.map((x) => x.name)).not.toContain('De A');
    expect((await call('PATCH', `/tags/${a.id}`, T.bob, { name: 'Hackeada' })).status).toBe(404);
    expect((await call('DELETE', `/tags/${a.id}`, T.bob)).status).toBe(404);
    expect((await call('PATCH', `/tags/${b.id}`, T.alice, { name: 'Hackeada' })).status).toBe(404);
    const r = await call('POST', '/contacts', T.bob, { name: 'Beto', tag_ids: [a.id] });
    expect(r.status).toBe(400);
    expect((await json<Err>(r)).error.details[0]).toMatchObject({ path: 'tag_ids', code: 'invalid_tag' });
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(0);
    expect((await admin.query('SELECT name FROM tags WHERE id = $1', [a.id])).rows[0].name).toBe('De A');
  });
});

describe('etiquetas en los contactos', () => {
  it('al crear y editar (tag_ids) se reemplaza el conjunto de personalizadas; las del sistema no se tocan; se audita', async () => {
    const vip = await mkTag(T.alice, 'VIP');
    const frio = await mkTag(T.alice, 'Frío');
    const c = await mkContact(T.alice, { name: 'Ana', tag_ids: [vip.id] });
    expect(c.tags.map((x) => x.name)).toEqual(['VIP']);
    await inA(() => app.get(Database).withTenant((tx) => app.get(SystemTagsService).apply(tx, c.id, 'lead')));
    expect((await getContact(T.alice, c.id)).tags.map((x) => x.name).sort()).toEqual(['Lead', 'VIP']);

    const r = await json<Contact>(await call('PATCH', `/contacts/${c.id}`, T.alice, { tag_ids: [frio.id] }));
    expect(r.tags.map((x) => x.name).sort()).toEqual(['Frío', 'Lead']); // VIP salió, Lead (sistema) se queda
    expect((await json<Contact>(await call('PATCH', `/contacts/${c.id}`, T.alice, { tag_ids: [] }))).tags.map((x) => x.name)).toEqual(['Lead']);
    const before = (await audits('contact', c.id)).length;
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { tag_ids: [] })).status).toBe(200); // sin cambio real
    expect((await audits('contact', c.id)).length).toBe(before);
    const tagRows = (await audits('contact', c.id)).filter((a) => a.field === 'tags');
    expect(tagRows.map((a) => [a.old_value, a.new_value])).toEqual([[['VIP'], ['Frío']], [['Frío'], []]]);
    // solo con tag_ids no hace falta tocar nada más
    expect((await call('PATCH', `/contacts/${c.id}`, T.alice, { tag_ids: [vip.id, frio.id] })).status).toBe(200);
    expect((await getContact(T.alice, c.id)).tags.map((x) => x.name).sort()).toEqual(['Frío', 'Lead', 'VIP']);
  });

  it('rechaza etiquetas del sistema, borradas, inexistentes o repetidas, y no deja nada a medias', async () => {
    const sys = (await json<{ items: Tag[] }>(await call('GET', '/tags', T.alice))).items.find((x) => x.system_key === 'sale')!;
    const gone = await mkTag(T.alice, 'Borrada');
    await call('DELETE', `/tags/${gone.id}`, T.alice);
    const ok = await mkTag(T.alice, 'Buena');
    const c = await mkContact(T.alice, { name: 'Ana', tag_ids: [ok.id] });
    for (const ids of [[sys.id], [gone.id], ['11111111-1111-4111-8111-111111111111'], [ok.id, ok.id]]) {
      const r = await call('PATCH', `/contacts/${c.id}`, T.alice, { name: 'Cambiado', tag_ids: ids });
      expect(r.status, JSON.stringify(ids)).toBe(400);
    }
    expect((await getContact(T.alice, c.id)).name).toBe('Ana');
    expect((await call('POST', '/contacts', T.alice, { name: 'X', tag_ids: ['no-uuid'] })).status).toBe(400);
  });

  it('el asesor etiqueta los contactos que tiene asignados y no los ajenos', async () => {
    const t = await mkTag(T.alice, 'VIP');
    const mio = await mkContact(T.carol, { name: 'De Carol', tag_ids: [t.id] });
    expect(mio.tags.map((x) => x.name)).toEqual(['VIP']);
    const ajeno = await mkContact(T.alice, { name: 'De Alicia' });
    expect((await call('PATCH', `/contacts/${ajeno.id}`, T.carol, { tag_ids: [t.id] })).status).toBe(404);
    expect((await getContact(T.alice, ajeno.id)).tags).toEqual([]);
  });
});

describe('filtros del listado', () => {
  async function world() {
    const vip = await mkTag(T.alice, 'VIP');
    const frio = await mkTag(T.alice, 'Frío');
    const ciudad = await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    const interes = await mkField(T.alice, { name: 'Interés', type: 'select', options: ['Uñas', 'Barbería'] });
    const horarios = await mkField(T.alice, { name: 'Horarios', type: 'multiselect', options: ['Mañana', 'Tarde'] });
    const edad = await mkField(T.alice, { name: 'Edad', type: 'number' });
    const nac = await mkField(T.alice, { name: 'Nacimiento', type: 'date' });
    const vipf = await mkField(T.alice, { name: 'Cliente VIP', type: 'boolean' });
    const web = await mkField(T.alice, { name: 'Web', type: 'url' });
    await mkContact(T.alice, { name: 'Ana', consent: 'granted', tag_ids: [vip.id, frio.id], custom_fields: { ciudad: 'Quito', interes: 'Uñas', horarios: ['Mañana'], edad: 30, nacimiento: '1990-05-17', cliente_vip: true } });
    await mkContact(T.alice, { name: 'Beto', consent: 'revoked', tag_ids: [vip.id], custom_fields: { ciudad: 'quito norte', interes: 'Barbería', horarios: ['Mañana', 'Tarde'], edad: 45, nacimiento: '1980-01-01', cliente_vip: false } });
    await mkContact(T.alice, { name: 'Carla', custom_fields: { ciudad: 'Guayaquil', edad: 30.5 } });
    await mkContact(T.alice, { name: 'Dani' });
    return { vip, frio, ciudad, interes, horarios, edad, nac, vipf, web };
  }

  it('consentimiento y etiquetas (el contacto debe tener TODAS las pedidas)', async () => {
    const w = await world();
    expect(names(await page(T.alice, q('consent=granted')))).toEqual(['Ana']);
    expect(names(await page(T.alice, q('consent=unknown')))).toEqual(['Carla', 'Dani']);
    expect(names(await page(T.alice, q(`tag=${w.vip.id}`)))).toEqual(['Ana', 'Beto']);
    expect(names(await page(T.alice, q(`tag=${w.vip.id}`, `tag=${w.frio.id}`)))).toEqual(['Ana']);
    expect(names(await page(T.alice, q(`tag=${w.vip.id}`, 'consent=revoked')))).toEqual(['Beto']);
    expect(names(await page(T.alice, q('tag=11111111-1111-4111-8111-111111111111')))).toEqual([]); // una etiqueta que no existe no coincide con nadie
    expect((await call('GET', '/contacts?tag=no-uuid', T.alice)).status).toBe(400);
    expect((await call('GET', '/contacts?consent=tal-vez', T.alice)).status).toBe(400);
    expect((await page(T.alice, q('consent=granted'))).total).toBe(1);
  });

  it('campos personalizados por tipo: texto (igual sin distinguir mayúsculas y contiene), selección, selección múltiple, número, fecha y Sí/No', async () => {
    await world();
    expect(names(await page(T.alice, q(cf('ciudad:eq:QUITO'))))).toEqual(['Ana']);
    expect(names(await page(T.alice, q(cf('ciudad:contains:quito'))))).toEqual(['Ana', 'Beto']);
    expect(names(await page(T.alice, q(cf('ciudad:contains:100%'))))).toEqual([]); // los comodines del usuario no se interpretan
    expect(names(await page(T.alice, q(cf('interes:eq:Barbería'))))).toEqual(['Beto']);
    expect(names(await page(T.alice, q(cf('horarios:contains:Mañana'))))).toEqual(['Ana', 'Beto']);
    expect(names(await page(T.alice, q(cf('horarios:contains:Tarde'))))).toEqual(['Beto']);
    expect(names(await page(T.alice, q(cf('edad:gte:30'))))).toEqual(['Ana', 'Beto', 'Carla']);
    expect(names(await page(T.alice, q(cf('edad:gte:31'))))).toEqual(['Beto']);
    expect(names(await page(T.alice, q(cf('edad:lte:30'))))).toEqual(['Ana']);
    expect(names(await page(T.alice, q(cf('edad:eq:30.5'))))).toEqual(['Carla']);
    expect(names(await page(T.alice, q(cf('nacimiento:gte:1985-01-01'))))).toEqual(['Ana']);
    expect(names(await page(T.alice, q(cf('nacimiento:eq:1980-01-01'))))).toEqual(['Beto']);
    expect(names(await page(T.alice, q(cf('cliente_vip:eq:true'))))).toEqual(['Ana']);
    expect(names(await page(T.alice, q(cf('cliente_vip:eq:false'))))).toEqual(['Beto']);
    // varios filtros a la vez se suman (todos deben cumplirse)
    expect(names(await page(T.alice, q(cf('ciudad:contains:quito'), cf('edad:gte:40'), 'consent=revoked')))).toEqual(['Beto']);
  });

  it('«tiene valor» y «está vacío»; un campo borrado a null cuenta como vacío', async () => {
    await world();
    expect(names(await page(T.alice, q(cf('ciudad:is_set'))))).toEqual(['Ana', 'Beto', 'Carla']);
    expect(names(await page(T.alice, q(cf('ciudad:is_empty'))))).toEqual(['Dani']);
    expect(names(await page(T.alice, q(cf('interes:is_empty'))))).toEqual(['Carla', 'Dani']);
    const carla = (await page(T.alice, q('q=Carla'))).items[0]!;
    await call('PATCH', `/contacts/${carla.id}`, T.alice, { custom_fields: { ciudad: null } });
    expect(names(await page(T.alice, q(cf('ciudad:is_empty'))))).toEqual(['Carla', 'Dani']);
  });

  it('un filtro mal formado, un campo inexistente o archivado, o un operador que no corresponde al tipo es un 400 con explicación', async () => {
    const w = await world();
    const bad = async (f: string) => {
      const r = await call('GET', `/contacts${q(cf(f))}`, T.alice);
      expect(r.status, f).toBe(400);
      return (await json<Err>(r)).error.details[0]!;
    };
    expect(await bad('sin-formato')).toMatchObject({ path: 'cf', code: 'invalid' });
    expect(await bad('ciudad:raro:x')).toMatchObject({ code: 'invalid' });
    expect(await bad('ciudad:eq')).toMatchObject({ code: 'invalid' }); // eq necesita valor
    expect(await bad('ciudad:is_set:x')).toMatchObject({ code: 'invalid' });
    expect(await bad('fantasma:eq:x')).toMatchObject({ code: 'unknown_field' });
    expect(await bad('edad:contains:3')).toMatchObject({ code: 'invalid' });
    expect(await bad('edad:eq:abc')).toMatchObject({ code: 'invalid' });
    expect(await bad('nacimiento:eq:17/05/1990')).toMatchObject({ code: 'invalid' });
    expect(await bad('cliente_vip:eq:quizás')).toMatchObject({ code: 'invalid' });
    expect(await bad('interes:contains:Un')).toMatchObject({ code: 'invalid' });
    expect(await bad('horarios:eq:Mañana')).toMatchObject({ code: 'invalid' });
    await call('POST', `/custom-fields/${w.ciudad.id}/archive`, T.alice);
    expect(await bad('ciudad:eq:Quito')).toMatchObject({ code: 'unknown_field' });
    expect((await call('GET', `/contacts?${Array.from({ length: 11 }, () => cf('edad:gte:1')).join('&')}`, T.alice)).status).toBe(400); // tope de filtros
  });

  it('los filtros respetan el alcance del asesor y se combinan con la paginación por cursor sin repetir ni saltar', async () => {
    const t = await mkTag(T.alice, 'VIP');
    for (let i = 0; i < 7; i++) await mkContact(T.carol, { name: `Mío ${i}`, tag_ids: [t.id] });
    for (let i = 0; i < 3; i++) await mkContact(T.alice, { name: `Ajeno ${i}`, tag_ids: [t.id] });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: Page = await page(T.carol, q(`tag=${t.id}`, 'limit=3', 'sort=name', 'order=asc', ...(cursor ? [`cursor=${cursor}`] : [])));
      seen.push(...p.items.map((c) => c.name));
      cursor = p.next_cursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `Mío ${i}`));
    expect((await page(T.alice, q(`tag=${t.id}`))).total).toBe(10);
  });

  it('aislamiento A↔B: una etiqueta o un campo de A no filtran nada en B', async () => {
    const w = await world();
    await mkContact(T.bob, { name: 'Beto de B' });
    expect(names(await page(T.bob, q(`tag=${w.vip.id}`)))).toEqual([]);
    expect(names(await page(T.bob))).toEqual(['Beto de B']);
    const r = await call('GET', `/contacts${q(cf('ciudad:eq:Quito'))}`, T.bob);
    expect(r.status).toBe(400); // el campo no existe en B
    expect((await json<Err>(r)).error.details[0]!.code).toBe('unknown_field');
  });
});

/** Ejecuta en el contexto de la empresa A (para llamar a los servicios internos). */
const inA = <R,>(fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: ORG_A, userId: IDS.alice }, fn);

describe('listas', () => {
  it('sin sesión 401, la plataforma 403, el asesor puede crear listas personales y la agencia en solo lectura solo las ve', async () => {
    for (const [m, p] of [['GET', '/contact-lists'], ['POST', '/contact-lists']] as const) {
      const body = m === 'POST' ? {} : undefined;
      expect((await call(m, p, undefined, body)).status).toBe(401);
      expect((await call(m, p, T.root, body)).status).toBe(403);
    }
    await mkList(T.carol, { name: 'Mis pendientes', kind: 'dynamic', filters: { consent: 'granted' } });
    expect(await call('POST', '/context/switch', T.dave, { target: ORG_A }).then((r) => r.status)).toBe(200);
    expect((await lists(T.dave)).length).toBe(0); // la lista de Carol es personal
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await call('GET', '/contact-lists', T.dave)).status).toBe(200);
    const r = await call('POST', '/contact-lists', T.dave, { name: 'No', kind: 'dynamic' });
    expect(r.status).toBe(403);
  });

  it('lista dinámica: guarda filtros, columnas y orden; al abrirla (list=) se aplican y los filtros de la petición se suman', async () => {
    const vip = await mkTag(T.alice, 'VIP');
    await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    await mkContact(T.alice, { name: 'Ana', consent: 'granted', tag_ids: [vip.id], custom_fields: { ciudad: 'Quito' } });
    await mkContact(T.alice, { name: 'Beto', consent: 'granted', tag_ids: [vip.id], custom_fields: { ciudad: 'Cuenca' } });
    await mkContact(T.alice, { name: 'Carla', consent: 'granted', custom_fields: { ciudad: 'Quito' } });
    await mkContact(T.alice, { name: 'Dani', tag_ids: [vip.id], custom_fields: { ciudad: 'Quito' } });
    const l = await mkList(T.alice, { name: 'VIP con consentimiento', kind: 'dynamic', filters: { consent: 'granted', tag: [vip.id] }, columns: ['name', 'phone', 'cf:ciudad'], sort: { key: 'name', order: 'asc' } });
    expect(l).toMatchObject({ kind: 'dynamic', shared: false, mine: true, member_count: null, columns: ['name', 'phone', 'cf:ciudad'], sort: { key: 'name', order: 'asc' } });
    expect(l.filters).toEqual({ consent: 'granted', tag: [vip.id] });
    expect(names(await page(T.alice, q(`list=${l.id}`)))).toEqual(['Ana', 'Beto']);
    expect(names(await page(T.alice, q(`list=${l.id}`, cf('ciudad:eq:Quito'))))).toEqual(['Ana']); // se suma
    expect(names(await page(T.alice, q(`list=${l.id}`, 'consent=revoked')))).toEqual([]); // lo escalar de la petición manda
    expect((await page(T.alice, q(`list=${l.id}`))).total).toBe(2);
    // es dinámica: un contacto nuevo que cumple entra solo
    await mkContact(T.alice, { name: 'Eva', consent: 'granted', tag_ids: [vip.id] });
    expect(names(await page(T.alice, q(`list=${l.id}`)))).toEqual(['Ana', 'Beto', 'Eva']);
    // editar filtros, columnas y orden; el tipo no cambia
    const up = await json<List>(await call('PATCH', `/contact-lists/${l.id}`, T.alice, { filters: { consent: 'granted' }, columns: ['name'], sort: null }));
    expect(up).toMatchObject({ filters: { consent: 'granted' }, columns: ['name'], sort: null });
    expect((await call('PATCH', `/contact-lists/${l.id}`, T.alice, { kind: 'fixed' })).status).toBe(400);
    expect(names(await page(T.alice, q(`list=${l.id}`)))).toEqual(['Ana', 'Beto', 'Carla', 'Eva']);
  });

  it('validación: nombre, columnas, orden y combinaciones que no corresponden al tipo; un campo archivado en los filtros guardados avisa al abrir la lista', async () => {
    const bad = async (body: Record<string, unknown>, label: string) => expect((await call('POST', '/contact-lists', T.alice, body)).status, label).toBe(400);
    await bad({ kind: 'dynamic' }, 'sin nombre');
    await bad({ name: '  ', kind: 'dynamic' }, 'nombre en blanco');
    await bad({ name: 'x'.repeat(61), kind: 'dynamic' }, 'nombre largo');
    await bad({ name: 'A', kind: 'otra' }, 'tipo');
    await bad({ name: 'A', kind: 'dynamic', columns: [] }, 'sin columnas');
    await bad({ name: 'A', kind: 'dynamic', columns: ['name', 'name'] }, 'columna repetida');
    await bad({ name: 'A', kind: 'dynamic', columns: ['secreto'] }, 'columna fuera del catálogo');
    await bad({ name: 'A', kind: 'dynamic', columns: ['cf:Mayus'] }, 'variable inválida');
    await bad({ name: 'A', kind: 'dynamic', sort: { key: 'phone', order: 'asc' } }, 'orden no permitido');
    await bad({ name: 'A', kind: 'dynamic', filters: { owner_id: 'x' } }, 'filtro desconocido');
    await bad({ name: 'A', kind: 'dynamic', contact_ids: ['11111111-1111-4111-8111-111111111111'] }, 'contactos en una dinámica');
    await bad({ name: 'A', kind: 'fixed', filters: { consent: 'granted' } }, 'filtros en una fija');
    await bad({ name: 'A', kind: 'fixed', contact_ids: [] }, 'lista de contactos vacía');
    const ciudad = await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    const l = await mkList(T.alice, { name: 'Por ciudad', kind: 'dynamic', filters: { cf: ['ciudad:eq:Quito'] } });
    expect((await call('GET', `/contacts${q(`list=${l.id}`)}`, T.alice)).status).toBe(200);
    await call('POST', `/custom-fields/${ciudad.id}/archive`, T.alice);
    const r = await call('GET', `/contacts${q(`list=${l.id}`)}`, T.alice);
    expect(r.status).toBe(400);
    expect((await json<Err>(r)).error.details[0]!.code).toBe('unknown_field');
  });

  it('lista fija: se crea con la selección (solo entran los contactos visibles), se agregan y se quitan contactos, y el conteo es el de lo visible', async () => {
    const a = await mkContact(T.carol, { name: 'De Carol 1' });
    const b = await mkContact(T.carol, { name: 'De Carol 2' });
    const x = await mkContact(T.alice, { name: 'De Alicia' }); // Carol no lo ve
    const l = await mkList(T.carol, { name: 'Mi selección', kind: 'fixed', contact_ids: [a.id, x.id] });
    expect(l.member_count).toBe(1); // el ajeno no entró
    expect(names(await page(T.carol, q(`list=${l.id}`)))).toEqual(['De Carol 1']);
    expect(await json(await call('POST', `/contact-lists/${l.id}/members`, T.carol, { contact_ids: [b.id, a.id, x.id] }))).toEqual({ added: 1, skipped: 2 });
    expect(names(await page(T.carol, q(`list=${l.id}`)))).toEqual(['De Carol 1', 'De Carol 2']);
    expect((await lists(T.carol)).find((z) => z.id === l.id)!.member_count).toBe(2);
    expect(await json(await call('POST', `/contact-lists/${l.id}/members/remove`, T.carol, { contact_ids: [a.id, x.id] }))).toEqual({ removed: 1 });
    expect(names(await page(T.carol, q(`list=${l.id}`)))).toEqual(['De Carol 2']);
    // una fija combinada con filtros de la petición
    expect(names(await page(T.carol, q(`list=${l.id}`, 'q=Alicia')))).toEqual([]);
    // un contacto borrado deja de verse en la lista aunque siga en la tabla de miembros
    await call('DELETE', `/contacts/${b.id}`, T.alice);
    expect(names(await page(T.carol, q(`list=${l.id}`)))).toEqual([]);
    expect((await lists(T.carol)).find((z) => z.id === l.id)!.member_count).toBe(0);
    // las dinámicas no tienen miembros a mano
    const d = await mkList(T.carol, { name: 'Dinámica', kind: 'dynamic' });
    const r = await call('POST', `/contact-lists/${d.id}/members`, T.carol, { contact_ids: [a.id] });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('LIST_NOT_FIXED');
    expect((await call('POST', `/contact-lists/${l.id}/members`, T.carol, { contact_ids: [] })).status).toBe(400);
  });

  it('personal por defecto: compartir exige contacts.view_all; una compartida la ven todos, solo la edita su dueño o quien ve todo, y NUNCA amplía lo que el asesor ve', async () => {
    const vip = await mkTag(T.alice, 'VIP');
    await mkContact(T.carol, { name: 'De Carol', tag_ids: [vip.id] });
    await mkContact(T.alice, { name: 'De Alicia', tag_ids: [vip.id] });
    const shareTry = await call('POST', '/contact-lists', T.carol, { name: 'Compartida de Carol', kind: 'dynamic', shared: true });
    expect(shareTry.status).toBe(403);
    expect(await code(shareTry)).toBe('LIST_SHARE_NOT_ALLOWED');

    const compartida = await mkList(T.alice, { name: 'VIP de la empresa', kind: 'dynamic', filters: { tag: [vip.id] }, shared: true });
    const personal = await mkList(T.alice, { name: 'Solo mía', kind: 'dynamic' });
    expect((await lists(T.carol)).map((l) => [l.name, l.mine])).toEqual([['VIP de la empresa', false]]); // la personal de Alicia no se ve
    expect(names(await page(T.carol, q(`list=${compartida.id}`)))).toEqual(['De Carol']); // solo lo suyo, aunque la lista incluya más
    expect(names(await page(T.alice, q(`list=${compartida.id}`)))).toEqual(['De Alicia', 'De Carol']);
    expect((await call('GET', `/contacts${q(`list=${personal.id}`)}`, T.carol)).status).toBe(404);

    // Carol usa la compartida pero no la cambia ni la borra; la personal de otra persona ni existe para ella
    expect(await code(await call('PATCH', `/contact-lists/${compartida.id}`, T.carol, { name: 'Mía ahora' }))).toBe('LIST_NOT_YOURS');
    expect(await code(await call('DELETE', `/contact-lists/${compartida.id}`, T.carol))).toBe('LIST_NOT_YOURS');
    expect((await call('PATCH', `/contact-lists/${personal.id}`, T.carol, { name: 'X' })).status).toBe(404);
    // Alicia (ve todo) sí puede cambiar una compartida de Carol; no una personal
    const deCarol = await mkList(T.alice, { name: 'Otra compartida', kind: 'dynamic', shared: true });
    await admin.query(`UPDATE contact_lists SET owner_id = $1 WHERE id = $2`, [IDS.carol, deCarol.id]);
    expect((await call('PATCH', `/contact-lists/${deCarol.id}`, T.alice, { name: 'Renombrada por admin' })).status).toBe(200);
    await admin.query(`UPDATE contact_lists SET shared = false WHERE id = $1`, [deCarol.id]);
    expect((await call('PATCH', `/contact-lists/${deCarol.id}`, T.alice, { name: 'Ya no' })).status).toBe(404);
    // dejar de compartir
    expect((await json<List>(await call('PATCH', `/contact-lists/${compartida.id}`, T.alice, { shared: false }))).shared).toBe(false);
    expect((await lists(T.carol)).map((l) => l.name)).toEqual(['Renombrada por admin']); // solo queda la suya
    expect(await code(await call('PATCH', `/contact-lists/${deCarol.id}`, T.carol, { shared: true }))).toBe('LIST_SHARE_NOT_ALLOWED');
  });

  it('nombre único por dueño sin distinguir mayúsculas (otra persona puede repetirlo), tope de 100 listas por dueño y borrado lógico que no toca los contactos', async () => {
    await mkList(T.alice, { name: 'Pendientes', kind: 'dynamic' });
    const dup = await call('POST', '/contact-lists', T.alice, { name: 'pendientes', kind: 'fixed' });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('LIST_EXISTS');
    await mkList(T.carol, { name: 'Pendientes', kind: 'dynamic' });
    const l = await mkList(T.alice, { name: 'Otra', kind: 'dynamic' });
    expect(await code(await call('PATCH', `/contact-lists/${l.id}`, T.alice, { name: 'PENDIENTES' }))).toBe('LIST_EXISTS');
    const c = await mkContact(T.alice, { name: 'Ana' });
    const fija = await mkList(T.alice, { name: 'Fija', kind: 'fixed', contact_ids: [c.id] });
    expect((await call('DELETE', `/contact-lists/${fija.id}`, T.alice)).status).toBe(200);
    expect((await call('DELETE', `/contact-lists/${fija.id}`, T.alice)).status).toBe(404);
    expect((await call('GET', `/contacts${q(`list=${fija.id}`)}`, T.alice)).status).toBe(404);
    expect(names(await page(T.alice))).toEqual(['Ana']);
    await mkList(T.alice, { name: 'Fija', kind: 'fixed' }); // el nombre vuelve a estar libre
    for (let i = 0; i < 97; i++) await mkList(T.alice, { name: `Lista ${i}`, kind: 'dynamic' });
    const over = await call('POST', '/contact-lists', T.alice, { name: 'Una más', kind: 'dynamic' });
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('LIST_LIMIT');
    expect((await audits('contact_list', fija.id)).map((a) => a.field)).toContain(null);
  }, 60_000);

  it('aislamiento A↔B: B no ve ni usa ni cambia listas de A (404) y una fija de A no deja ver contactos de B', async () => {
    const ca = await mkContact(T.alice, { name: 'De A' });
    const cb = await mkContact(T.bob, { name: 'De B' });
    const la = await mkList(T.alice, { name: 'De A', kind: 'fixed', contact_ids: [ca.id], shared: true });
    expect((await lists(T.bob)).length).toBe(0);
    expect((await call('GET', `/contacts${q(`list=${la.id}`)}`, T.bob)).status).toBe(404);
    for (const [m, p, body] of [['PATCH', `/contact-lists/${la.id}`, { name: 'X' }], ['DELETE', `/contact-lists/${la.id}`, undefined], ['POST', `/contact-lists/${la.id}/members`, { contact_ids: [cb.id] }], ['POST', `/contact-lists/${la.id}/members/remove`, { contact_ids: [ca.id] }]] as const) {
      expect((await call(m, p, T.bob, body)).status, `${m} ${p}`).toBe(404);
    }
    // un contacto de B no entra en una lista de B por id de A, y un id de B no entra en una lista de A
    const lb = await mkList(T.bob, { name: 'De B', kind: 'fixed', contact_ids: [ca.id, cb.id] });
    expect(lb.member_count).toBe(1);
    expect(await json(await call('POST', `/contact-lists/${la.id}/members`, T.alice, { contact_ids: [cb.id] }))).toEqual({ added: 0, skipped: 1 });
    expect((await admin.query('SELECT count(*)::int AS n FROM contact_list_members WHERE list_id = $1', [la.id])).rows[0].n).toBe(1);
  });

  it('las listas se auditan (alta, cada cambio, miembros y borrado) con la marca de agencia cuando corresponde', async () => {
    const c = await mkContact(T.alice, { name: 'Ana' });
    const l = await mkList(T.alice, { name: 'Auditada', kind: 'fixed' });
    await call('PATCH', `/contact-lists/${l.id}`, T.alice, { name: 'Renombrada', columns: ['name', 'email'] });
    await call('POST', `/contact-lists/${l.id}/members`, T.alice, { contact_ids: [c.id] });
    await call('POST', `/contact-lists/${l.id}/members/remove`, T.alice, { contact_ids: [c.id] });
    await call('DELETE', `/contact-lists/${l.id}`, T.alice);
    expect((await audits('contact_list', l.id)).map((a) => a.field).sort((x, y) => String(x).localeCompare(String(y)))).toEqual(['columns', 'members_added', 'members_removed', 'name', null, null]);
    expect(await call('POST', '/context/switch', T.dave, { target: ORG_A }).then((r) => r.status)).toBe(200);
    const viaAgency = await mkList(T.dave, { name: 'De la agencia', kind: 'dynamic' });
    expect((await audits('contact_list', viaAgency.id))[0]!.acting_as).toBe('agency');
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

  it('DELETE solo en los dos pivotes (contact_tags, contact_list_members); ninguna otra tabla de negocio lo tiene y nadie vacía tablas; platform e identity no ven nada', async () => {
    for (const t of ['contact_tags', 'contact_list_members']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `rw DELETE ${t}`).resolves.toBeDefined();
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
    }
    for (const t of ['contact_lists', 'tags', 'contacts', 'meta_events']) await expect(as(info.rwUrl, `DELETE FROM ${t}`), `rw DELETE ${t}`).rejects.toThrow(/permission denied/);
    for (const t of ['contact_lists', 'contact_list_members', 'contact_tags', 'tags']) for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
  });

  it('las restricciones protegen la forma de los datos y las claves foráneas compuestas impiden cruzar empresas', async () => {
    const a = await mkContact(T.alice, { name: 'Ana' });
    const lb = await mkList(T.bob, { name: 'De B', kind: 'fixed' });
    const la = await mkList(T.alice, { name: 'De A', kind: 'fixed' });
    const bad = (sql: string) => admin.query(sql);
    const ins = (cols: string, vals: string) => `INSERT INTO contact_lists(organization_id, id, owner_id, ${cols}) VALUES ('${ORG_A}', gen_random_uuid(), '${IDS.alice}', ${vals})`;
    await expect(bad(ins('name, kind', "'  ', 'fixed'"))).rejects.toThrow(/contact_lists_name_shape/);
    await expect(bad(ins('name, kind', "'X', 'rara'"))).rejects.toThrow(/contact_lists_kind_valid/);
    await expect(bad(ins('name, kind, filters', `'X', 'dynamic', '[]'`))).rejects.toThrow(/contact_lists_filters_object/);
    await expect(bad(ins('name, kind, columns', `'X', 'dynamic', '{}'`))).rejects.toThrow(/contact_lists_columns_array/);
    await expect(bad(ins('name, kind, columns', `'X', 'dynamic', '[]'`))).rejects.toThrow(/contact_lists_columns_array/);
    await expect(bad(ins('name, kind', "'de a', 'fixed'"))).rejects.toThrow(/contact_lists_org_owner_name_uq/);
    await expect(bad(`INSERT INTO contact_list_members(organization_id, list_id, contact_id) VALUES ('${ORG_A}', '${lb.id}', '${a.id}')`)).rejects.toThrow(/contact_list_members_list_fk/); // lista de otra empresa
    await expect(bad(`INSERT INTO contact_list_members(organization_id, list_id, contact_id) VALUES ('${ORG_B}', '${la.id}', '${a.id}')`)).rejects.toThrow(/contact_list_members_list_fk/);
    await bad(`INSERT INTO contact_list_members(organization_id, list_id, contact_id) VALUES ('${ORG_A}', '${la.id}', '${a.id}')`);
    await expect(bad(`INSERT INTO contact_list_members(organization_id, list_id, contact_id) VALUES ('${ORG_A}', '${la.id}', '${a.id}')`)).rejects.toThrow(/contact_list_members_pk/);
  });

  it('la RLS: sin organización activa app_rw no ve listas; con la de A no ve las de B', async () => {
    await mkList(T.alice, { name: 'De A', kind: 'dynamic' });
    await mkList(T.bob, { name: 'De B', kind: 'dynamic' });
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      expect((await c.query('SELECT count(*)::int AS n FROM contact_lists')).rows[0].n).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query('SELECT name FROM contact_lists')).rows).toEqual([{ name: 'De A' }]);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
