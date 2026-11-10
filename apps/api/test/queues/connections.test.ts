// v7 fase B — El departamento elige sus conexiones (ADR-65). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   PUT /v1/queues/:id/connections
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
import { QueuesModule } from '../../src/modules/queues';
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


// ═════════════════════════════════════════════════════════════════════════════
/** Una conexión por QR en la empresa (solo la fila de `channel_accounts`: el departamento vive ahí; no hace falta Evolution). */
async function mkQr(org: string, name: string, queue: string | null = null): Promise<string> {
  return (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, is_official, name, queue_id) VALUES (gen_random_uuid(), $1, 'evolution', false, $2, $3) RETURNING id`, [org, name, queue])).rows[0].id as string;
}
const chanQueue = async (id: string): Promise<string | null> => (await admin.query('SELECT queue_id FROM channel_accounts WHERE id = $1', [id])).rows[0].queue_id as string | null;
interface Conn { id: string; name: string; kind: 'channel' | 'qr' }
interface QueueWithConns { id: string; channels: Conn[] }
const put = (queue: string, body: unknown, token = T.alice) => call('PUT', `/queues/${queue}/connections`, token, body);
const set = async (queue: string, connections: Array<[string, 'channel' | 'qr']>, extra: Record<string, unknown> = {}, token = T.alice): Promise<QueueWithConns> =>
  ok<QueueWithConns>(await put(queue, { connections: connections.map(([id, kind]) => ({ kind, id })), ...extra }, token));
const connAudits = async (): Promise<Array<{ entity_id: string; field: string; old_value: unknown; new_value: unknown; source: string }>> =>
  (await admin.query(`SELECT entity_id, field, old_value, new_value, source FROM audit_logs WHERE entity_type = 'channel' AND field = 'queue_id' ORDER BY at, id`)).rows;

describe('permisos y aislamiento', () => {
  it('sin sesión 401; la plataforma y el asesor 403', async () => {
    const q = await mkQueue();
    const body = { connections: [] };
    expect((await call('PUT', `/queues/${q.id}/connections`, undefined, body)).status).toBe(401);
    expect((await put(q.id, body, T.root)).status).toBe(403);
    expect((await put(q.id, body, T.carol)).status).toBe(403);
  });

  it('una agencia con nivel «administrador» puede; con «lectura» no', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    const q = await mkQueue('De la agencia', T.dave);
    await set(q.id, [[channelA, 'channel']], {}, T.dave);
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await put(q.id, { connections: [] }, T.dave)).status).toBe(403);
  });

  it('A↔B: una conexión de otra empresa responde 404 igual que una que no existe, sin cambiar nada; y un departamento de otra empresa es 404', async () => {
    const qa = await mkQueue('Ventas A');
    const qb = await mkQueue('Soporte B', T.bob);
    const other = await put(qa.id, { connections: [{ kind: 'channel', id: channelB }] });
    const ghost = await put(qa.id, { connections: [{ kind: 'channel', id: NOBODY }] });
    expect(other.status).toBe(404);
    expect(ghost.status).toBe(404);
    const strip = (j: { error: { code: string; message: string } }) => ({ code: j.error.code, message: j.error.message });
    expect(strip(await other.json() as never)).toEqual(strip(await ghost.json() as never));
    expect(await chanQueue(channelB)).toBeNull();
    // el departamento de B no se toca desde A, ni al revés
    expect((await put(qb.id, { connections: [{ kind: 'channel', id: channelA }] })).status).toBe(404);
    expect((await put(qa.id, { connections: [{ kind: 'channel', id: channelA }] }, T.bob)).status).toBe(404);
    expect(await chanQueue(channelA)).toBeNull();
    // un destino de la otra empresa no existe para esta
    await set(qa.id, [[channelA, 'channel']]);
    const r = await put(qa.id, { connections: [], move_removed_to: qb.id });
    expect(r.status).toBe(400);
    expect(await code(r)).toBe('CHANNEL_QUEUE_NOT_FOUND');
    expect(await chanQueue(channelA)).toBe(qa.id);
  });
});

describe('el conjunto de conexiones', () => {
  it('asigna oficiales y QR, devuelve el departamento con su lista (con tipo) y audita cada conexión', async () => {
    const q = await mkQueue('Ventas');
    const qr = await mkQr(ORG_A, 'Chip de ventas');
    const out = await set(q.id, [[channelA, 'channel'], [qr, 'qr']]);
    expect(out.channels.map((c) => `${c.kind}:${c.id}`).sort()).toEqual([`channel:${channelA}`, `qr:${qr}`].sort());
    expect(await chanQueue(channelA)).toBe(q.id);
    expect(await chanQueue(qr)).toBe(q.id);
    const a = await connAudits();
    expect(a).toHaveLength(2);
    expect(a.every((x) => x.source === 'manual' && x.old_value === null && x.new_value === q.id)).toBe(true);
    expect(new Set(a.map((x) => x.entity_id))).toEqual(new Set([channelA, qr]));
    // repetir lo mismo no cambia ni audita nada
    await set(q.id, [[channelA, 'channel'], [qr, 'qr']]);
    expect(await connAudits()).toHaveLength(2);
  });

  it('una conexión que está en otro departamento se mueve aquí (y el otro la pierde), con la auditoría del cambio', async () => {
    const q1 = await mkQueue('Ventas');
    const q2 = await mkQueue('Soporte');
    await set(q2.id, [[channelA, 'channel']]);
    const out = await set(q1.id, [[channelA, 'channel']]);
    expect(out.channels.map((c) => c.id)).toEqual([channelA]);
    expect((await getQueues()).find((x) => x.id === q2.id)!.channels).toEqual([]);
    const last = (await connAudits()).at(-1)!;
    expect(last).toMatchObject({ entity_id: channelA, old_value: q2.id, new_value: q1.id, source: 'manual' });
  });

  it('las que salen necesitan destino: sin él 400 DESTINATION_REQUIRED y nada cambia; con «allow_unassigned» quedan sin departamento; con destino pasan a él', async () => {
    const q1 = await mkQueue('Ventas');
    const q2 = await mkQueue('Soporte');
    const qr = await mkQr(ORG_A, 'Chip');
    await set(q1.id, [[channelA, 'channel'], [qr, 'qr']]);
    const noDest = await put(q1.id, { connections: [{ kind: 'channel', id: channelA }] });
    expect(noDest.status).toBe(400);
    expect(await code(noDest)).toBe('DESTINATION_REQUIRED');
    expect(await chanQueue(qr)).toBe(q1.id);
    const same = await put(q1.id, { connections: [{ kind: 'channel', id: channelA }], move_removed_to: q1.id });
    expect(same.status).toBe(400);
    expect(await code(same)).toBe('DESTINATION_SAME');
    const out = await set(q1.id, [[channelA, 'channel']], { move_removed_to: q2.id });
    expect(out.channels.map((c) => c.id)).toEqual([channelA]);
    expect(await chanQueue(qr)).toBe(q2.id);
    // sin salidas el destino no hace falta
    await set(q1.id, [[channelA, 'channel']]);
    // dejarla sin departamento solo con la confirmación explícita
    await set(q2.id, [], { allow_unassigned: true });
    expect(await chanQueue(qr)).toBeNull();
  });

  it('un destino archivado o inexistente es 400 y no se mueve nada', async () => {
    const q1 = await mkQueue('Ventas');
    const q2 = await mkQueue('Soporte');
    await set(q1.id, [[channelA, 'channel']]);
    ok(await call('DELETE', `/queues/${q2.id}`, T.alice));
    for (const dest of [q2.id, NOBODY]) {
      const r = await put(q1.id, { connections: [], move_removed_to: dest });
      expect(r.status, dest).toBe(400);
      expect(await code(r)).toBe('CHANNEL_QUEUE_NOT_FOUND');
    }
    expect(await chanQueue(channelA)).toBe(q1.id);
  });

  it('el tipo debe coincidir y una conexión borrada no se puede usar: 404 uniforme, sin cambios parciales', async () => {
    const q = await mkQueue('Ventas');
    const qr = await mkQr(ORG_A, 'Chip');
    const gone = await mkQr(ORG_A, 'Borrado');
    await admin.query(`UPDATE channel_accounts SET deleted_at = now() WHERE id = $1`, [gone]);
    for (const conns of [[{ kind: 'qr', id: channelA }], [{ kind: 'channel', id: qr }], [{ kind: 'qr', id: gone }], [{ kind: 'channel', id: channelA }, { kind: 'qr', id: gone }]]) {
      expect((await put(q.id, { connections: conns })).status, JSON.stringify(conns)).toBe(404);
    }
    expect(await chanQueue(channelA)).toBeNull();
    expect(await connAudits()).toHaveLength(0);
  });

  it('el cuerpo se valida: campos de más, tipos, ids y tope', async () => {
    const q = await mkQueue('Ventas');
    for (const body of [{}, { connections: 'x' }, { connections: [{ kind: 'otra', id: channelA }] }, { connections: [{ kind: 'channel', id: 'no-uuid' }] }, { connections: [], extra: 1 }, { connections: [{ kind: 'channel', id: channelA, name: 'x' }] }, { connections: [], move_removed_to: 'x' }, { connections: Array.from({ length: 101 }, () => ({ kind: 'channel', id: channelA })) }]) {
      expect((await put(q.id, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await call('PUT', `/queues/${NOBODY}/connections`, T.alice, { connections: [] })).status).toBe(404);
  });
});

describe('lo que NO cambia', () => {
  it('las conversaciones que ya existen conservan su departamento; las nuevas usan el de la conexión', async () => {
    const q1 = await mkQueue('Ventas');
    const q2 = await mkQueue('Soporte');
    for (const q of [q1, q2]) {
      await patchQueue(q.id, { distribution_on: true });
      await setMembers(q.id, [[IDS.alice, true, 1]]);
    }
    await link(channelA, q1.id);
    await ingest(phone(1), 'm1'); // llega por la conexión en Ventas
    expect((await convs())[0]!.queue_id).toBe(q1.id);
    await set(q2.id, [[channelA, 'channel']]); // la conexión pasa a Soporte
    expect((await convs())[0]!.queue_id).toBe(q1.id); // la existente sigue en Ventas
    await ingest(phone(2), 'm2');
    const all = await convs();
    expect(all[0]!.queue_id).toBe(q1.id);
    expect(all[1]!.queue_id).toBe(q2.id); // la nueva va a Soporte
  });

  it('archivar un departamento con conexiones sigue bloqueado (QUEUE_IN_USE), también con una QR; se libera al quitarlas', async () => {
    const q = await mkQueue('Ventas');
    const dest = await mkQueue('Soporte');
    const qr = await mkQr(ORG_A, 'Chip');
    await set(q.id, [[qr, 'qr']]);
    const r = await call('DELETE', `/queues/${q.id}`, T.alice);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('QUEUE_IN_USE');
    await set(q.id, [], { move_removed_to: dest.id });
    expect((await call('DELETE', `/queues/${q.id}`, T.alice)).status).toBe(200);
  });

  it('los PATCH de siempre siguen igual: un departamento inexistente es 400 en el oficial', async () => {
    const r = await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: NOBODY });
    expect(r.status).toBe(400);
    expect(await code(r)).toBe('CHANNEL_QUEUE_NOT_FOUND');
  });
});

describe('dos cambios a la vez', () => {
  it('dos departamentos que reclaman la misma conexión: ambos terminan sin error y la conexión queda en UNO solo (el último en bloquear gana)', async () => {
    const q1 = await mkQueue('Ventas');
    const q2 = await mkQueue('Soporte');
    const qr = await mkQr(ORG_A, 'Chip');
    const results = await Promise.all([put(q1.id, { connections: [{ kind: 'channel', id: channelA }, { kind: 'qr', id: qr }] }), put(q2.id, { connections: [{ kind: 'qr', id: qr }, { kind: 'channel', id: channelA }] })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const qs = await getQueues();
    for (const c of [channelA, qr]) expect(qs.filter((x) => x.channels.some((k) => k.id === c)), c).toHaveLength(1);
    // cada conexión terminó en el departamento que dicen sus propias filas (una sola verdad)
    expect([q1.id, q2.id]).toContain(await chanQueue(channelA));
    expect([q1.id, q2.id]).toContain(await chanQueue(qr));
  });

  it('el cambio de un departamento y un PATCH de la conexión a la vez no se cruzan ni se bloquean', async () => {
    const q1 = await mkQueue('Ventas');
    await set(q1.id, [[channelA, 'channel']]);
    const rs = await Promise.all([put(q1.id, { connections: [], allow_unassigned: true }), call('PATCH', `/channels/${channelA}`, T.alice, { name: 'Renombrada' })]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(await chanQueue(channelA)).toBeNull();
  });
});
