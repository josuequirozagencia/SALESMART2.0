// M5.3 — Colas y reparto (ADR-07/ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/queues
//   POST /v1/queues
//   PATCH /v1/queues/:id
//   PUT /v1/queues/:id/members
//   DELETE /v1/queues/:id
//   POST /v1/queues/:id/simulate
//   POST /v1/queues/:id/distribute
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { ConversationsService, type NormalizedMessage } from '../../src/modules/conversations';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { MAX_QUEUES, QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  frank: 'f1000000-0000-4000-8000-0000000000f2', // asesor de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia, con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');
const T0 = 1_760_000_000;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'dave' | 'root', string>;
let channelA = '';
let channelB = '';
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE messages, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma', 'UTC'], [ORG_A, 'client', 'Barbería Norte', 'America/Guayaquil'], [ORG_B, 'client', 'Estudio Luna', 'UTC'], [AG1, 'agency', 'Agencia Uno', 'UTC']];
  for (const [id, kind, name, tz] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, tz]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.frank, 'frank@b.test', 'Franco Paz'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.eve, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.frank, ORG_B, 'advisor', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
  for (const [u, o, r, lv] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, lv]);
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};

interface Member { user_id: string; name: string; role: string; active: boolean; weight: number; open_count: number; today_count: number }
interface Queue { id: string; name: string; color: string; distribution_on: boolean; mode: string; batch: number; daily_cap: number; only_unassigned: boolean; members: Member[]; channels: Array<{ id: string; name: string }>; unassigned_count: number; updated_at: string }
interface Listing { items: Queue[]; limits: { max_queues: number } }
interface Sim { sequence: Array<{ user_id: string; name: string }>; counts: Array<{ user_id: string; name: string; count: number }>; stopped_early: boolean }

const mkQueue = async (name = 'Ventas', token = T.alice, over: Record<string, unknown> = {}): Promise<Queue> => ok<Queue>(await call('POST', '/queues', token, { name, ...over }), 201);
const getQueues = async (token = T.alice): Promise<Queue[]> => (await ok<Listing>(await call('GET', '/queues', token))).items;
const setMembers = async (id: string, members: Array<[string, boolean, number]>, token = T.alice): Promise<Queue> =>
  ok<Queue>(await call('PUT', `/queues/${id}/members`, token, { members: members.map(([user_id, active, weight]) => ({ user_id, active, weight })) }));
const patchQueue = async (id: string, body: Record<string, unknown>, token = T.alice): Promise<Queue> => ok<Queue>(await call('PATCH', `/queues/${id}`, token, body));
const link = async (channel: string, queue: string | null, token = T.alice) => ok(await call('PATCH', `/channels/${channel}`, token, { queue_id: queue }));
async function connect(token: string, phoneId: string, name: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
/** Una cola de A con reparto encendido, los asesores indicados y la conexión de A apuntando a ella. */
async function readyQueue(over: Record<string, unknown> = {}, who: Array<[string, boolean, number]> = [[IDS.alice, true, 1], [IDS.carol, true, 1], [IDS.eve, true, 1]]): Promise<Queue> {
  const q = await mkQueue('Ventas');
  await patchQueue(q.id, { distribution_on: true, ...over });
  const out = await setMembers(q.id, who);
  await link(channelA, q.id);
  return out;
}

// ── Mensajes entrantes (sin pasar por Meta): se prueba el reparto en sí ──────
const phone = (n: number): string => `+59398400${String(n).padStart(4, '0')}`;
function msg(from: string, id: string, ts = T0): NormalizedMessage {
  return { externalId: id, from, fromRaw: from.slice(1), profileName: null, kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date(ts * 1000) };
}
/** Entra un mensaje de `from` por la conexión indicada: exactamente lo que hace la tarea que procesa los avisos. */
async function ingest(from: string, id: string, o: { org?: string; channel?: string; ts?: number } = {}) {
  const org = o.org ?? ORG_A;
  return TenantContext.run({ organizationId: org }, async () => {
    const dir = await app.get(OrgDirectoryService).current({ fresh: true });
    const ctx = { now: new Date(), timeZone: dir.timeZone, assignable: dir.assignable };
    return app.get(Database).withTenant((tx) => app.get(ConversationsService).ingestInbound(tx, o.channel ?? channelA, msg(from, id, o.ts), ctx));
  });
}
interface ConvRow { id: string; contact_id: string; queue_id: string | null; owner_id: string | null; status: string; assigned_at: Date | null }
const convs = async (org = ORG_A): Promise<ConvRow[]> => (await admin.query('SELECT * FROM conversations WHERE organization_id = $1 ORDER BY created_at, id', [org])).rows as ConvRow[];
const owners = async (org = ORG_A): Promise<Array<string | null>> => (await convs(org)).map((c) => c.owner_id);
const who: Record<string, string> = { [IDS.alice]: 'A', [IDS.carol]: 'C', [IDS.eve]: 'E' };
const letters = async (): Promise<string> => (await owners()).map((o) => (o ? (who[o] ?? '?') : '-')).join('');
const audits = async (entityType: string, entityId?: string) => (await admin.query(`SELECT entity_id, field, old_value, new_value, source FROM audit_logs WHERE entity_type = $1 ${entityId ? `AND entity_id = '${entityId}'` : ''} ORDER BY at, id`, [entityType])).rows as Array<{ entity_id: string; field: string | null; old_value: unknown; new_value: unknown; source: string }>;
/** Conversaciones abiertas ya asignadas a alguien (la carga previa del asesor), insertadas directo. */
async function seedOpen(owner: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const c = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [ORG_A, `Previo ${owner.slice(0, 2)}${i}`])).rows[0].id as string;
    await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now())`, [ORG_A, c, channelA, owner]);
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte');
});

describe('permisos', () => {
  const routes = (id: string): Array<[string, string, unknown?]> => [['GET', '/queues'], ['POST', '/queues', { name: 'X' }], ['PATCH', `/queues/${id}`, { name: 'Y' }], ['PUT', `/queues/${id}/members`, { members: [] }], ['DELETE', `/queues/${id}`], ['POST', `/queues/${id}/simulate`, {}], ['POST', `/queues/${id}/distribute`]];

  it('sin sesión 401; la plataforma y el asesor 403 en todas las rutas', async () => {
    const q = await mkQueue();
    for (const [m, p, b] of routes(q.id)) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
  });

  it('una agencia con nivel «administrador» en ese cliente puede; con nivel «lectura» no', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    const q = await mkQueue('De la agencia', T.dave);
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    for (const [m, p, b] of routes(q.id)) expect((await call(m, p, T.dave, b)).status, `${m} ${p} lectura`).toBe(403);
  });
});

describe('colas', () => {
  it('se crea con valores por omisión seguros (reparto apagado, rotación, lote 1, sin tope, cartera primero) y todas las personas que pueden recibir trabajo, apagadas', async () => {
    const q = await mkQueue('Ventas', T.alice, { color: '#0B7A6B' });
    expect(q).toMatchObject({ name: 'Ventas', color: '#0b7a6b', distribution_on: false, mode: 'equal', batch: 1, daily_cap: 0, only_unassigned: true, channels: [], unassigned_count: 0 });
    expect(q.members.map((m) => [m.name, m.role, m.active, m.weight])).toEqual([['Alicia Torres', 'client_admin', false, 1], ['Carolina Vera', 'advisor', false, 1], ['Eva Mora', 'advisor', false, 1]]); // la agencia y la plataforma no reciben conversaciones
    const list = await ok<Listing>(await call('GET', '/queues', T.alice));
    expect(list.limits).toEqual({ max_queues: MAX_QUEUES });
    expect(list.items.map((x) => x.id)).toEqual([q.id]);
    expect((await mkQueue('Otra')).color).toBe('#7c5cfa');
    expect((await audits('queue', q.id)).map((a) => [a.field, a.source])).toEqual([[null, 'manual']]);
  });

  it('valida los datos y no admite campos desconocidos', async () => {
    const bad = async (b: Record<string, unknown>, label: string) => expect((await call('POST', '/queues', T.alice, b)).status, label).toBe(400);
    await bad({ name: '' }, 'sin nombre');
    await bad({ name: '   ' }, 'nombre en blanco');
    await bad({ name: 'x'.repeat(61) }, 'nombre largo');
    await bad({ name: 'a\u0007b' }, 'carácter de control');
    await bad({ name: 'Ok', color: 'rojo' }, 'color');
    await bad({ name: 'Ok', color: '#12345' }, 'color corto');
    await bad({ name: 'Ok', otro: 1 }, 'campo desconocido');
    await bad({}, 'vacío');
    expect(await getQueues()).toEqual([]);
  });

  it('el nombre es único sin distinguir mayúsculas entre las vigentes; una archivada libera el nombre', async () => {
    const q = await mkQueue('Ventas');
    const dup = await call('POST', '/queues', T.alice, { name: 'VENTAS' });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('QUEUE_EXISTS');
    const other = await mkQueue('Soporte');
    expect(await code(await call('PATCH', `/queues/${other.id}`, T.alice, { name: 'ventas' }))).toBe('QUEUE_EXISTS');
    await ok(await call('DELETE', `/queues/${q.id}`, T.alice));
    expect((await call('POST', '/queues', T.alice, { name: 'Ventas' })).status).toBe(201);
  });

  it(`hasta ${MAX_QUEUES} colas por empresa`, async () => {
    for (let i = 1; i <= MAX_QUEUES; i++) await admin.query(`INSERT INTO queues(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2)`, [ORG_A, `Cola ${i}`]);
    const over = await call('POST', '/queues', T.alice, { name: 'Una más' });
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('QUEUE_LIMIT');
    await admin.query(`UPDATE queues SET deleted_at = now() WHERE name = 'Cola 1'`); // archivar libera un lugar
    expect((await call('POST', '/queues', T.alice, { name: 'Una más' })).status).toBe(201);
  });

  it('edita la configuración y cada cambio queda en la auditoría con su valor anterior; sin cambios no escribe nada', async () => {
    const q = await mkQueue('Ventas');
    const u = await patchQueue(q.id, { name: 'Ventas 2', color: '#2B5BB8', distribution_on: true, mode: 'weighted', batch: 3, daily_cap: 20, only_unassigned: false });
    expect(u).toMatchObject({ name: 'Ventas 2', color: '#2b5bb8', distribution_on: true, mode: 'weighted', batch: 3, daily_cap: 20, only_unassigned: false });
    const a = (await audits('queue', q.id)).filter((x) => x.field !== null);
    expect(a.map((x) => [x.field, x.old_value, x.new_value])).toEqual([['name', 'Ventas', 'Ventas 2'], ['color', '#7c5cfa', '#2b5bb8'], ['distribution_on', false, true], ['mode', 'equal', 'weighted'], ['batch', 1, 3], ['daily_cap', 0, 20], ['only_unassigned', true, false]]);
    await patchQueue(q.id, { name: 'Ventas 2', batch: 3 });
    expect((await audits('queue', q.id)).length).toBe(a.length + 1); // la creación + los 7 cambios; el patch idéntico no suma
  });

  it('rechaza valores fuera de rango, un cuerpo vacío o un id que no existe', async () => {
    const q = await mkQueue();
    for (const b of [{}, { mode: 'azar' }, { batch: 0 }, { batch: 51 }, { batch: 1.5 }, { daily_cap: -1 }, { daily_cap: 1001 }, { distribution_on: 'si' }, { color: 'x' }, { weight: 3 }]) {
      expect((await call('PATCH', `/queues/${q.id}`, T.alice, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await call('PATCH', `/queues/${NOBODY}`, T.alice, { name: 'x' })).status).toBe(404);
    expect((await call('PATCH', '/queues/no-es-uuid', T.alice, { name: 'x' })).status).toBe(400);
  });

  it('archiva (borrado lógico): sale de la lista, una segunda vez es 404 y no se edita; no se puede mientras una conexión la use', async () => {
    const q = await mkQueue('Ventas');
    await link(channelA, q.id);
    const busy = await call('DELETE', `/queues/${q.id}`, T.alice);
    expect(busy.status).toBe(409);
    expect(await code(busy)).toBe('QUEUE_IN_USE');
    expect((await getQueues())[0]!.channels).toEqual([{ id: channelA, name: 'Ventas' }]);
    await link(channelA, null);
    expect(await ok(await call('DELETE', `/queues/${q.id}`, T.alice))).toEqual({ id: q.id, archived: true });
    expect(await getQueues()).toEqual([]);
    for (const [m, p, b] of [['DELETE', `/queues/${q.id}`], ['PATCH', `/queues/${q.id}`, { name: 'x' }], ['PUT', `/queues/${q.id}/members`, { members: [] }], ['POST', `/queues/${q.id}/simulate`, {}], ['POST', `/queues/${q.id}/distribute`]] as const) {
      expect((await call(m, p, T.alice, b)).status, `${m} ${p}`).toBe(404);
    }
    expect((await admin.query('SELECT deleted_at FROM queues WHERE id = $1', [q.id])).rows[0].deleted_at).not.toBeNull(); // sigue en la base
    expect((await audits('queue', q.id)).at(-1)).toMatchObject({ field: 'archived', new_value: true });
  });
});

describe('asesores de la cola', () => {
  it('guarda quién participa y con qué peso; quien no aparece y tenía fila queda apagado; repetir lo mismo no cambia nada', async () => {
    const q = await mkQueue();
    const r = await setMembers(q.id, [[IDS.alice, true, 3], [IDS.carol, false, 2]]);
    expect(r.members.map((m) => [m.name, m.active, m.weight])).toEqual([['Alicia Torres', true, 3], ['Carolina Vera', false, 2], ['Eva Mora', false, 1]]);
    const before = (await audits('queue', q.id)).length;
    await setMembers(q.id, [[IDS.alice, true, 3], [IDS.carol, false, 2]]);
    expect((await audits('queue', q.id)).length).toBe(before); // sin cambios: sin auditoría nueva
    const r2 = await setMembers(q.id, [[IDS.alice, true, 3], [IDS.eve, true, 5]]); // carol tenía fila apagada; eve entra
    expect(r2.members.map((m) => [m.name, m.active, m.weight])).toEqual([['Alicia Torres', true, 3], ['Carolina Vera', false, 2], ['Eva Mora', true, 5]]);
    const r3 = await setMembers(q.id, [[IDS.carol, true, 1]]); // alice y eve tenían fila activa y no aparecen: se apagan
    expect(r3.members.map((m) => [m.name, m.active])).toEqual([['Alicia Torres', false], ['Carolina Vera', true], ['Eva Mora', false]]);
    expect((await audits('queue', q.id)).filter((a) => a.field === 'members')).toHaveLength(3);
  });

  it('solo personas que pueden recibir conversaciones en ESTA empresa; duplicados y pesos fuera de rango se rechazan', async () => {
    const q = await mkQueue();
    const put = (members: unknown[]) => call('PUT', `/queues/${q.id}/members`, T.alice, { members });
    const a = (u: string, active = true, weight = 1) => ({ user_id: u, active, weight });
    for (const [label, body] of [['de otra empresa', [a(IDS.bob)]], ['de la agencia', [a(IDS.dave)]], ['de la plataforma', [a(IDS.root)]], ['inexistente', [a(NOBODY)]], ['repetida', [a(IDS.alice), a(IDS.alice, false)]], ['peso 0', [a(IDS.alice, true, 0)]], ['peso 101', [a(IDS.alice, true, 101)]], ['peso decimal', [a(IDS.alice, true, 1.5)]], ['activa no booleano', [{ user_id: IDS.alice, active: 'si', weight: 1 }]], ['campo extra', [{ ...a(IDS.alice), extra: 1 }]]] as const) {
      expect((await put([...body])).status, label).toBe(400);
    }
    const invalid = await call('PUT', `/queues/${q.id}/members`, T.alice, { members: [a(IDS.bob)] });
    expect(((await json<{ error: { details: Array<{ path: string; code: string }> } }>(invalid)).error.details[0])).toMatchObject({ path: 'members.0.user_id', code: 'invalid_member' });
    expect((await call('PUT', `/queues/${q.id}/members`, T.alice, { members: [], otro: 1 })).status).toBe(400);
    expect((await getQueues())[0]!.members.every((m) => !m.active)).toBe(true); // nada se guardó
  });

  it('una persona que dejó la empresa deja de aparecer en la lista', async () => {
    const q = await mkQueue();
    await setMembers(q.id, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1 AND organization_id = $2`, [IDS.carol, ORG_A]);
    expect((await getQueues())[0]!.members.map((m) => m.name)).toEqual(['Alicia Torres', 'Eva Mora']);
  });
});

describe('conexiones y colas', () => {
  it('una conexión se enlaza a su cola por defecto (al editar o al crear) y se desvincula con null; la lista de la cola muestra sus conexiones', async () => {
    const q = await mkQueue('Ventas');
    const c = await ok<{ queue_id: string | null }>(await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: q.id }));
    expect(c.queue_id).toBe(q.id);
    expect((await getQueues())[0]!.channels).toEqual([{ id: channelA, name: 'Ventas' }]);
    const created = await ok<{ id: string; queue_id: string | null }>(await call('POST', '/channels', T.alice, { name: 'Segunda', waba_id: '1234567890123', phone_number_id: '1090123456711', access_token: FAKE_WHATSAPP_TOKEN, queue_id: q.id }), 201);
    expect(created.queue_id).toBe(q.id);
    expect((await ok<{ items: Array<{ id: string; queue_id: string | null }> }>(await call('GET', '/channels', T.alice))).items.map((x) => x.queue_id)).toEqual([q.id, q.id]);
    expect((await ok<{ queue_id: string | null }>(await call('PATCH', `/channels/${created.id}`, T.alice, { queue_id: null }))).queue_id).toBeNull();
    expect((await audits('channel', channelA)).map((a) => [a.field, a.new_value])).toContainEqual(['queue_id', q.id]);
  });

  it('no se puede enlazar a una cola que no existe, está archivada o es de otra empresa (400, sin distinguir)', async () => {
    const mine = await mkQueue('Mía');
    const theirs = await mkQueue('Suya', T.bob);
    await ok(await call('DELETE', `/queues/${mine.id}`, T.alice));
    for (const id of [NOBODY, mine.id, theirs.id]) {
      const r = await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: id });
      expect(r.status, id).toBe(400);
      expect(await code(r)).toBe('CHANNEL_QUEUE_NOT_FOUND');
    }
    const r = await call('POST', '/channels', T.alice, { name: 'X', waba_id: '1234567890123', phone_number_id: '1090123456722', access_token: FAKE_WHATSAPP_TOKEN, queue_id: theirs.id });
    expect(r.status).toBe(400);
    expect((await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: 'no-uuid' })).status).toBe(400);
  });
});

describe('simulación', () => {
  it('muestra el orden y el reparto con lo guardado, sin guardar nada ni tocar el estado', async () => {
    const q = await readyQueue({}, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    const s = await ok<Sim>(await call('POST', `/queues/${q.id}/simulate`, T.alice, { count: 6 }));
    expect(s.sequence.map((x) => x.name)).toEqual(['Alicia Torres', 'Carolina Vera', 'Alicia Torres', 'Carolina Vera', 'Alicia Torres', 'Carolina Vera']);
    expect(s.counts.map((x) => [x.name, x.count])).toEqual([['Alicia Torres', 3], ['Carolina Vera', 3]]);
    expect(s.stopped_early).toBe(false);
    expect((await call('POST', `/queues/${q.id}/simulate`, T.alice, {})).status).toBe(200); // 20 por omisión
    expect((await admin.query('SELECT count(*)::int AS n FROM queue_distribution_state')).rows[0].n).toBe(0);
    expect((await audits('queue', q.id)).every((a) => a.field !== 'simulate')).toBe(true);
  });

  it('prueba cambios sin guardarlos: modo ponderado, lote, tope y otro grupo de asesores', async () => {
    const q = await readyQueue({}, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    const w = await ok<Sim>(await call('POST', `/queues/${q.id}/simulate`, T.alice, { count: 8, mode: 'weighted', members: [{ user_id: IDS.alice, active: true, weight: 3 }, { user_id: IDS.carol, active: true, weight: 1 }] }));
    expect(w.counts.map((x) => [x.name, x.count])).toEqual([['Alicia Torres', 6], ['Carolina Vera', 2]]);
    const b = await ok<Sim>(await call('POST', `/queues/${q.id}/simulate`, T.alice, { count: 6, batch: 3 }));
    expect(b.sequence.map((x) => x.name[0]).join('')).toBe('AAACCC');
    const cap = await ok<Sim>(await call('POST', `/queues/${q.id}/simulate`, T.alice, { count: 10, daily_cap: 2 }));
    expect(cap.sequence).toHaveLength(4);
    expect(cap.stopped_early).toBe(true);
    const eve = await ok<Sim>(await call('POST', `/queues/${q.id}/simulate`, T.alice, { count: 3, members: [{ user_id: IDS.eve, active: true, weight: 1 }, { user_id: IDS.carol, active: false, weight: 1 }] }));
    expect(eve.sequence.map((x) => x.name)).toEqual(['Eva Mora', 'Eva Mora', 'Eva Mora']); // solo cuentan los activos
    expect((await getQueues())[0]).toMatchObject({ mode: 'equal', batch: 1, daily_cap: 0 }); // nada cambió
    expect((await getQueues())[0]!.members.filter((m) => m.active).map((m) => m.name)).toEqual(['Alicia Torres', 'Carolina Vera']);
  });

  it('sin asesores activos no hay a quién asignar; el tamaño de la simulación está acotado', async () => {
    const q = await mkQueue();
    const s = await ok<Sim>(await call('POST', `/queues/${q.id}/simulate`, T.alice, { count: 5 }));
    expect(s).toEqual({ sequence: [], counts: [], stopped_early: true });
    for (const b of [{ count: 0 }, { count: 101 }, { count: 1.5 }, { mode: 'x' }, { members: [{ user_id: IDS.alice, active: true, weight: 0 }] }, { otro: 1 }]) {
      expect((await call('POST', `/queues/${q.id}/simulate`, T.alice, b)).status, JSON.stringify(b)).toBe(400);
    }
  });
});

describe('asignar al llegar un mensaje', () => {
  it('rotación: cada conversación nueva va al siguiente asesor, queda «pendiente» con su dueño, la cola y la hora de asignación; el contacto queda en su cartera', async () => {
    const q = await readyQueue();
    for (let i = 1; i <= 6; i++) await ingest(phone(i), `wamid.${i}`);
    expect(await letters()).toBe('ACEACE'); // por id: alice, carol, eve
    const rows = await convs();
    expect(rows.every((r) => r.status === 'pending' && r.queue_id === q.id && r.assigned_at !== null)).toBe(true);
    const contactOwners = (await admin.query('SELECT owner_id FROM contacts WHERE organization_id = $1 ORDER BY created_at', [ORG_A])).rows.map((r) => r.owner_id);
    expect(contactOwners).toEqual(rows.map((r) => r.owner_id)); // el primer reparto forma la cartera del contacto
    const state = (await admin.query('SELECT state FROM queue_distribution_state WHERE queue_id = $1', [q.id])).rows[0].state as { last: string };
    expect(state.last).toBe(IDS.eve);
    // auditoría automática de la conversación y del dueño del contacto
    const ca = await audits('conversation');
    expect(ca.filter((a) => a.field === 'owner_id').map((a) => a.source)).toEqual(Array(6).fill('automation'));
    expect((await audits('contact')).filter((a) => a.field === 'owner_id' && a.source === 'automation')).toHaveLength(6);
  });

  it('con «leads seguidos» cada asesor recibe su lote seguido', async () => {
    await readyQueue({ batch: 2 });
    for (let i = 1; i <= 6; i++) await ingest(phone(i), `wamid.${i}`);
    expect(await letters()).toBe('AACCEE');
  });

  it('ponderado: más peso, más conversaciones, mezcladas a lo largo del ciclo', async () => {
    await readyQueue({ mode: 'weighted' }, [[IDS.alice, true, 3], [IDS.carol, true, 1]]);
    for (let i = 1; i <= 8; i++) await ingest(phone(i), `wamid.${i}`);
    expect(await letters()).toBe('AACAAACA');
  });

  it('menos conversaciones abiertas: parte de la carga real de cada asesor', async () => {
    await readyQueue({ mode: 'load' });
    await seedOpen(IDS.alice, 2);
    await seedOpen(IDS.eve, 1);
    for (let i = 1; i <= 4; i++) await ingest(phone(i), `wamid.${i}`);
    const mine = (await owners()).slice(3); // las 3 previas son las sembradas
    expect(mine.map((o) => who[o ?? ''])).toEqual(['C', 'E', 'C', 'E']);
  });

  it('tope diario por asesor: al llegar al tope no recibe más; si nadie puede, queda «sin asignar» (con su cola); subir el tope y repartir ahora la asigna', async () => {
    const q = await readyQueue({ daily_cap: 1 }, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    for (let i = 1; i <= 3; i++) await ingest(phone(i), `wamid.${i}`);
    expect(await letters()).toBe('AC-');
    const third = (await convs())[2]!;
    expect(third).toMatchObject({ status: 'unassigned', owner_id: null, queue_id: q.id, assigned_at: null });
    const list = (await getQueues())[0]!;
    expect(list.unassigned_count).toBe(1);
    expect(list.members.map((m) => [m.name, m.today_count, m.open_count])).toEqual([['Alicia Torres', 1, 1], ['Carolina Vera', 1, 1], ['Eva Mora', 0, 0]]);
    await patchQueue(q.id, { daily_cap: 2 });
    expect(await ok(await call('POST', `/queues/${q.id}/distribute`, T.alice))).toEqual({ assigned: 1, remaining: 0 });
    expect(await letters()).toBe('ACA');
    expect((await convs())[2]).toMatchObject({ status: 'pending' });
  });

  it('el tope cuenta desde la medianoche de la empresa (Guayaquil, UTC−5), no desde la medianoche UTC', async () => {
    const q = await readyQueue({ daily_cap: 1 }, [[IDS.alice, true, 1]]);
    await ingest(phone(1), 'wamid.1');
    // «Ayer» en Guayaquil: hace 25 horas
    await admin.query(`UPDATE conversations SET assigned_at = now() - interval '25 hours' WHERE organization_id = $1`, [ORG_A]);
    await ingest(phone(2), 'wamid.2'); // alice ya no tiene nada «hoy»: puede recibir
    expect(await letters()).toBe('AA');
    const mine = (await getQueues())[0]!.members.find((m) => m.user_id === IDS.alice)!;
    expect(mine.today_count).toBe(1);
    expect(q.daily_cap).toBe(1);
  });

  it('cartera primero: si el contacto ya tiene dueño que puede recibir trabajo, va a él y NO consume el turno del reparto', async () => {
    await readyQueue();
    expect((await call('POST', '/contacts', T.alice, { name: 'Cliente de Carol', phones: [phone(9)], owner_id: IDS.carol })).status).toBe(201);
    await ingest(phone(9), 'wamid.9');
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(2), 'wamid.2');
    expect(await letters()).toBe('CAC'); // Carol por su cartera; el reparto arranca por Alicia, y luego Carolina
    expect((await admin.query(`SELECT owner_id FROM contacts WHERE name = 'Cliente de Carol'`)).rows[0].owner_id).toBe(IDS.carol);
  });

  it('con «solo contactos no asignados» apagado, el contacto con dueño entra al reparto y su dueño NO cambia', async () => {
    await readyQueue({ only_unassigned: false });
    await call('POST', '/contacts', T.alice, { name: 'Cliente de Carol', phones: [phone(9)], owner_id: IDS.carol });
    await ingest(phone(9), 'wamid.9');
    expect(await letters()).toBe('A'); // el reparto elige a Alicia
    expect((await admin.query(`SELECT owner_id FROM contacts WHERE name = 'Cliente de Carol'`)).rows[0].owner_id).toBe(IDS.carol);
  });

  it('si el dueño del contacto ya no puede recibir trabajo (dejó la empresa), la conversación entra al reparto', async () => {
    await readyQueue({}, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    await call('POST', '/contacts', T.alice, { name: 'Cliente de Carol', phones: [phone(9)], owner_id: IDS.carol });
    await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1 AND organization_id = $2`, [IDS.carol, ORG_A]);
    await ingest(phone(9), 'wamid.9');
    expect(await letters()).toBe('A');
  });

  it('quien dejó la empresa no recibe conversaciones aunque siga activo en la cola', async () => {
    await readyQueue({}, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1 AND organization_id = $2`, [IDS.carol, ORG_A]);
    for (let i = 1; i <= 3; i++) await ingest(phone(i), `wamid.${i}`);
    expect(await letters()).toBe('AAA');
  });

  it('reparto apagado, conexión sin cola o cola archivada: la conversación queda «sin asignar» y el contacto sin dueño', async () => {
    const q = await mkQueue('Ventas');
    await setMembers(q.id, [[IDS.alice, true, 1]]);
    await link(channelA, q.id); // reparto apagado
    await ingest(phone(1), 'wamid.1');
    await link(channelA, null); // sin cola
    await ingest(phone(2), 'wamid.2');
    expect((await convs()).map((c) => [c.status, c.queue_id])).toEqual([['unassigned', q.id], ['unassigned', null]]);
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts WHERE owner_id IS NOT NULL')).rows[0].n).toBe(0);
    await patchQueue(q.id, { distribution_on: true });
    await link(channelA, q.id);
    await ok(await call('POST', `/queues/${q.id}/distribute`, T.alice));
    await link(channelA, null);
    await ok(await call('DELETE', `/queues/${q.id}`, T.alice)); // archivada, con conversaciones antiguas que la nombran
    await link(channelA, null);
    await ingest(phone(3), 'wamid.3');
    expect((await convs()).at(-1)).toMatchObject({ status: 'unassigned', owner_id: null });
  });

  it('un mensaje nuevo en una conversación ya asignada no la reasigna ni toca el reparto; si estaba «sin asignar», se reparte en cuanto hay a quién', async () => {
    const q = await mkQueue('Ventas');
    await link(channelA, q.id); // reparto apagado y sin asesores
    await ingest(phone(1), 'wamid.1a');
    expect((await convs())[0]!.status).toBe('unassigned');
    await patchQueue(q.id, { distribution_on: true });
    await setMembers(q.id, [[IDS.carol, true, 1], [IDS.eve, true, 1]]);
    await ingest(phone(1), 'wamid.1b'); // el mismo contacto vuelve a escribir
    expect(await letters()).toBe('C');
    await ingest(phone(1), 'wamid.1c');
    await ingest(phone(1), 'wamid.1d');
    expect(await letters()).toBe('C'); // sigue con Carolina
    expect((await admin.query(`SELECT unread_count FROM conversations WHERE organization_id = $1`, [ORG_A])).rows[0].unread_count).toBe(4);
    await ingest(phone(2), 'wamid.2');
    expect(await letters()).toBe('CE'); // y el turno siguió su curso
  });

  it('un mensaje repetido no reparte dos veces', async () => {
    await readyQueue();
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(2), 'wamid.2');
    expect(await letters()).toBe('AC');
  });

  it('concurrencia: varias conversaciones a la vez en la misma cola se reparten sin repetir turno', async () => {
    const q = await readyQueue();
    await Promise.all(Array.from({ length: 9 }, (_, i) => ingest(phone(i + 1), `wamid.${i + 1}`)));
    const counts = Object.fromEntries((await owners()).reduce((m, o) => m.set(o!, (m.get(o!) ?? 0) + 1), new Map<string, number>()));
    expect(counts).toEqual({ [IDS.alice]: 3, [IDS.carol]: 3, [IDS.eve]: 3 });
    expect((await admin.query('SELECT count(*)::int AS n FROM queue_distribution_state WHERE queue_id = $1', [q.id])).rows[0].n).toBe(1);
  });

  it('los chats de otra empresa nunca se reparten con los asesores de esta (y viceversa)', async () => {
    await readyQueue({}, [[IDS.alice, true, 1]]);
    const qb = await mkQueue('Soporte', T.bob);
    await patchQueue(qb.id, { distribution_on: true }, T.bob);
    await setMembers(qb.id, [[IDS.frank, true, 1]], T.bob);
    await link(channelB, qb.id, T.bob);
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(1), 'wamid.2', { org: ORG_B, channel: channelB }); // el mismo teléfono escribe a las dos empresas
    expect(await owners(ORG_A)).toEqual([IDS.alice]);
    expect(await owners(ORG_B)).toEqual([IDS.frank]);
  });
});

describe('repartir ahora los «sin asignar»', () => {
  it('reparte los que esperan (también los de una conexión que recibió cola después), los más antiguos primero, y dice cuántos quedan', async () => {
    const q = await mkQueue('Ventas');
    await setMembers(q.id, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    await ingest(phone(1), 'wamid.1'); // sin cola todavía
    await link(channelA, q.id); // reparto apagado
    await ingest(phone(2), 'wamid.2', { ts: T0 + 10 });
    await ingest(phone(3), 'wamid.3', { ts: T0 + 20 });
    expect((await getQueues())[0]!.unassigned_count).toBe(3); // cuenta también la que no tenía cola pero cuya conexión ahora sí
    const off = await call('POST', `/queues/${q.id}/distribute`, T.alice);
    expect(off.status).toBe(409);
    expect(await code(off)).toBe('QUEUE_DISTRIBUTION_OFF');
    await patchQueue(q.id, { distribution_on: true });
    expect(await letters()).toBe('---'); // encender el reparto NO reasigna chats antiguos por sorpresa
    expect(await ok(await call('POST', `/queues/${q.id}/distribute`, T.alice))).toEqual({ assigned: 3, remaining: 0 });
    expect(await letters()).toBe('ACA'); // por antigüedad de su último mensaje
    expect((await convs()).every((c) => c.queue_id === q.id && c.status === 'pending')).toBe(true);
    expect(await ok(await call('POST', `/queues/${q.id}/distribute`, T.alice))).toEqual({ assigned: 0, remaining: 0 });
  });

  it('se detiene cuando nadie puede recibir más y deja el resto «sin asignar»', async () => {
    const q = await readyQueue({}, [[IDS.alice, true, 1]]);
    await patchQueue(q.id, { distribution_on: false });
    for (let i = 1; i <= 4; i++) await ingest(phone(i), `wamid.${i}`);
    await patchQueue(q.id, { distribution_on: true, daily_cap: 2 });
    expect(await ok(await call('POST', `/queues/${q.id}/distribute`, T.alice))).toEqual({ assigned: 2, remaining: 2 });
  });
});

describe('aislamiento A↔B', () => {
  it('B no ve ni cambia las colas de A (404) y cada empresa lista solo las suyas', async () => {
    const a = await mkQueue('De A');
    const b = await mkQueue('De B', T.bob);
    expect((await getQueues()).map((q) => q.id)).toEqual([a.id]);
    expect((await getQueues(T.bob)).map((q) => q.id)).toEqual([b.id]);
    for (const [m, p, body] of [['PATCH', `/queues/${a.id}`, { name: 'Robada' }], ['PUT', `/queues/${a.id}/members`, { members: [] }], ['DELETE', `/queues/${a.id}`], ['POST', `/queues/${a.id}/simulate`, {}], ['POST', `/queues/${a.id}/distribute`]] as const) {
      expect((await call(m, p, T.bob, body)).status, `${m} ${p}`).toBe(404);
    }
    expect((await getQueues())[0]!.name).toBe('De A');
    // los asesores de B tampoco pueden entrar a una cola de A, ni al revés
    expect((await call('PUT', `/queues/${b.id}/members`, T.bob, { members: [{ user_id: IDS.carol, active: true, weight: 1 }] })).status).toBe(400);
    expect((await call('PUT', `/queues/${a.id}/members`, T.alice, { members: [{ user_id: IDS.frank, active: true, weight: 1 }] })).status).toBe(400);
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

  it('solo app_rw toca estas tablas, y sin DELETE ni TRUNCATE (una cola se archiva; a un asesor se le apaga)', async () => {
    for (const t of ['queues', 'queue_members', 'queue_distribution_state']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `DELETE ${t}`).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });

  it('las restricciones protegen la forma de los datos y las claves foráneas impiden cruzar empresas', async () => {
    const qa = await mkQueue('De A');
    const qb = await mkQueue('De B', T.bob);
    const sql = (text: string, params: unknown[] = []) => admin.query(text, params);
    const q = (cols: string, vals: string) => `INSERT INTO queues(id, organization_id, name, ${cols}) VALUES (gen_random_uuid(), '${ORG_A}', 'N ${Math.random()}', ${vals})`;
    await expect(sql(`INSERT INTO queues(id, organization_id, name) VALUES (gen_random_uuid(), '${ORG_A}', '   ')`)).rejects.toThrow(/queues_name_shape/);
    await expect(sql(q('color', `'rojo'`))).rejects.toThrow(/queues_color_shape/);
    await expect(sql(q('mode', `'azar'`))).rejects.toThrow(/queues_mode_valid/);
    await expect(sql(q('batch', '0'))).rejects.toThrow(/queues_batch_valid/);
    await expect(sql(q('daily_cap', '-1'))).rejects.toThrow(/queues_cap_valid/);
    await expect(sql(`INSERT INTO queue_members(organization_id, queue_id, user_id, weight) VALUES ('${ORG_A}', '${qa.id}', '${IDS.alice}', 0)`)).rejects.toThrow(/queue_members_weight_valid/);
    await expect(sql(`INSERT INTO queue_members(organization_id, queue_id, user_id) VALUES ('${ORG_B}', '${qa.id}', '${IDS.frank}')`)).rejects.toThrow(/queue_members_queue_fk/); // cola de otra empresa
    await expect(sql(`INSERT INTO queue_members(organization_id, queue_id, user_id) VALUES ('${ORG_A}', '${qa.id}', '${NOBODY}')`)).rejects.toThrow(/queue_members_user_id_users_id_fk/);
    await expect(sql(`UPDATE channel_accounts SET queue_id = $1 WHERE id = $2`, [qb.id, channelA])).rejects.toThrow(/channel_accounts_queue_fk/); // conexión de A con cola de B
    // coherencia de las conversaciones
    await ingest(phone(1), 'wamid.1');
    const conv = (await convs())[0]!;
    await expect(sql(`UPDATE conversations SET status = 'pending' WHERE id = $1`, [conv.id])).rejects.toThrow(/conversations_owner_status/); // pendiente sin dueño
    await expect(sql(`UPDATE conversations SET owner_id = $2, assigned_at = now() WHERE id = $1`, [conv.id, IDS.alice])).rejects.toThrow(/conversations_owner_status/); // dueño pero «sin asignar»
    await expect(sql(`UPDATE conversations SET owner_id = $2, status = 'pending' WHERE id = $1`, [conv.id, IDS.alice])).rejects.toThrow(/conversations_assigned_pair/); // dueño sin hora de asignación
    await expect(sql(`UPDATE conversations SET queue_id = $2 WHERE id = $1`, [conv.id, qb.id])).rejects.toThrow(/conversations_queue_fk/);
    await expect(sql(`UPDATE conversations SET status = 'closed' WHERE id = $1`, [conv.id])).resolves.toBeDefined(); // cerrada: con o sin dueño
  });

  it('RLS: sin empresa activa app_rw no ve nada; con la de A no ve lo de B', async () => {
    const qa = await mkQueue('De A');
    await mkQueue('De B', T.bob);
    await setMembers(qa.id, [[IDS.alice, true, 1]]);
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const t of ['queues', 'queue_members']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query(`SELECT count(*)::int AS n FROM queues`)).rows[0].n).toBe(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM queue_members`)).rows[0].n).toBe(1);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
