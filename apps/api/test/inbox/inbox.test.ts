// M5.4 — Inbox y responder por WhatsApp (ADR-16/50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/conversations
//   GET /v1/conversations/options
//   GET /v1/conversations/:id
//   GET /v1/conversations/:id/messages
//   POST /v1/conversations/:id/messages
//   POST /v1/conversations/:id/notes
//   POST /v1/conversations/:id/accept
//   POST /v1/conversations/:id/take
//   POST /v1/conversations/:id/close
//   POST /v1/conversations/:id/read
//   POST /v1/messages/:id/retry
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
import { ChannelsModule, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER, WebhookEventsService } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { ConversationsService, type NormalizedMessage } from '../../src/modules/conversations';
import { InboxModule, OutboundDispatcher, WINDOW_MS } from '../../src/modules/inbox';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { CredentialVault } from '../../src/modules/platform';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
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
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia, con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob' | 'dave' | 'root', string>;
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
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.eve, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
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
async function connect(token: string, phoneId: string, name: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

interface Conv {
  id: string;
  status: string;
  unread_count: number;
  last_message_at: string | null;
  last_inbound_at: string | null;
  closed_at: string | null;
  contact: { id: string; name: string; phone: string | null };
  owner: { id: string; name: string } | null;
  queue: { id: string; name: string; color: string } | null;
  channel: { id: string; name: string; state: string };
  tags: Array<{ name: string; system_key: string | null }>;
  last_message: { direction: string; kind: string; preview: string; status: string; at: string } | null;
  window: { open: boolean; expires_at: string | null };
  can: { reply: boolean; note: boolean; accept: boolean; take: boolean; close: boolean; transfer: boolean; share: boolean };
}
interface Msg {
  id: string;
  direction: string;
  sender_type: string;
  author: { id: string; name: string } | null;
  kind: string;
  text: string | null;
  media: { mime_type: string | null; filename: string | null } | null;
  extra: Record<string, unknown> | null;
  reaction: string | null;
  status: string;
  error: string | null;
  sent_at: string;
  is_note: boolean;
}
interface List { items: Conv[]; next_cursor: string | null; counts: { working: number; pending: number; closed: number; unread: number } | null }
interface MsgList { items: Msg[]; next_cursor: string | null }

// ── datos de prueba insertados directo (como los dejaría la entrada de mensajes) ──
let seq = 0;
interface MkMsg {
  dir: 'in' | 'out';
  text?: string | null;
  at: Date;
  kind?: string;
  status?: string;
  ext?: string | null;
  by?: string | null;
  media?: unknown;
  meta?: unknown;
  attempts?: number;
  nextAttemptAt?: Date | null;
}
interface Mk {
  org?: string;
  channel?: string;
  owner?: string | null;
  status?: string;
  name?: string;
  peer?: string | null;
  lastInbound?: Date | null;
  lastMessage?: Date | null;
  unread?: number;
  queue?: string | null;
  msgs?: MkMsg[];
}
async function mkConv(o: Mk = {}): Promise<{ id: string; contact: string; peer: string; phone: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const channel = o.channel ?? (org === ORG_B ? channelB : channelA);
  const owner = o.owner ?? null;
  const status = o.status ?? (owner ? 'working' : 'unassigned');
  const phone = `+59398500${String(seq).padStart(4, '0')}`;
  const digits = phone.slice(1);
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [org, o.name ?? `Cliente ${seq}`])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const peer = o.peer === undefined ? digits : o.peer;
  const lastInbound = o.lastInbound === undefined ? ago(HOUR) : o.lastInbound;
  const lastMessage = o.lastMessage === undefined ? ago(30 * MIN) : o.lastMessage;
  const id = (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, queue_id, last_message_at, last_inbound_at, unread_count, peer_id, closed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [org, contact, channel, status, owner, owner ? new Date() : null, o.queue ?? null, lastMessage, lastInbound, o.unread ?? 0, peer, status === 'closed' ? new Date() : null],
    )
  ).rows[0].id as string;
  for (const m of o.msgs ?? []) await mkMsg(id, m, org, channel);
  return { id, contact, peer: digits, phone };
}
async function mkMsg(conv: string, m: MkMsg, org = ORG_A, channel = channelA): Promise<string> {
  const kind = m.kind ?? 'text';
  const status = m.status ?? (kind === 'note' ? 'internal' : m.dir === 'in' ? 'received' : 'sent');
  const rows = await admin.query(
    `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, media, meta, status, sent_at, created_by, attempts, next_attempt_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10::jsonb, '{}'::jsonb), $11, $12, $13, $14, $15) RETURNING id`,
    [org, conv, channel, m.ext ?? null, m.dir, m.dir === 'in' ? 'contact' : 'human', kind, m.text === undefined ? 'Hola' : m.text, m.media === undefined ? null : JSON.stringify(m.media), m.meta === undefined ? null : JSON.stringify(m.meta), status, m.at, m.by ?? null, m.attempts ?? 0, m.nextAttemptAt ?? null],
  );
  return rows.rows[0].id as string;
}
const convRow = async (id: string) => (await admin.query('SELECT * FROM conversations WHERE id = $1', [id])).rows[0] as { status: string; owner_id: string | null; unread_count: number; last_message_at: Date | null; closed_at: Date | null; assigned_at: Date | null; peer_id: string | null; contact_id: string };
const msgRow = async (id: string) => (await admin.query('SELECT * FROM messages WHERE id = $1', [id])).rows[0] as { status: string; error: string | null; attempts: number; next_attempt_at: Date | null; external_id: string | null; body: string | null; meta: Record<string, unknown>; created_by: string | null; kind: string };
const msgCount = async (conv: string): Promise<number> => Number((await admin.query('SELECT count(*) FROM messages WHERE conversation_id = $1', [conv])).rows[0].count);
const audits = async (entityId: string) => (await admin.query(`SELECT entity_type, field, old_value, new_value, source FROM audit_logs WHERE entity_id = $1 ORDER BY at, id`, [entityId])).rows as Array<{ entity_type: string; field: string | null; old_value: unknown; new_value: unknown; source: string }>;
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

const list = async (token: string, qs = ''): Promise<List> => ok<List>(await call('GET', `/conversations${qs}`, token));
const ids = (l: List): string[] => l.items.map((c) => c.id);
const reply = (token: string, conv: string, text: string) => call('POST', `/conversations/${conv}/messages`, token, { text });
const inOrg = <X,>(org: string, fn: () => Promise<X>): Promise<X> => TenantContext.run({ organizationId: org }, fn);
const dispatch = (id: string, now = new Date(), org = ORG_A) => inOrg(org, () => app.get(OutboundDispatcher).dispatchOne(id, now));
const runDue = (now = new Date(), org = ORG_A) => inOrg(org, () => app.get(OutboundDispatcher).runDue(now));

const phone = (n: number): string => `+59398400${String(n).padStart(4, '0')}`;
const msg = (from: string, id: string): NormalizedMessage => ({ externalId: id, from, fromRaw: from.slice(1), profileName: null, kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date() });
/** Entra un mensaje del cliente: exactamente lo que hace la tarea que procesa los avisos. */
async function ingest(from: string, id: string, channel = channelA): Promise<void> {
  await inOrg(ORG_A, async () => {
    const dir = await app.get(OrgDirectoryService).current({ fresh: true });
    const ctx = { now: new Date(), timeZone: dir.timeZone, assignable: dir.assignable };
    await app.get(Database).withTenant((tx) => app.get(ConversationsService).ingestInbound(tx, channel, msg(from, id), ctx));
  });
}
async function carolQueue(): Promise<void> {
  const q = await ok<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
  await ok(await call('PATCH', `/queues/${q.id}`, T.alice, { distribution_on: true }));
  await ok(await call('PUT', `/queues/${q.id}/members`, T.alice, { members: [{ user_id: IDS.carol, active: true, weight: 1 }] }));
  await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: q.id }));
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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte');
  fake().outbox.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('permisos', () => {
  const routes = (c: string, m: string): Array<[string, string, unknown?]> => [
    ['GET', '/conversations'],
    ['GET', '/conversations/options'],
    ['GET', `/conversations/${c}`],
    ['GET', `/conversations/${c}/messages`],
    ['POST', `/conversations/${c}/messages`, { text: 'hola' }],
    ['POST', `/conversations/${c}/notes`, { text: 'nota' }],
    ['POST', `/conversations/${c}/accept`],
    ['POST', `/conversations/${c}/take`],
    ['POST', `/conversations/${c}/close`],
    ['POST', `/conversations/${c}/read`],
    ['POST', `/messages/${m}/retry`],
  ];

  it('sin sesión 401; la plataforma 403 en todas las rutas', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const m = await mkMsg(c.id, { dir: 'out', status: 'failed', at: ago(MIN) });
    for (const [method, path, body] of routes(c.id, m)) {
      expect((await call(method, path, undefined, body)).status, `${method} ${path}`).toBe(401);
      expect((await call(method, path, T.root, body)).status, `${method} ${path} plataforma`).toBe(403);
    }
  });

  it('la agencia con nivel «lectura» solo ve; todo lo que escribe es 403', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'pending', unread: 1 });
    const m = await mkMsg(c.id, { dir: 'out', status: 'failed', at: ago(MIN) });
    await ok(await call('POST', '/context/switch', T.dave, { target: ORG_A }));
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect(ids(await list(T.dave, '?tab=pending'))).toEqual([c.id]);
    expect((await ok<Conv>(await call('GET', `/conversations/${c.id}`, T.dave))).can).toEqual({ reply: false, note: false, accept: false, take: false, close: false, transfer: false, share: false });
    expect((await call('GET', `/conversations/${c.id}/messages`, T.dave)).status).toBe(200);
    expect((await call('GET', '/conversations/options', T.dave)).status).toBe(200);
    for (const [method, path, body] of routes(c.id, m).filter(([mt]) => mt === 'POST')) expect((await call(method, path, T.dave, body)).status, `${method} ${path} lectura`).toBe(403);
    expect(fake().outbox).toEqual([]);
    expect((await convRow(c.id)).status).toBe('pending');
  });

  it('la agencia con nivel «asesor» no es dueña de nada: no ve conversaciones ajenas', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await ok(await call('POST', '/context/switch', T.dave, { target: ORG_A }));
    await admin.query(`UPDATE organization_members SET access_level = 'advisor' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect(await list(T.dave)).toMatchObject({ items: [], counts: { working: 0, pending: 0, closed: 0, unread: 0 } });
    expect((await call('GET', `/conversations/${c.id}`, T.dave)).status).toBe(404);
  });

  it('la agencia con nivel «administrador» ve todo, pero no puede tomar conversaciones: no es de la plantilla de la empresa', async () => {
    const c = await mkConv({});
    await ok(await call('POST', '/context/switch', T.dave, { target: ORG_A }));
    expect(ids(await list(T.dave, '?tab=pending'))).toEqual([c.id]);
    const r = await call('POST', `/conversations/${c.id}/take`, T.dave);
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('NOT_ASSIGNABLE');
    expect((await convRow(c.id)).status).toBe('unassigned');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('visibilidad', () => {
  it('el asesor ve solo lo asignado a él; el administrador, todo (también lo sin asignar)', async () => {
    const mine = await mkConv({ owner: IDS.carol, status: 'pending' });
    const theirs = await mkConv({ owner: IDS.eve });
    const free = await mkConv({});
    expect(ids(await list(T.carol, '?tab=pending'))).toEqual([mine.id]);
    expect(ids(await list(T.carol, '?tab=working'))).toEqual([]);
    expect(ids(await list(T.eve))).toEqual([theirs.id]);
    expect(new Set([...ids(await list(T.alice, '?tab=pending')), ...ids(await list(T.alice))])).toEqual(new Set([mine.id, theirs.id, free.id]));
    for (const id of [theirs.id, free.id]) {
      expect((await call('GET', `/conversations/${id}`, T.carol)).status, 'detalle').toBe(404);
      expect((await call('GET', `/conversations/${id}/messages`, T.carol)).status, 'mensajes').toBe(404);
    }
  });

  it('lo que no se ve responde 404 también en todas las acciones, y no cambia nada', async () => {
    const theirs = await mkConv({ owner: IDS.eve, status: 'pending', unread: 2, msgs: [{ dir: 'in', at: ago(5 * MIN) }] });
    const before = await convRow(theirs.id);
    const actions: Array<[string, unknown?]> = [['messages', { text: 'hola' }], ['notes', { text: 'nota' }], ['accept'], ['close'], ['read']];
    for (const [a, body] of actions) expect((await call('POST', `/conversations/${theirs.id}/${a}`, T.carol, body)).status, a).toBe(404);
    const failed = await mkMsg(theirs.id, { dir: 'out', status: 'failed', at: ago(MIN) });
    expect((await call('POST', `/messages/${failed}/retry`, T.carol)).status).toBe(404);
    expect(await convRow(theirs.id)).toEqual(before);
    expect(await msgCount(theirs.id)).toBe(2);
    expect(fake().outbox).toEqual([]);
  });

  it('las conversaciones de un contacto borrado no aparecen', async () => {
    const c = await mkConv({ owner: IDS.carol });
    expect(ids(await list(T.alice))).toEqual([c.id]);
    await admin.query('UPDATE contacts SET deleted_at = now() WHERE id = $1', [c.contact]);
    expect(ids(await list(T.alice))).toEqual([]);
    expect((await call('GET', `/conversations/${c.id}`, T.alice)).status).toBe(404);
    expect((await call('POST', `/conversations/${c.id}/notes`, T.alice, { text: 'x' })).status).toBe(404);
  });

  it('A↔B: nadie ve ni toca las conversaciones de otra empresa (404) y la lista solo trae las propias', async () => {
    const a = await mkConv({ owner: IDS.carol, status: 'pending', unread: 1, msgs: [{ dir: 'in', at: ago(5 * MIN), ext: 'wamid.A1' }] });
    const b = await mkConv({ org: ORG_B, owner: null });
    const failedB = await mkMsg(b.id, { dir: 'out', status: 'failed', at: ago(MIN) }, ORG_B, channelB);
    expect(ids(await list(T.bob, '?tab=pending'))).toEqual([b.id]);
    expect(ids(await list(T.bob))).toEqual([]);
    expect(ids(await list(T.alice, '?tab=pending'))).toEqual([a.id]);
    const beforeA = await convRow(a.id);
    const beforeB = await convRow(b.id);
    const probes: Array<[string, string, unknown?]> = [['GET', ''], ['GET', '/messages'], ['POST', '/messages', { text: 'hola' }], ['POST', '/notes', { text: 'nota' }], ['POST', '/accept'], ['POST', '/take'], ['POST', '/close'], ['POST', '/read']];
    for (const [method, tail, body] of probes) {
      expect((await call(method, `/conversations/${a.id}${tail}`, T.bob, body)).status, `B → A ${method} ${tail}`).toBe(404);
      expect((await call(method, `/conversations/${b.id}${tail}`, T.alice, body)).status, `A → B ${method} ${tail}`).toBe(404);
    }
    expect((await call('POST', `/messages/${failedB}/retry`, T.alice)).status).toBe(404);
    expect(await convRow(a.id)).toEqual(beforeA);
    expect(await convRow(b.id)).toEqual(beforeB);
    expect(fake().outbox).toEqual([]);
    expect((await call('GET', `/conversations/${NOBODY}`, T.alice)).status).toBe(404);
    expect((await call('GET', '/conversations/no-es-un-uuid', T.alice)).status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('listado', () => {
  async function scene() {
    const c1 = await mkConv({ owner: IDS.carol, status: 'pending', unread: 2, lastMessage: ago(10 * MIN), name: 'Ana Torres' });
    const c2 = await mkConv({ owner: IDS.carol, status: 'working', lastMessage: ago(20 * MIN), name: 'Bruno Díaz' });
    const c3 = await mkConv({ owner: IDS.carol, status: 'waiting', lastMessage: ago(30 * MIN), name: 'Carla Ruiz' });
    const c4 = await mkConv({ owner: IDS.eve, status: 'working', unread: 1, lastMessage: ago(40 * MIN), name: 'Diego Paz' });
    const c5 = await mkConv({ status: 'unassigned', lastMessage: ago(50 * MIN), name: 'Elena Mora' });
    const c6 = await mkConv({ owner: IDS.carol, status: 'closed', lastMessage: ago(60 * MIN), name: 'Fabio Sol' });
    return { c1, c2, c3, c4, c5, c6 };
  }

  it('las pestañas agrupan los estados y los conteos salen de la primera página', async () => {
    const s = await scene();
    const w = await list(T.alice, '?tab=working');
    expect(ids(w)).toEqual([s.c2.id, s.c3.id, s.c4.id]);
    expect(w.counts).toEqual({ working: 3, pending: 2, closed: 1, unread: 2 });
    expect(ids(await list(T.alice, '?tab=pending'))).toEqual([s.c1.id, s.c5.id]);
    expect(ids(await list(T.alice, '?tab=closed'))).toEqual([s.c6.id]);
    expect(ids(await list(T.alice))).toEqual(ids(w)); // por omisión, «trabajando»
    const c = await list(T.carol);
    expect(ids(c)).toEqual([s.c2.id, s.c3.id]);
    expect(c.counts).toEqual({ working: 2, pending: 1, closed: 1, unread: 1 });
    expect(await list(T.eve)).toMatchObject({ counts: { working: 1, pending: 0, closed: 0, unread: 1 } });
  });

  it('filtra por responsable, cola, conexión, etiqueta, no leídas y búsqueda (nombre o teléfono)', async () => {
    const s = await scene();
    const q = await ok<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Soporte' }), 201);
    await admin.query('UPDATE conversations SET queue_id = $1 WHERE id = $2', [q.id, s.c2.id]);
    const tag = (await admin.query(`INSERT INTO tags(id, organization_id, name) VALUES (gen_random_uuid(), $1, 'VIP') RETURNING id`, [ORG_A])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_tags(organization_id, contact_id, tag_id) VALUES ($1, $2, $3)`, [ORG_A, s.c3.contact, tag]);
    const all = '?tab=working';
    expect(ids(await list(T.alice, `${all}&owner=${IDS.carol}`))).toEqual([s.c2.id, s.c3.id]);
    expect(ids(await list(T.alice, `${all}&owner=${IDS.eve}`))).toEqual([s.c4.id]);
    expect(ids(await list(T.alice, `${all}&queue=${q.id}`))).toEqual([s.c2.id]);
    expect(ids(await list(T.alice, `${all}&channel=${channelA}`))).toEqual([s.c2.id, s.c3.id, s.c4.id]);
    expect(ids(await list(T.alice, `${all}&channel=${channelB}`))).toEqual([]);
    expect(ids(await list(T.alice, `${all}&tag=${tag}`))).toEqual([s.c3.id]);
    expect(ids(await list(T.alice, `${all}&unread=1`))).toEqual([s.c4.id]);
    expect(ids(await list(T.alice, `${all}&q=bruno`))).toEqual([s.c2.id]);
    expect(ids(await list(T.alice, `${all}&q=${encodeURIComponent(s.c3.phone.slice(-6))}`))).toEqual([s.c3.id]);
    expect(ids(await list(T.alice, `${all}&q=%25`))).toEqual([]); // el comodín del buscador no es un comodín
    // los conteos respetan los filtros
    expect((await list(T.alice, `${all}&owner=${IDS.carol}`)).counts).toEqual({ working: 2, pending: 1, closed: 1, unread: 1 });
    // un asesor no puede ampliar su alcance con el filtro de responsable
    expect(ids(await list(T.carol, `${all}&owner=${IDS.eve}`))).toEqual([]);
  });

  it('pagina por cursor sin repetir ni saltar (incluso con la misma hora de actividad) y rechaza cursores inválidos', async () => {
    const same = ago(5 * MIN);
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push((await mkConv({ owner: IDS.carol, lastMessage: i < 3 ? same : ago((10 + i) * MIN) })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: List = await list(T.alice, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      if (pages === 0) expect(page.counts).not.toBeNull();
      else expect(page.counts).toBeNull();
      seen.push(...ids(page));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(made));
    for (const bad of ['basura', Buffer.from('{"k":1}').toString('base64url'), Buffer.from(JSON.stringify({ k: '2025-01-01T00:00:00.000000Z', id: 'x' })).toString('base64url')]) {
      expect((await call('GET', `/conversations?cursor=${bad}`, T.alice)).status, bad).toBe(400);
    }
    for (const bad of ['tab=otra', 'limit=0', 'limit=101', 'unread=2', 'owner=no', 'otro=1']) expect((await call('GET', `/conversations?${bad}`, T.alice)).status, bad).toBe(400);
  });

  it('cada fila trae contacto, responsable, cola, conexión, etiquetas, último mensaje real (sin notas), ventana de 24 h y lo que la persona puede hacer', async () => {
    const q = await ok<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas', color: '#0b7a6b' }), 201);
    const c = await mkConv({
      owner: IDS.carol,
      status: 'pending',
      queue: q.id,
      unread: 2,
      lastInbound: ago(2 * HOUR),
      msgs: [
        { dir: 'in', text: 'Hola, ¿tienen\n   cita   mañana?', at: ago(10 * MIN) },
        { dir: 'out', text: 'Claro que sí', at: ago(9 * MIN), status: 'delivered' },
        { dir: 'in', text: null, kind: 'image', at: ago(8 * MIN) },
        { dir: 'out', text: 'recordar llamar', kind: 'note', at: ago(MIN), by: IDS.alice },
      ],
    });
    await admin.query(`INSERT INTO tags(id, organization_id, name, is_system, system_key) VALUES (gen_random_uuid(), $1, 'Lead', true, 'lead')`, [ORG_A]);
    const tagId = (await admin.query(`SELECT id FROM tags WHERE system_key = 'lead'`)).rows[0].id as string;
    await admin.query(`INSERT INTO contact_tags(organization_id, contact_id, tag_id, set_by) VALUES ($1, $2, $3, 'system')`, [ORG_A, c.contact, tagId]);
    const [row] = (await list(T.carol, '?tab=pending')).items;
    expect(row).toMatchObject({
      id: c.id,
      status: 'pending',
      unread_count: 2,
      contact: { id: c.contact, phone: c.phone },
      owner: { id: IDS.carol, name: 'Carolina Vera' },
      queue: { id: q.id, name: 'Ventas', color: '#0b7a6b' },
      channel: { id: channelA, name: 'Ventas', state: 'active' },
      tags: [{ name: 'Lead', system_key: 'lead' }],
      last_message: { direction: 'in', kind: 'image', preview: 'Imagen', status: 'received' }, // la nota (más reciente) no cuenta
      window: { open: true },
      can: { reply: true, note: true, accept: true, take: false, close: true },
    });
    expect(Date.parse(row!.window.expires_at!)).toBeGreaterThan(Date.now() + 21 * HOUR);
    expect(Date.parse(row!.window.expires_at!)).toBeLessThanOrEqual(Date.now() + 22 * HOUR);
    // el administrador ve lo mismo y, como ve todo, también puede aceptarla y responderla aunque no sea suya
    expect((await list(T.alice, '?tab=pending')).items[0]!.can).toEqual({ reply: true, note: true, accept: true, take: false, close: true, transfer: true, share: true });
    // un texto largo con saltos de línea se resume en una línea
    await admin.query(`UPDATE messages SET body = $1 WHERE conversation_id = $2 AND body LIKE 'Hola%'`, ['Hola\n\n   ' + 'x'.repeat(300), c.id]);
    await admin.query(`UPDATE messages SET status = 'received', sent_at = now() WHERE conversation_id = $1 AND kind = 'image'`, [c.id]);
    await admin.query(`UPDATE messages SET kind = 'text', body = $1 WHERE conversation_id = $2 AND kind = 'image'`, ['Hola\n\n   ' + 'x'.repeat(300), c.id]);
    const preview = (await list(T.carol, '?tab=pending')).items[0]!.last_message!.preview;
    expect(preview).not.toMatch(/\n/);
    expect(preview.length).toBeLessThanOrEqual(140);
    expect(preview.startsWith('Hola xxx')).toBe(true);
  });

  it('la ventana de 24 h: abierta dentro de las 24 h del último mensaje del cliente, cerrada pasadas o sin mensajes del cliente', async () => {
    const open = await mkConv({ owner: IDS.carol, lastInbound: new Date(Date.now() - WINDOW_MS + 5 * MIN) });
    const closed = await mkConv({ owner: IDS.carol, lastInbound: new Date(Date.now() - WINDOW_MS - MIN) });
    const never = await mkConv({ owner: IDS.carol, lastInbound: null });
    const view = async (id: string) => (await ok<Conv>(await call('GET', `/conversations/${id}`, T.carol))).window;
    expect((await view(open.id)).open).toBe(true);
    expect(await view(closed.id)).toMatchObject({ open: false });
    expect(await view(never.id)).toEqual({ open: false, expires_at: null });
  });

  it('las opciones de los filtros: el administrador ve a las personas; el asesor, no', async () => {
    await ok(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
    const a = await ok<{ queues: Array<{ name: string }>; channels: Array<{ name: string; state: string }>; owners: Array<{ name: string }>; tags: Array<{ name: string }> }>(await call('GET', '/conversations/options', T.alice));
    expect(a.queues.map((x) => x.name)).toEqual(['Ventas']);
    expect(a.channels).toMatchObject([{ name: 'Ventas', state: 'active' }]);
    expect(a.owners.map((x) => x.name)).toEqual(['Alicia Torres', 'Carolina Vera', 'Eva Mora']);
    expect(a.tags.map((x) => x.name).sort()).toEqual(['Cita agendada', 'Lead', 'Venta']);
    expect((await ok<{ owners: unknown[] }>(await call('GET', '/conversations/options', T.carol))).owners).toEqual([]);
    const b = await ok<{ queues: unknown[]; channels: Array<{ name: string }> }>(await call('GET', '/conversations/options', T.bob));
    expect(b.queues).toEqual([]);
    expect(b.channels.map((x) => x.name)).toEqual(['Soporte']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('hilo de mensajes', () => {
  it('trae los más recientes primero por página y los entrega de más antiguo a más reciente, con notas y autores', async () => {
    const c = await mkConv({
      owner: IDS.carol,
      msgs: [
        { dir: 'in', text: 'uno', at: ago(50 * MIN), meta: { wa_id: '593985000001' } },
        { dir: 'out', text: 'dos', at: ago(40 * MIN), by: IDS.carol, status: 'read', meta: { reaction: '\u{1F44D}', reaction_at: '2025-10-01T12:00:00.000Z' } }, // el cliente reaccionó
        { dir: 'out', text: 'nota privada', kind: 'note', at: ago(30 * MIN), by: IDS.alice },
        { dir: 'in', text: null, kind: 'location', at: ago(20 * MIN), meta: { wa_id: '593985000001', location: { latitude: -2.17, longitude: -79.92 } } },
        { dir: 'in', text: 'cinco', kind: 'document', at: ago(10 * MIN), media: { id: 'm1', mime_type: 'application/pdf', filename: 'precios.pdf' } },
      ],
    });
    const p1 = await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages?limit=2`, T.carol));
    expect(p1.items.map((m) => m.text)).toEqual([null, 'cinco']);
    expect(p1.items[1]).toMatchObject({ kind: 'document', media: { mime_type: 'application/pdf', filename: 'precios.pdf' }, extra: null });
    expect(p1.items[0]).toMatchObject({ kind: 'location', extra: { location: { latitude: -2.17, longitude: -79.92 } } }); // el wa_id no se muestra
    const p2 = await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages?limit=2&cursor=${p1.next_cursor}`, T.carol));
    expect(p2.items.map((m) => [m.text, m.is_note, m.author?.name ?? null])).toEqual([['dos', false, 'Carolina Vera'], ['nota privada', true, 'Alicia Torres']]);
    // la reacción del cliente se muestra aparte (con el emoji); su hora no sale y no ensucia `extra`
    expect(p2.items[0]).toMatchObject({ reaction: '\u{1F44D}', extra: null });
    expect([...p1.items, ...p2.items.slice(1)].map((m) => m.reaction)).toEqual([null, null, null]);
    const p3 = await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages?limit=2&cursor=${p2.next_cursor}`, T.carol));
    expect(p3.items.map((m) => m.text)).toEqual(['uno']);
    expect(p3.next_cursor).toBeNull();
    expect(p3.items[0]).toMatchObject({ direction: 'in', sender_type: 'contact', author: null, status: 'received' });
    // el asesor ve las notas del administrador: son internas, no privadas
    expect((await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages`, T.carol))).items.filter((m) => m.is_note)).toHaveLength(1);
    expect((await call('GET', `/conversations/${c.id}/messages?cursor=basura`, T.carol)).status).toBe(400);
    expect((await call('GET', `/conversations/${c.id}/messages?limit=0`, T.carol)).status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('responder', () => {
  it('el asesor responde: el mensaje sale por WhatsApp, queda enviado con su identificador y la conversación pasa a «esperando al cliente»', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'pending', unread: 3 });
    const before = Date.now();
    const m = await ok<Msg>(await reply(T.carol, c.id, '  Hola, ¿en qué te ayudo?  '), 201);
    expect(m).toMatchObject({ direction: 'out', sender_type: 'human', kind: 'text', text: 'Hola, ¿en qué te ayudo?', status: 'sent', error: null, is_note: false, author: { id: IDS.carol, name: 'Carolina Vera' } });
    expect(fake().outbox).toEqual([expect.objectContaining({ phoneNumberId: '1090123456789', to: c.peer, text: 'Hola, ¿en qué te ayudo?' })]);
    const row = await msgRow(m.id);
    expect(row).toMatchObject({ status: 'sent', attempts: 1, next_attempt_at: null, created_by: IDS.carol });
    expect(row.external_id).toMatch(/^wamid\.FAKE\./);
    const conv = await convRow(c.id);
    expect(conv).toMatchObject({ status: 'waiting', unread_count: 0 });
    expect(conv.last_message_at!.getTime()).toBeGreaterThanOrEqual(before - 5);
    // responder sin haber aceptado equivale a aceptar y queda auditado; el texto nunca va a la auditoría
    expect((await audits(c.id)).map((a) => [a.entity_type, a.field, a.old_value, a.new_value])).toEqual([['conversation', 'status', 'pending', 'waiting']]);
    const leaked = await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE old_value::text LIKE '%ayudo%' OR new_value::text LIKE '%ayudo%'`);
    expect(leaked.rows[0].n).toBe(0);
    const thread = await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages`, T.carol));
    expect(thread.items.map((x) => x.id)).toEqual([m.id]);
  });

  it('si el cliente no tiene teléfono guardado en la conversación, se le escribe al principal de su ficha', async () => {
    const c = await mkConv({ owner: IDS.carol, peer: null });
    await ok(await reply(T.carol, c.id, 'Hola'), 201);
    expect(fake().outbox.map((x) => x.to)).toEqual([c.phone.slice(1)]);
  });

  it('varios mensajes seguidos salen en el orden en que se escribieron', async () => {
    const c = await mkConv({ owner: IDS.carol });
    for (const t of ['uno', 'dos', 'tres', 'cuatro']) await ok(await reply(T.carol, c.id, t), 201);
    expect(fake().outbox.map((x) => x.text)).toEqual(['uno', 'dos', 'tres', 'cuatro']);
    const thread = await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages`, T.carol));
    expect(thread.items.map((x) => x.text)).toEqual(['uno', 'dos', 'tres', 'cuatro']);
  });

  it('responde su dueño o quien ve todo, con la conversación abierta y asignada; un colaborador solo con permiso; el resto no la ve', async () => {
    const mine = await mkConv({ owner: IDS.carol });
    const free = await mkConv({});
    const done = await mkConv({ owner: IDS.carol, status: 'closed' });
    const r1 = await reply(T.alice, mine.id, 'Hola'); // el administrador ve todo: responde aunque no sea suya (ADR-50, enmienda de M5.6c)
    expect(r1.status).toBe(201);
    const r2 = await reply(T.alice, free.id, 'Hola');
    expect([r2.status, await code(r2)]).toEqual([409, 'CONVERSATION_UNASSIGNED']);
    const r3 = await reply(T.carol, done.id, 'Hola');
    expect([r3.status, await code(r3)]).toEqual([409, 'CONVERSATION_CLOSED']);
    expect((await reply(T.eve, mine.id, 'Hola')).status).toBe(404);
    expect(fake().outbox.map((x) => x.text)).toEqual(['Hola']); // solo salió el del administrador
    expect(await msgCount(mine.id)).toBe(1);
    expect(await msgCount(free.id)).toBe(0);
    expect(await msgCount(done.id)).toBe(0);
  });

  it('pasadas las 24 h del último mensaje del cliente responde 409 WINDOW_CLOSED y no guarda nada; dentro de la ventana, sí', async () => {
    const closed = await mkConv({ owner: IDS.carol, status: 'waiting', unread: 1, lastInbound: new Date(Date.now() - WINDOW_MS - MIN) });
    const never = await mkConv({ owner: IDS.carol, lastInbound: null });
    for (const c of [closed, never]) {
      const r = await reply(T.carol, c.id, 'Hola');
      expect([r.status, await code(r)], 'ventana cerrada').toEqual([409, 'WINDOW_CLOSED']);
      expect(await msgCount(c.id)).toBe(0);
    }
    expect(await convRow(closed.id)).toMatchObject({ status: 'waiting', unread_count: 1 });
    const edge = await mkConv({ owner: IDS.carol, lastInbound: new Date(Date.now() - WINDOW_MS + 30_000) });
    await ok(await reply(T.carol, edge.id, 'Todavía alcanzo'), 201);
    expect(fake().outbox).toHaveLength(1);
  });

  it('con la conexión desactivada no se puede responder; al reactivarla, sí', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { status: 'disabled' }));
    const r = await reply(T.carol, c.id, 'Hola');
    expect([r.status, await code(r)]).toEqual([409, 'CHANNEL_DISABLED']);
    expect((await ok<Conv>(await call('GET', `/conversations/${c.id}`, T.carol))).can.reply).toBe(false);
    await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { status: 'active' }));
    await ok(await reply(T.carol, c.id, 'Hola'), 201);
  });

  it('valida el texto: no vacío, hasta 4096 caracteres, sin caracteres de control y sin campos desconocidos', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const bad = async (body: unknown, label: string) => expect((await call('POST', `/conversations/${c.id}/messages`, T.carol, body)).status, label).toBe(400);
    await bad({}, 'sin texto');
    await bad({ text: '' }, 'vacío');
    await bad({ text: '   \n  ' }, 'solo espacios');
    await bad({ text: 'x'.repeat(4097) }, 'muy largo');
    await bad({ text: 'a\u0000b' }, 'NUL');
    await bad({ text: 'a\u0007b' }, 'control');
    await bad({ text: 'hola', otro: 1 }, 'campo desconocido');
    await bad({ text: 42 }, 'tipo');
    await ok(await reply(T.carol, c.id, 'x'.repeat(4096)), 201);
    await ok(await reply(T.carol, c.id, 'línea 1\nlínea 2\tcon tabulación'), 201);
    expect(fake().outbox.map((x) => x.text.length)).toEqual([4096, 'línea 1\nlínea 2\tcon tabulación'.length]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('envío: fallos y reintentos', () => {
  it('un fallo pasajero deja el mensaje en cola con espera creciente (15 s, 30 s, 1 min, 2 min) y tras 5 intentos queda fallido con su explicación', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const m = await ok<Msg>(await reply(T.carol, c.id, '[fallar:caida] hola'), 201);
    expect(m.status).toBe('queued');
    const wait = async (id: string): Promise<number> => ((await msgRow(id)).next_attempt_at!.getTime() - Date.now()) / 1000;
    expect(await msgRow(m.id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await wait(m.id)).toBeGreaterThan(12);
    expect(await wait(m.id)).toBeLessThanOrEqual(15.5);
    expect(await dispatch(m.id, new Date(Date.now() + 5_000))).toEqual({ outcome: 'skipped' }); // aún no le toca
    expect((await msgRow(m.id)).attempts).toBe(1);
    const expected: Array<[number, number]> = [[2, 30], [3, 60], [4, 120]];
    for (const [attempts, seconds] of expected) {
      expect(await dispatch(m.id, new Date(Date.now() + attempts * HOUR))).toEqual({ outcome: 'retry', code: 'unavailable' });
      expect((await msgRow(m.id)).attempts).toBe(attempts);
      expect(await wait(m.id)).toBeGreaterThan(seconds - 3);
      expect(await wait(m.id)).toBeLessThanOrEqual(seconds + 0.5);
    }
    expect(await dispatch(m.id, new Date(Date.now() + 9 * HOUR))).toEqual({ outcome: 'failed', code: 'unavailable' });
    const row = await msgRow(m.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 5, next_attempt_at: null, meta: { error_code: 'unavailable' } });
    expect(row.error).toMatch(/No pudimos entregarlo a WhatsApp/);
    expect(fake().outbox).toEqual([]);
    const thread = await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages`, T.carol));
    expect(thread.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/WhatsApp/) });
    expect(thread.items[0]!.extra).toBeNull(); // el código interno del error no se muestra
  });

  it('un fallo definitivo (fuera de ventana, número inválido, rechazo) deja el mensaje fallido al instante, sin reintentos', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const cases: Array<[string, string, RegExp]> = [['[fallar:ventana] a', 'window_closed', /24 horas/], ['[fallar:numero] b', 'recipient_invalid', /no pudo entregar/], ['[fallar:rechazo] c', 'rejected', /rechazó el mensaje/], ['[fallar:limite] d', 'rate_limited', /limitó/]];
    for (const [text, errorCode, msgRe] of cases) {
      const m = await ok<Msg>(await reply(T.carol, c.id, text), 201);
      const row = await msgRow(m.id);
      if (errorCode === 'rate_limited') {
        expect(m.status, errorCode).toBe('queued'); // el límite es pasajero: se reintenta
        await admin.query(`UPDATE messages SET status = 'failed', next_attempt_at = NULL WHERE id = $1`, [m.id]); // lo dejamos fallido para no estorbar a los siguientes
        continue;
      }
      expect(m.status, errorCode).toBe('failed');
      expect(row).toMatchObject({ status: 'failed', attempts: 1, next_attempt_at: null, meta: { error_code: errorCode } });
      expect(row.error).toMatch(msgRe);
    }
    expect(fake().outbox).toEqual([]);
  });

  it('reintentar un mensaje fallido lo vuelve a enviar; su dueño o quien ve todo, y solo si falló', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const m = await ok<Msg>(await reply(T.carol, c.id, '[fallar:rechazo] hola'), 201);
    expect(m.status).toBe('failed');
    expect(fake().outbox).toEqual([]);
    // otra asesora no la ve; el administrador (ve todo) sí puede reintentar
    expect((await call('POST', `/messages/${m.id}/retry`, T.eve)).status).toBe(404);
    expect((await ok<Msg>(await call('POST', `/messages/${m.id}/retry`, T.alice))).status).toBe('failed');
    expect((await msgRow(m.id)).attempts).toBe(1);
    // mientras siga igual, vuelve a fallar
    expect((await ok<Msg>(await call('POST', `/messages/${m.id}/retry`, T.carol))).status).toBe('failed');
    expect((await msgRow(m.id)).attempts).toBe(1); // el contador se reinicia con cada reintento manual
    // arreglado el problema, sale
    await admin.query(`UPDATE messages SET body = 'hola' WHERE id = $1`, [m.id]);
    const done = await ok<Msg>(await call('POST', `/messages/${m.id}/retry`, T.carol));
    expect(done).toMatchObject({ status: 'sent', error: null });
    expect(fake().outbox.map((x) => x.text)).toEqual(['hola']);
    expect((await msgRow(m.id)).meta).toEqual({});
    // ya enviado: no hay nada que reintentar
    const again = await call('POST', `/messages/${m.id}/retry`, T.carol);
    expect([again.status, await code(again)]).toEqual([409, 'MESSAGE_NOT_FAILED']);
    expect(fake().outbox).toHaveLength(1);
  });

  it('no se reintenta en una conversación finalizada ni pasada la ventana de 24 h; una nota o un mensaje del cliente no son reintentables', async () => {
    const closed = await mkConv({ owner: IDS.carol, status: 'closed' });
    const stale = await mkConv({ owner: IDS.carol, lastInbound: new Date(Date.now() - WINDOW_MS - MIN) });
    const f1 = await mkMsg(closed.id, { dir: 'out', status: 'failed', at: ago(MIN), text: 'a' });
    const f2 = await mkMsg(stale.id, { dir: 'out', status: 'failed', at: ago(MIN), text: 'b' });
    const note = await mkMsg(stale.id, { dir: 'out', kind: 'note', at: ago(MIN), by: IDS.carol });
    const inbound = await mkMsg(stale.id, { dir: 'in', at: ago(MIN) });
    expect(await code(await call('POST', `/messages/${f1}/retry`, T.carol))).toBe('CONVERSATION_CLOSED');
    expect(await code(await call('POST', `/messages/${f2}/retry`, T.carol))).toBe('WINDOW_CLOSED');
    expect((await call('POST', `/messages/${note}/retry`, T.carol)).status).toBe(404);
    expect((await call('POST', `/messages/${inbound}/retry`, T.carol)).status).toBe(404);
    expect((await call('POST', `/messages/${NOBODY}/retry`, T.carol)).status).toBe(404);
    expect(fake().outbox).toEqual([]);
  });

  it('un mensaje ya en cola no se reenvía antes de tiempo al «reintentar»', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const m = await mkMsg(c.id, { dir: 'out', status: 'queued', at: ago(MIN), text: 'espera', attempts: 2, nextAttemptAt: new Date(Date.now() + HOUR) });
    expect((await ok<Msg>(await call('POST', `/messages/${m}/retry`, T.carol))).status).toBe('queued');
    expect(fake().outbox).toEqual([]);
    expect((await msgRow(m)).attempts).toBe(2);
  });

  it('si las credenciales guardadas no se pueden abrir, el mensaje queda fallido con una explicación para el administrador', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await admin.query(`UPDATE channel_accounts SET credentials_sealed = 'sobre-alterado' WHERE id = $1`, [channelA]);
    const m = await ok<Msg>(await reply(T.carol, c.id, 'Hola'), 201);
    expect(m).toMatchObject({ status: 'failed', error: expect.stringMatching(/credenciales/) });
    expect((await msgRow(m.id)).meta).toMatchObject({ error_code: 'credentials' });
    expect(fake().outbox).toEqual([]);
  });

  it('si la conexión se desactiva con el mensaje ya en cola, queda fallido (y se puede reintentar al reactivarla)', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const m = await mkMsg(c.id, { dir: 'out', status: 'queued', at: ago(MIN), text: 'Hola', nextAttemptAt: ago(MIN) });
    await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { status: 'disabled' }));
    expect(await dispatch(m)).toEqual({ outcome: 'failed', code: 'channel_off' });
    expect((await msgRow(m)).error).toMatch(/desactivada/);
    await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { status: 'active' }));
    expect((await ok<Msg>(await call('POST', `/messages/${m}/retry`, T.carol))).status).toBe('sent');
  });

  it('un token que WhatsApp rechaza deja el mensaje fallido y avisa en la conexión', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const sealed = CredentialVault.fromConfig({ current: { version: 1, key: KEY }, previous: undefined })!.seal({ access_token: 'token-rechazado-0000' }, `channel/${channelA}`);
    await admin.query(`UPDATE channel_accounts SET credentials_sealed = $1, key_version = $2 WHERE id = $3`, [sealed.sealed, sealed.keyVersion, channelA]);
    const m = await ok<Msg>(await reply(T.carol, c.id, 'Hola'), 201);
    expect(m).toMatchObject({ status: 'failed', error: expect.stringMatching(/token/) });
    const ch = await ok<{ items: Array<{ last_error: string | null }> }>(await call('GET', '/channels', T.alice));
    expect(ch.items[0]!.last_error).toMatch(/rechaz/);
  });

  it('un mensaje no sale antes que otro anterior de su conversación que siga en cola', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const a = await mkMsg(c.id, { dir: 'out', status: 'queued', at: ago(2 * MIN), text: 'primero', attempts: 1, nextAttemptAt: new Date(Date.now() + HOUR) });
    const b = await mkMsg(c.id, { dir: 'out', status: 'queued', at: ago(MIN), text: 'segundo', nextAttemptAt: ago(MIN) });
    expect(await dispatch(b)).toEqual({ outcome: 'skipped' });
    expect(fake().outbox).toEqual([]);
    await admin.query(`UPDATE messages SET status = 'failed', next_attempt_at = NULL WHERE id = $1`, [a]); // el primero ya no está en cola
    expect(await dispatch(b)).toEqual({ outcome: 'sent' });
    expect(fake().outbox.map((x) => x.text)).toEqual(['segundo']);
  });

  it('dos envíos simultáneos del mismo mensaje: solo uno sale', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const m = await mkMsg(c.id, { dir: 'out', status: 'queued', at: ago(MIN), text: 'una sola vez', nextAttemptAt: ago(MIN) });
    const results = await Promise.all(Array.from({ length: 6 }, () => dispatch(m)));
    expect(results.filter((r) => r.outcome === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'skipped')).toHaveLength(5);
    expect(fake().outbox).toHaveLength(1);
    expect(await msgRow(m)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('la reserva de un envío en curso impide reenviarlo hasta que vence (si el proceso murió, otra pasada lo retoma)', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const t = Date.now();
    // como lo deja un proceso que reservó el mensaje y murió: un intento hecho y la reserva a 60 s
    const m = await mkMsg(c.id, { dir: 'out', status: 'queued', at: ago(MIN), text: 'retomado', attempts: 1, nextAttemptAt: new Date(t + 60_000) });
    expect(await dispatch(m, new Date(t))).toEqual({ outcome: 'skipped' });
    expect(await dispatch(m, new Date(t + 61_000))).toEqual({ outcome: 'sent' });
    expect(await msgRow(m)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(fake().outbox.map((x) => x.text)).toEqual(['retomado']);
  });

  it('la tarea periódica envía lo pendiente de la empresa; si el proveedor falla, deja el resto de esa conexión para la pasada siguiente', async () => {
    const c1 = await mkConv({ owner: IDS.carol });
    const c2 = await mkConv({ owner: IDS.carol });
    const c3 = await mkConv({ owner: IDS.carol });
    const m1 = await mkMsg(c1.id, { dir: 'out', status: 'queued', at: ago(5 * MIN), text: '[fallar:caida] x', nextAttemptAt: ago(3 * MIN) });
    const m2 = await mkMsg(c2.id, { dir: 'out', status: 'queued', at: ago(4 * MIN), text: 'segundo', nextAttemptAt: ago(2 * MIN) });
    const m3 = await mkMsg(c3.id, { dir: 'out', status: 'queued', at: ago(3 * MIN), text: 'tercero', nextAttemptAt: ago(MIN) });
    expect(await runDue()).toBe(1); // el primero falla y pausa la conexión
    expect(await msgRow(m1)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await msgRow(m2)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await msgRow(m3)).toMatchObject({ status: 'queued', attempts: 0 });
    await admin.query(`UPDATE messages SET status = 'failed', next_attempt_at = NULL WHERE id = $1`, [m1]);
    expect(await runDue()).toBe(2);
    expect(fake().outbox.map((x) => x.text)).toEqual(['segundo', 'tercero']);
    expect(await runDue()).toBe(0);
    // otra empresa no se toca
    const cb = await mkConv({ org: ORG_B });
    const mb = await mkMsg(cb.id, { dir: 'out', status: 'queued', at: ago(MIN), text: 'de B', nextAttemptAt: ago(MIN) }, ORG_B, channelB);
    expect(await runDue(new Date(), ORG_A)).toBe(0);
    expect((await msgRow(mb)).status).toBe('queued');
    expect(await runDue(new Date(), ORG_B)).toBe(1);
    expect(fake().outbox.map((x) => x.text)).toEqual(['segundo', 'tercero', 'de B']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('notas internas', () => {
  it('quien puede ver la conversación escribe una nota: no sale al cliente, no mueve la conversación y queda con su autor', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'working', unread: 2, lastMessage: ago(20 * MIN) });
    const before = await convRow(c.id);
    const n1 = await ok<Msg>(await call('POST', `/conversations/${c.id}/notes`, T.carol, { text: ' Prefiere hablar por la tarde ' }), 201);
    const n2 = await ok<Msg>(await call('POST', `/conversations/${c.id}/notes`, T.alice, { text: 'Revisar el descuento' }), 201); // el administrador, aunque no sea suya
    expect(n1).toMatchObject({ kind: 'note', is_note: true, status: 'internal', text: 'Prefiere hablar por la tarde', author: { name: 'Carolina Vera' }, direction: 'out' });
    expect(n2.author).toEqual({ id: IDS.alice, name: 'Alicia Torres' });
    expect(fake().outbox).toEqual([]);
    expect(await convRow(c.id)).toEqual(before);
    expect((await call('POST', `/conversations/${c.id}/notes`, T.eve, { text: 'x' })).status).toBe(404);
    const done = await mkConv({ owner: IDS.carol, status: 'closed' });
    await ok(await call('POST', `/conversations/${done.id}/notes`, T.carol, { text: 'cierre' }), 201); // también en una finalizada
  });

  it('ningún camino de envío toma una nota: ni la tarea, ni el reintento, ni la base de datos', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const n = await ok<Msg>(await call('POST', `/conversations/${c.id}/notes`, T.carol, { text: 'privado' }), 201);
    expect(await dispatch(n.id)).toEqual({ outcome: 'skipped' });
    expect(await runDue()).toBe(0);
    expect((await call('POST', `/messages/${n.id}/retry`, T.carol)).status).toBe(404);
    await expect(admin.query(`UPDATE messages SET status = 'queued', next_attempt_at = now() WHERE id = $1`, [n.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE messages SET kind = 'text' WHERE id = $1`, [n.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', 'text', 'x', 'internal', now())`, [ORG_A, c.id, channelA])).rejects.toMatchObject({ code: '23514' });
    expect(fake().outbox).toEqual([]);
  });

  it('valida el texto de la nota', async () => {
    const c = await mkConv({ owner: IDS.carol });
    for (const [body, label] of [[{}, 'sin texto'], [{ text: '  ' }, 'vacío'], [{ text: 'x'.repeat(4001) }, 'largo'], [{ text: 'a\u0000' }, 'NUL'], [{ text: 'x', otro: 1 }, 'extra']] as const) {
      expect((await call('POST', `/conversations/${c.id}/notes`, T.carol, body)).status, label).toBe(400);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('estados: aceptar, tomar, finalizar, leída', () => {
  it('aceptar: el dueño o quien ve todo pasa «pendiente» a «trabajando» (auditado); repetirlo no cambia nada; una sin asignar no se acepta; los demás no la ven', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'pending' });
    const v = await ok<Conv>(await call('POST', `/conversations/${c.id}/accept`, T.carol));
    expect(v).toMatchObject({ status: 'working', can: { accept: false, reply: true } });
    await ok(await call('POST', `/conversations/${c.id}/accept`, T.carol));
    expect((await audits(c.id)).map((a) => [a.field, a.old_value, a.new_value])).toEqual([['status', 'pending', 'working']]);
    const other = await mkConv({ owner: IDS.carol, status: 'pending' });
    expect((await call('POST', `/conversations/${other.id}/accept`, T.eve)).status).toBe(404);
    const byAdmin = await ok<Conv>(await call('POST', `/conversations/${other.id}/accept`, T.alice)); // ve todo: puede aceptarla
    expect(byAdmin.status).toBe('working');
    const free = await mkConv({});
    expect((await call('POST', `/conversations/${free.id}/accept`, T.carol)).status).toBe(404); // no la ve
    const rf = await call('POST', `/conversations/${free.id}/accept`, T.alice);
    expect([rf.status, await code(rf)]).toEqual([409, 'CONVERSATION_STATE']); // sin asignar: se toma, no se acepta
    const done = await mkConv({ owner: IDS.carol, status: 'closed' });
    expect(await code(await call('POST', `/conversations/${done.id}/accept`, T.carol))).toBe('CONVERSATION_STATE');
    expect((await convRow(other.id)).status).toBe('working');
  });

  it('tomar: quien ve todo toma una conversación sin asignar, que queda a su nombre «trabajando»; si el contacto no tenía responsable, se lo queda', async () => {
    const c = await mkConv({});
    expect((await call('POST', `/conversations/${c.id}/take`, T.carol)).status).toBe(403); // el asesor no ve lo sin asignar
    const v = await ok<Conv>(await call('POST', `/conversations/${c.id}/take`, T.alice));
    expect(v).toMatchObject({ status: 'working', owner: { id: IDS.alice, name: 'Alicia Torres' }, can: { reply: true, take: false } });
    const row = await convRow(c.id);
    expect(row).toMatchObject({ owner_id: IDS.alice, status: 'working' });
    expect(row.assigned_at).not.toBeNull();
    expect((await admin.query('SELECT owner_id FROM contacts WHERE id = $1', [c.contact])).rows[0].owner_id).toBe(IDS.alice);
    expect((await audits(c.id)).map((a) => [a.field, a.old_value, a.new_value, a.source])).toEqual([['owner_id', null, IDS.alice, 'manual'], ['status', 'unassigned', 'working', 'manual']]);
    expect((await audits(c.contact)).map((a) => [a.field, a.source])).toEqual([['owner_id', 'automation']]);
    await ok(await call('POST', `/conversations/${c.id}/take`, T.alice)); // repetirlo no cambia nada
    expect((await audits(c.id)).length).toBe(2);
    // ya tiene dueño: tomarla sería transferirla (M5.5)
    const owned = await mkConv({ owner: IDS.carol });
    expect(await code(await call('POST', `/conversations/${owned.id}/take`, T.alice))).toBe('CONVERSATION_STATE');
    // un contacto que ya tiene responsable lo conserva
    const c2 = await mkConv({});
    await admin.query('UPDATE contacts SET owner_id = $1 WHERE id = $2', [IDS.carol, c2.contact]);
    await ok(await call('POST', `/conversations/${c2.id}/take`, T.alice));
    expect((await admin.query('SELECT owner_id FROM contacts WHERE id = $1', [c2.contact])).rows[0].owner_id).toBe(IDS.carol);
  });

  it('tomar compite bien: de dos que la toman a la vez, gana uno', async () => {
    const c = await mkConv({});
    await admin.query(`UPDATE organization_members SET role = 'client_admin' WHERE user_id = $1 AND organization_id = $2`, [IDS.carol, ORG_A]);
    const tCarol = await login('carol@a.test');
    const rs = await Promise.all([call('POST', `/conversations/${c.id}/take`, T.alice), call('POST', `/conversations/${c.id}/take`, tCarol)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(['A', 'C']).toContain((await convRow(c.id)).owner_id === IDS.alice ? 'A' : 'C');
  });

  it('finalizar: el dueño o quien ve todo; limpia los no leídos, registra la hora y queda auditado; repetirlo no cambia nada', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'waiting', unread: 4 });
    const v = await ok<Conv>(await call('POST', `/conversations/${c.id}/close`, T.carol));
    expect(v).toMatchObject({ status: 'closed', unread_count: 0, can: { reply: false, close: false } });
    expect(v.closed_at).not.toBeNull();
    await ok(await call('POST', `/conversations/${c.id}/close`, T.carol));
    expect((await audits(c.id)).map((a) => [a.field, a.old_value, a.new_value])).toEqual([['status', 'waiting', 'closed']]);
    expect((await convRow(c.id)).owner_id).toBe(IDS.carol); // sigue siendo suya en el historial
    const theirs = await mkConv({ owner: IDS.carol });
    expect((await call('POST', `/conversations/${theirs.id}/close`, T.eve)).status).toBe(404);
    expect((await ok<Conv>(await call('POST', `/conversations/${theirs.id}/close`, T.alice))).status).toBe('closed'); // el administrador puede finalizar la de otra persona
    const free = await mkConv({});
    expect((await ok<Conv>(await call('POST', `/conversations/${free.id}/close`, T.alice))).status).toBe('closed'); // y una sin asignar
    expect(ids(await list(T.alice, '?tab=closed')).sort()).toEqual([c.id, theirs.id, free.id].sort());
  });

  it('marcar como leída: solo cuenta si la abre su dueño; un administrador que la mira no borra los pendientes del asesor', async () => {
    const c = await mkConv({ owner: IDS.carol, unread: 3 });
    expect((await ok<Conv>(await call('POST', `/conversations/${c.id}/read`, T.alice))).unread_count).toBe(3);
    expect((await ok<Conv>(await call('POST', `/conversations/${c.id}/read`, T.carol))).unread_count).toBe(0);
    expect((await convRow(c.id)).unread_count).toBe(0);
    expect((await call('POST', `/conversations/${c.id}/read`, T.eve)).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('de punta a punta con la entrada real de mensajes', () => {
  it('llega un cliente, se reparte, el asesor acepta y responde, el cliente vuelve a escribir y se finaliza; un mensaje nuevo abre otra conversación', async () => {
    await carolQueue();
    await ingest(phone(1), 'wamid.IN1');
    const [conv] = (await list(T.carol, '?tab=pending')).items;
    expect(conv).toMatchObject({ status: 'pending', unread_count: 1, owner: { id: IDS.carol }, contact: { phone: phone(1) }, tags: [{ system_key: 'lead' }], last_message: { direction: 'in', preview: 'Hola' }, window: { open: true }, can: { accept: true, reply: true } });
    expect((await convRow(conv!.id)).peer_id).toBe(phone(1).slice(1));
    await ok(await call('POST', `/conversations/${conv!.id}/accept`, T.carol));
    const m = await ok<Msg>(await reply(T.carol, conv!.id, 'Hola, ¿en qué te ayudo?'), 201);
    expect(m.status).toBe('sent');
    expect(fake().outbox).toEqual([expect.objectContaining({ to: phone(1).slice(1), text: 'Hola, ¿en qué te ayudo?' })]);
    expect(await convRow(conv!.id)).toMatchObject({ status: 'waiting', unread_count: 0 });
    await ingest(phone(1), 'wamid.IN2'); // el cliente contesta
    expect(await convRow(conv!.id)).toMatchObject({ status: 'working', unread_count: 1 });
    expect((await list(T.carol, '?tab=working')).counts).toEqual({ working: 1, pending: 0, closed: 0, unread: 1 });
    await ok(await call('POST', `/conversations/${conv!.id}/close`, T.carol));
    await ingest(phone(1), 'wamid.IN3');
    const rows = (await admin.query(`SELECT status FROM conversations WHERE organization_id = $1 ORDER BY created_at, id`, [ORG_A])).rows.map((r: { status: string }) => r.status);
    expect(rows).toEqual(['closed', 'pending']);
    const thread = await ok<MsgList>(await call('GET', `/conversations/${conv!.id}/messages`, T.carol));
    expect(thread.items.map((x) => [x.direction, x.text])).toEqual([['in', 'Hola'], ['out', 'Hola, ¿en qué te ayudo?'], ['in', 'Hola']]);
  });

  it('el estado de entrega que informa Meta se aplica al mensaje enviado, aunque llegue antes de que lo anotemos', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const t0 = new Date();
    const value = (id: string, status: string) => ({ messaging_product: 'whatsapp', metadata: { display_phone_number: '15550006789', phone_number_id: '1090123456789' }, statuses: [{ id, status, timestamp: String(Math.floor(t0.getTime() / 1000)), recipient_id: c.peer }] });
    const run = (now: Date) => inOrg(ORG_A, async () => app.get(WebhookEventsService).runDue(now, await app.get(OrgDirectoryService).current({ fresh: true })));
    const status = async (id: string) => (await admin.query('SELECT status FROM webhook_events WHERE id = $1', [id])).rows[0] as { status: string };
    const store = async (raw: Record<string, unknown>, at: Date) => {
      await inOrg(ORG_A, () => app.get(WebhookEventsService).store(channelA, '1090123456789', raw, at));
      return (await admin.query('SELECT id FROM webhook_events ORDER BY received_at DESC, id DESC LIMIT 1')).rows[0].id as string;
    };
    // el aviso llega primero: el mensaje aún no está anotado → el aviso queda pendiente unos segundos
    const ev = await store(value('wamid.CARRERA', 'delivered'), t0);
    expect(await run(new Date(t0.getTime() + 1_000))).toBe(1);
    expect(await status(ev)).toMatchObject({ status: 'pending' });
    expect((await admin.query('SELECT attempts FROM webhook_events WHERE id = $1', [ev])).rows[0].attempts).toBe(0);
    await mkMsg(c.id, { dir: 'out', status: 'sent', ext: 'wamid.CARRERA', at: t0, by: IDS.carol });
    expect(await run(new Date(t0.getTime() + 5_000))).toBe(0); // todavía no le toca
    expect(await run(new Date(t0.getTime() + 12_000))).toBe(1);
    expect(await status(ev)).toMatchObject({ status: 'done' });
    expect((await admin.query(`SELECT status, delivered_at FROM messages WHERE external_id = 'wamid.CARRERA'`)).rows[0]).toMatchObject({ status: 'delivered' });
    // un estado de un mensaje que nunca conoceremos se descarta pasados 2 minutos
    const old = await store(value('wamid.AJENO', 'read'), new Date(t0.getTime() - 3 * MIN));
    expect(await run(t0)).toBe(1);
    expect(await status(old)).toMatchObject({ status: 'done' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('base de datos', () => {
  it('rechaza lo que no tiene sentido: una nota que no es interna, un mensaje interno que no es nota, intentos negativos y un estado desconocido', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const insert = (kind: string, status: string, attempts = 0) =>
      admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at, attempts) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', $4, 'x', $5, now(), $6)`, [ORG_A, c.id, channelA, kind, status, attempts]);
    await expect(insert('note', 'sent')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('text', 'internal')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('text', 'queued', -1)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('text', 'enviando')).rejects.toMatchObject({ code: '23514' });
    await insert('note', 'internal');
    await insert('text', 'queued', 2);
  });
});
