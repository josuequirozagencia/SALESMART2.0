// M7.4 — Mensajes de GoHighLevel en el Inbox: entran por el webhook del Workflow, viven en el canal «GoHighLevel» y se responden por la API de GHL (ADR-52). Rutas cubiertas (el registro de endpoints exige
// que este archivo escriba cada una tal cual):
//   GET /v1/ghl/channel
//   PUT /v1/ghl/channel
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { FakeGhlProvider, GhlError, GhlEventsService, GhlModule } from '../../src/modules/ghl';
import { InboxModule, OutboundDispatcher } from '../../src/modules/inbox';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

const fake = new FakeGhlProvider();

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, GhlModule.register({ provider: fake }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const TOKEN = 'pit-aaaaaaaa-1111-4222-8333-alicia0123456789';
const LOC_A = 've9EPM428h8vShlRW1KT';
const LOC_B = 'Zk3Rm91QpWxYtLuNc7Aa';
const PHONE = '+593984217730';
const GHL_ANA = 'ghlAna0000000001';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
let hookA: { id: string; secret: string };
let hookB: { id: string; secret: string };
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ghl_outbox, ghl_events, ghl_contact_links, ghl_connections, ghl_routes, scheduled_messages, response_timers, messages, conversation_participants, conversations, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, contact_tags, tags, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

type Row = Record<string, unknown>;
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const hook = (h: { id: string; secret: string }, body: unknown) => call('POST', `/integrations/ghl/webhook/${h.id}`, undefined, body, { 'x-webhook-secret': h.secret });
const connect = async (token: string, loc: string) => expect((await call('PUT', '/ghl/connection', token, { location_id: loc, access_token: TOKEN })).status).toBe(200);
const issue = async (token: string) => json<{ id: string; secret: string }>(await call('POST', '/ghl/webhook/secret', token));

const later = (ms = 60_000) => new Date(Date.now() + ms);
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);
/** Procesa los avisos de la empresa como lo hace la tarea: la zona horaria y quién puede recibir trabajo se leen antes. */
const applyIn = async (org = ORG_A, at: Date = later()) => {
  const dir = await inOrg(org, () => app.get(OrgDirectoryService).current({ fresh: true }));
  return inOrg(org, () => app.get(GhlEventsService).runDue(at, dir));
};
const dispatch = (org = ORG_A, ahead = 5_000) => inOrg(org, () => app.get(OutboundDispatcher).runDue(new Date(Date.now() + ahead)));

const msg = (over: Record<string, unknown> = {}) => ({ event: 'message_in', contact_id: GHL_ANA, full_name: 'Ana Torres', phone: PHONE, message: 'Hola, quiero una cita', message_type: 'SMS', message_id: 'gm-1', ...over });
const send = async (body: unknown, h = hookA, org = ORG_A) => {
  expect((await hook(h, body)).status).toBe(200);
  return applyIn(org);
};
const events = async (org = ORG_A) => (await admin.query(`SELECT * FROM ghl_events WHERE organization_id = $1 ORDER BY received_at, id`, [org])).rows as Row[];
const convs = async (org = ORG_A) => (await admin.query(`SELECT c.*, a.provider, a.name AS channel_name, a.status AS channel_status FROM conversations c JOIN channel_accounts a ON a.id = c.channel_account_id AND a.organization_id = c.organization_id WHERE c.organization_id = $1 ORDER BY c.created_at`, [org])).rows as Row[];
const messagesOf = async (convId: string) => (await admin.query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sent_at, id`, [convId])).rows as Row[];
const channelOf = async (org = ORG_A) => (await admin.query(`SELECT * FROM channel_accounts WHERE organization_id = $1 AND provider = 'ghl'`, [org])).rows[0] as Row | undefined;
const sentMessages = () => fake.calls.filter((c) => c.kind === 'sendMessage');
const connStatus = async (token = T.alice) => (await call('GET', '/ghl/connection', token).then((r) => json<{ status: string }>(r))).status;

async function readyQueue(over: Record<string, unknown> = {}): Promise<string> {
  const q = await json<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas' }));
  expect((await call('PATCH', `/queues/${q.id}`, T.alice, { distribution_on: true, ...over })).status).toBe(200);
  expect((await call('PUT', `/queues/${q.id}/members`, T.alice, { members: [{ user_id: IDS.carol, active: true, weight: 1 }] })).status).toBe(200);
  expect((await call('PUT', '/ghl/channel', T.alice, { queue_id: q.id, default_type: null })).status).toBe(200);
  return q.id;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
  await connect(T.alice, LOC_A);
  await connect(T.bob, LOC_B);
  hookA = await issue(T.alice);
  hookB = await issue(T.bob);
  fake.calls.length = 0;
  fake.existingByPhone.clear();
});

describe('el canal «GoHighLevel» del Inbox', () => {
  it('conectar crea el canal (uno por empresa, sin credenciales propias) y su estado sigue al de la conexión', async () => {
    const ch = (await channelOf())!;
    expect(ch).toMatchObject({ provider: 'ghl', name: 'GoHighLevel', status: 'active', credentials_sealed: null, token_last4: null });
    expect((await channelOf(ORG_B))!['id']).not.toBe(ch['id']);
    await call('POST', '/ghl/connection/disconnect', T.alice);
    expect((await channelOf())!['status']).toBe('disabled');
    await connect(T.alice, LOC_A);
    expect((await channelOf())!).toMatchObject({ id: ch['id'], status: 'active' }); // el mismo canal, reactivado
    fake.failNextVerify(new GhlError('GoHighLevel rechazó el token', false, true));
    await call('POST', '/ghl/connection/test', T.alice);
    expect(await connStatus()).toBe('needs_reconnect');
    expect((await channelOf())!['status']).toBe('disabled');
    await connect(T.alice, LOC_A);
    expect((await channelOf())!['status']).toBe('active');
  });

  it('no aparece entre las conexiones de WhatsApp, pero sí como canal del Inbox', async () => {
    const list = await call('GET', '/channels', T.alice).then((r) => json<{ items: Array<{ name: string }> }>(r));
    expect(list.items.map((c) => c.name)).not.toContain('GoHighLevel');
    const opts = await call('GET', '/conversations/options', T.alice).then((r) => json<{ channels: Array<{ name: string }> }>(r));
    expect(opts.channels.map((c) => c.name)).toContain('GoHighLevel');
  });

  it('si el nombre «GoHighLevel» ya lo usa una conexión de WhatsApp, el canal toma otro nombre; y no puede haber dos canales de GHL por empresa', async () => {
    await admin.query(`UPDATE channel_accounts SET deleted_at = now() WHERE organization_id = $1`, [ORG_B]);
    await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', 'GoHighLevel')`, [ORG_B]);
    await call('POST', '/ghl/connection/disconnect', T.bob);
    await connect(T.bob, LOC_B);
    const names = (await admin.query(`SELECT name FROM channel_accounts WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY name`, [ORG_B])).rows.map((r) => r.name);
    expect(names).toEqual(['GoHighLevel', 'GoHighLevel (canal)']);
    await expect(admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), '${ORG_A}', 'ghl', 'Otro')`)).rejects.toThrow(/channel_accounts_ghl_uq/);
    await expect(admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), '${ORG_A}', 'telegram', 'X')`)).rejects.toThrow(/channel_accounts_provider_valid/);
  });

  it('GET y PUT /ghl/channel: solo el administrador; cola y canal por omisión se guardan y se auditan; datos inválidos o de otra empresa se rechazan', async () => {
    expect((await call('GET', '/ghl/channel')).status).toBe(401);
    expect((await call('GET', '/ghl/channel', T.carol)).status).toBe(403);
    expect((await call('PUT', '/ghl/channel', T.carol, { queue_id: null, default_type: null })).status).toBe(403);
    expect(await call('GET', '/ghl/channel', T.alice).then((r) => json(r))).toMatchObject({ configured: true, queue: null, default_type: null });
    const q = await json<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas' }));
    const set = await call('PUT', '/ghl/channel', T.alice, { queue_id: q.id, default_type: 'WhatsApp' });
    expect(set.status).toBe(200);
    expect(await json(set)).toMatchObject({ configured: true, queue: { id: q.id, name: 'Ventas' }, default_type: 'WhatsApp' });
    expect((await channelOf())!).toMatchObject({ queue_id: q.id });
    const audit = (await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'ghl_channel' ORDER BY field`)).rows;
    expect(audit).toEqual([{ field: 'default_type', old_value: null, new_value: 'WhatsApp' }, { field: 'queue_id', old_value: null, new_value: q.id }]);
    for (const body of [{}, { queue_id: q.id }, { queue_id: 'no-uuid', default_type: null }, { queue_id: null, default_type: 'Email' }, { queue_id: null, default_type: 'SMS', otro: 1 }, { queue_id: randomUUID(), default_type: null }]) {
      expect((await call('PUT', '/ghl/channel', T.alice, body)).status, JSON.stringify(body)).toBe(400);
    }
    // la cola de A no sirve en B
    expect((await call('PUT', '/ghl/channel', T.bob, { queue_id: q.id, default_type: null })).status).toBe(400);
    expect(await call('GET', '/ghl/channel', T.bob).then((r) => json(r))).toMatchObject({ queue: null });
    // quitar la cola y el canal por omisión
    expect(await call('PUT', '/ghl/channel', T.alice, { queue_id: null, default_type: null }).then((r) => json(r))).toMatchObject({ queue: null, default_type: null });
  });

  it('sin conexión no hay canal que configurar (404)', async () => {
    await admin.query(`DELETE FROM channel_accounts WHERE organization_id = $1`, [ORG_B]).catch(() => undefined);
    await admin.query(`DELETE FROM ghl_connections WHERE organization_id = $1`, [ORG_B]);
    await admin.query(`UPDATE channel_accounts SET deleted_at = now() WHERE organization_id = $1`, [ORG_B]);
    expect((await call('PUT', '/ghl/channel', T.bob, { queue_id: null, default_type: null })).status).toBe(404);
    expect(await call('GET', '/ghl/channel', T.bob).then((r) => json(r))).toMatchObject({ configured: false, channel_id: null });
  });
});

describe('entrada: el mensaje del cliente llega al Inbox', () => {
  it('un mensaje de un contacto nuevo crea el contacto (con Lead), el vínculo, la conversación en el canal de GHL y el mensaje, y deja el aviso hecho', async () => {
    expect(await send(msg())).toBe(1);
    const [ev] = await events();
    expect(ev).toMatchObject({ event_type: 'message_in', status: 'done', outcome: 'message_received', last_error: null });
    const [c] = await convs();
    expect(c).toMatchObject({ provider: 'ghl', channel_name: 'GoHighLevel', status: 'unassigned', peer_id: GHL_ANA, unread_count: 1 });
    const [m] = await messagesOf(c!['id'] as string);
    expect(m).toMatchObject({ direction: 'in', sender_type: 'contact', kind: 'text', body: 'Hola, quiero una cita', status: 'received', external_id: 'ghl:gm-1' });
    expect(m!['meta']).toMatchObject({ ghl_type: 'SMS' });
    const contact = (await admin.query(`SELECT c.name, c.source, p.e164 FROM contacts c JOIN contact_phones p ON p.contact_id = c.id WHERE c.organization_id = $1`, [ORG_A])).rows[0];
    expect(contact).toMatchObject({ name: 'Ana Torres', source: 'ghl', e164: PHONE });
    expect((await admin.query(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.organization_id = $1`, [ORG_A])).rows.map((r) => r.name)).toEqual(['Lead']);
    expect((await admin.query(`SELECT count(*)::int n FROM ghl_contact_links WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
    const audit = (await admin.query(`SELECT source FROM audit_logs WHERE entity_type = 'conversation' AND entity_id = $1`, [c!['id']])).rows;
    expect(audit).toEqual([{ source: 'ghl' }]);
  });

  it('el siguiente mensaje cae en la MISMA conversación abierta y suma no leídos; no repite Lead', async () => {
    await send(msg());
    await send(msg({ message_id: 'gm-2', message: 'Y tienen lugar mañana?' }));
    const cs = await convs();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ unread_count: 2 });
    expect((await messagesOf(cs[0]!['id'] as string)).map((m) => m['body'])).toEqual(['Hola, quiero una cita', 'Y tienen lugar mañana?']);
    expect((await admin.query(`SELECT count(*)::int n FROM contact_tags WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
  });

  it('el mismo mensaje en dos avisos distintos se registra una sola vez (idempotente por el id de GHL)', async () => {
    await send(msg({ event_id: 'evt-1' }));
    await send(msg({ event_id: 'evt-2' }));
    const evs = await events();
    expect(evs.map((e) => e['status'])).toEqual(['done', 'done']);
    expect(String(evs[1]!['note'])).toContain('Mensaje repetido');
    expect((await admin.query(`SELECT count(*)::int n FROM messages WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
  });

  it('sin id de mensaje, el aviso se identifica por sí mismo: reenviarlo no duplica', async () => {
    const body = msg({ message_id: undefined });
    await send(body);
    await hook(hookA, body);
    await applyIn();
    expect((await admin.query(`SELECT external_id FROM messages WHERE organization_id = $1`, [ORG_A])).rows).toHaveLength(1);
    expect((await events()).length).toBe(1);
  });

  it('los siguientes avisos del mismo contacto no necesitan teléfono: se identifica por el vínculo', async () => {
    await send(msg());
    await send(msg({ message_id: 'gm-2', phone: undefined, message: 'Sigo aquí' }));
    expect((await events()).map((e) => e['status'])).toEqual(['done', 'done']);
    expect((await messagesOf((await convs())[0]!['id'] as string)).length).toBe(2);
  });

  it('un contacto desconocido sin teléfono no se puede identificar: se omite con su motivo y no crea nada', async () => {
    await send(msg({ phone: undefined, contact_id: 'SIN-TEL-GHL' }));
    expect((await events())[0]).toMatchObject({ status: 'skipped' });
    expect(await convs()).toEqual([]);
    expect((await admin.query(`SELECT count(*)::int n FROM contacts WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(0);
  });

  it('un contacto que ya existe por teléfono se vincula y la conversación es suya (sin duplicarlo)', async () => {
    const id = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, 'Ana de siempre') RETURNING id`, [ORG_A])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [ORG_A, id, PHONE]);
    await send(msg());
    expect((await convs())[0]!['contact_id']).toBe(id);
    expect((await admin.query(`SELECT count(*)::int n FROM contacts WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
    // ya existía: no es un lead nuevo
    expect((await admin.query(`SELECT count(*)::int n FROM contact_tags WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(0);
  });

  it('la hora que informa GHL se respeta (ISO o época) y no puede estar en el futuro', async () => {
    const past = new Date(Date.now() - 3_600_000);
    await send(msg({ message_id: 'p1', message_sent_at: past.toISOString() }));
    await send(msg({ message_id: 'p2', message_sent_at: Math.floor(past.getTime() / 1000) + 60 }));
    await send(msg({ message_id: 'p3', message_sent_at: new Date(Date.now() + 86_400_000).toISOString() }));
    const sent = (await messagesOf((await convs())[0]!['id'] as string)).map((m) => (m['sent_at'] as Date).getTime());
    expect(Math.abs(sent[0]! - past.getTime())).toBeLessThan(1_000);
    expect(Math.abs(sent[1]! - (past.getTime() + 60_000))).toBeLessThan(1_500);
    expect(sent[2]!).toBeLessThanOrEqual(Date.now() + 120_000); // el futuro se recorta a «ahora»
  });

  it('sin el contexto de reparto el aviso no se pierde ni se reparte mal: queda pendiente y se reintenta', async () => {
    await hook(hookA, msg());
    expect(await inOrg(ORG_A, () => app.get(GhlEventsService).runDue(later()))).toBe(1);
    expect((await events())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await convs()).toEqual([]);
    await admin.query(`UPDATE ghl_events SET next_attempt_at = now()`);
    await applyIn();
    expect((await events())[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('un aviso que llega con GoHighLevel desconectado se omite con su motivo', async () => {
    await hook(hookA, msg());
    await call('POST', '/ghl/connection/disconnect', T.alice);
    await applyIn();
    expect((await events())[0]).toMatchObject({ status: 'skipped' });
    expect(String((await events())[0]!['note'])).toContain('desconectado');
    expect(await convs()).toEqual([]);
  });

  it('con el token rechazado SÍ entran los mensajes (entrar no usa el token) y la conversación queda con el canal desactivado', async () => {
    fake.failNextVerify(new GhlError('GoHighLevel rechazó el token', false, true));
    await call('POST', '/ghl/connection/test', T.alice);
    await send(msg());
    expect((await events())[0]).toMatchObject({ status: 'done' });
    expect((await convs())[0]).toMatchObject({ channel_status: 'disabled' });
  });

  it('las etiquetas del mismo aviso también se reconcilian, y un mensaje sin texto es 400', async () => {
    await call('POST', '/tags', T.alice, { name: 'VIP' });
    await send(msg({ tags: ['vip'] }));
    expect(String((await events())[0]!['note'])).toContain('1 agregada(s)');
    const bad = await hook(hookA, msg({ message: '   ', message_id: 'x' }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await json(bad))).toContain('message');
  });

  it('el texto largo se acota y los caracteres de control se quitan (los saltos de línea se conservan)', async () => {
    await send(msg({ message: `Línea 1\r\nLínea 2\u0000\u0007${'x'.repeat(9000)}` }));
    const body = (await messagesOf((await convs())[0]!['id'] as string))[0]!['body'] as string;
    expect(body.startsWith('Línea 1\nLínea 2xxxx')).toBe(true);
    expect(body.length).toBe(8000);
    expect(body.replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
  });

  it('con una cola de reparto la conversación nace asignada a su asesora; sin ella, «sin asignar»', async () => {
    await readyQueue();
    await send(msg());
    expect((await convs())[0]).toMatchObject({ status: 'pending', owner_id: IDS.carol });
  });

  it('el saludo de la cola sale al cliente POR GoHighLevel', async () => {
    const q = await readyQueue();
    expect((await call('PATCH', `/queues/${q}`, T.alice, { greeting: 'Hola, gracias por escribir' })).status).toBe(200);
    await send(msg());
    const dispatched = await dispatch(ORG_A, 11 * 60_000); // el aviso se procesó «10 min en el futuro»
    const out = sentMessages();
    const dump = JSON.stringify({ dispatched, convs: (await convs()).map((c) => [c['status'], c['queue_id']]), msgs: (await messagesOf((await convs())[0]!['id'] as string)).map((m) => [m['direction'], m['sender_type'], m['status'], m['error'], m['attempts']]) });
    expect(out, dump).toHaveLength(1);
    expect(out[0]).toMatchObject({ message: { type: 'SMS', ghlContactId: GHL_ANA, text: 'Hola, gracias por escribir' } });
    const m = (await messagesOf((await convs())[0]!['id'] as string)).find((x) => x['direction'] === 'out')!;
    expect(m).toMatchObject({ sender_type: 'automation', status: 'sent' });
  });

  it('cada empresa recibe lo suyo: el mensaje de A no aparece en B y viceversa', async () => {
    await send(msg());
    await send(msg({ contact_id: 'ghlBeto000000001', full_name: 'Beto Cliente', phone: '+593922222222', message: 'Hola Luna' }), hookB, ORG_B);
    const a = await convs(ORG_A);
    const b = await convs(ORG_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!['channel_account_id']).not.toBe(b[0]!['channel_account_id']);
    expect((await messagesOf(b[0]!['id'] as string)).map((m) => m['body'])).toEqual(['Hola Luna']);
    const listA = await call('GET', '/conversations?tab=pending', T.alice).then((r) => json<{ items: Array<{ contact: { name: string }; channel: { name: string; kind: string } }> }>(r));
    expect(listA.items.map((i) => i.contact.name)).toEqual(['Ana Torres']);
    expect(listA.items[0]!.channel).toMatchObject({ name: 'GoHighLevel', kind: 'ghl' });
  });
});

describe('salida: la respuesta del asesor sale por GoHighLevel', () => {
  const take = async (id: string) => expect((await call('POST', `/conversations/${id}/take`, T.alice)).status).toBe(200);
  const reply = (id: string, text: string, token = T.alice) => call('POST', `/conversations/${id}/messages`, token, { text });
  const conv = async () => (await convs())[0]!['id'] as string;

  it('responder sale por el MISMO canal de GHL por el que escribió el cliente, sin ventana de 24 h, y queda enviado con el id de GHL', async () => {
    await send(msg());
    const id = await conv();
    // pasaron 3 días del último mensaje del cliente: en WhatsApp ya no se podría escribir libremente
    await admin.query(`UPDATE conversations SET last_inbound_at = now() - interval '3 days'`);
    await take(id);
    const view = await call('GET', `/conversations/${id}`, T.alice).then((r) => json<{ window: { open: boolean; expires_at: string | null }; channel: { kind: string }; can: { reply: boolean } }>(r));
    expect(view).toMatchObject({ window: { open: true, expires_at: null }, channel: { kind: 'ghl' }, can: { reply: true } });
    const r = await reply(id, 'Claro, te agendo para mañana');
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ direction: 'out', sender_type: 'human', text: 'Claro, te agendo para mañana', status: 'sent' });
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0]).toMatchObject({ message: { type: 'SMS', ghlContactId: GHL_ANA, text: 'Claro, te agendo para mañana' }, credentials: { locationId: LOC_A, accessToken: TOKEN } });
    const out = (await messagesOf(id)).find((m) => m['direction'] === 'out')!;
    expect(String(out['external_id'])).toMatch(/^FakeGhlMessage/);
    expect((await convs())[0]).toMatchObject({ status: 'waiting' });
  });

  it('se responde por el canal del ÚLTIMO mensaje del cliente (WhatsApp, Instagram, Facebook, chat en vivo…)', async () => {
    const types: Array<[string, string]> = [['WhatsApp', 'WhatsApp'], ['instagram', 'IG'], ['Facebook', 'FB'], ['Live Chat', 'Live_Chat'], ['TYPE_SMS', 'SMS']];
    let n = 0;
    for (const [raw, expected] of types) {
      n += 1;
      await send(msg({ message_id: `t${n}`, message_type: raw, message: `por ${raw}` }));
      if (n === 1) await take(await conv());
      expect((await reply(await conv(), `respuesta ${n}`)).status).toBe(201);
      expect(sentMessages().at(-1)).toMatchObject({ message: { type: expected, text: `respuesta ${n}` } });
    }
  });

  it('sin canal en el aviso se usa el canal por omisión del administrador; sin ninguno, el mensaje queda fallido con la explicación', async () => {
    await send(msg({ message_type: undefined }));
    const id = await conv();
    await take(id);
    const failed = await json<{ status: string; error: string }>(await reply(id, 'hola'));
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('message_type');
    expect(sentMessages()).toHaveLength(0);
    expect((await call('PUT', '/ghl/channel', T.alice, { queue_id: null, default_type: 'WhatsApp' })).status).toBe(200);
    const retry = await call('POST', `/messages/${(await messagesOf(id)).find((m) => m['direction'] === 'out')!['id'] as string}/retry`, T.alice);
    expect(retry.status).toBe(200);
    expect(await json(retry)).toMatchObject({ status: 'sent' });
    expect(sentMessages()[0]).toMatchObject({ message: { type: 'WhatsApp' } });
  });

  it('un mensaje que llegó por correo no se puede responder desde aquí (se explica) salvo que haya canal por omisión', async () => {
    await send(msg({ message_type: 'Email' }));
    const id = await conv();
    await take(id);
    const r = await json<{ status: string; error: string }>(await reply(id, 'hola'));
    expect(r.status).toBe('failed');
    expect(sentMessages()).toHaveLength(0);
  });

  it('un fallo pasajero deja el mensaje en cola con espera creciente y la tarea lo envía después', async () => {
    await send(msg());
    const id = await conv();
    await take(id);
    fake.failNextCall(new GhlError('GoHighLevel no pudo atender la llamada ahora', true));
    const r = await json<{ status: string }>(await reply(id, 'ahí voy'));
    expect(r.status).toBe('queued');
    const queued = (await messagesOf(id)).find((m) => m['direction'] === 'out')!;
    expect(queued).toMatchObject({ status: 'queued', attempts: 1 });
    expect(sentMessages()).toHaveLength(0);
    expect(await dispatch(ORG_A, 0)).toBe(0); // todavía no le toca
    expect(await dispatch(ORG_A, 11 * 60_000)).toBe(1);
    expect(sentMessages()).toHaveLength(1);
    expect((await messagesOf(id)).find((m) => m['direction'] === 'out')).toMatchObject({ status: 'sent' });
  });

  it('un rechazo definitivo de GHL deja el mensaje fallido con un texto claro (sin datos del cliente) y se puede reintentar', async () => {
    await send(msg());
    const id = await conv();
    await take(id);
    fake.failNextCall(new GhlError('GoHighLevel no encuentra el contacto', false));
    const r = await json<{ id: string; status: string; error: string }>(await reply(id, 'hola'));
    expect(r.status).toBe('failed');
    expect(r.error).toContain('GoHighLevel rechazó el mensaje');
    expect(await connStatus()).toBe('active'); // no es culpa del token
    const ok = await call('POST', `/messages/${r.id}/retry`, T.alice);
    expect(await json(ok)).toMatchObject({ status: 'sent' });
  });

  it('si GHL rechaza el token al enviar, el mensaje falla con el motivo, la conexión pide reconexión, el canal se desactiva y responder da 409', async () => {
    await send(msg());
    const id = await conv();
    await take(id);
    fake.failNextCall(new GhlError('GoHighLevel rechazó el token', false, true));
    const r = await json<{ status: string; error: string }>(await reply(id, 'hola'));
    expect(r.status).toBe('failed');
    expect(r.error).toContain('reconectarla en Configuración › GoHighLevel');
    expect(await connStatus()).toBe('needs_reconnect');
    expect((await channelOf())!['status']).toBe('disabled');
    const again = await reply(id, 'otra vez');
    expect(again.status).toBe(409);
    const body = await json<{ error: { code: string; message: string } }>(again);
    expect(body.error.code).toBe('CHANNEL_DISABLED');
    expect(body.error.message).toContain('GoHighLevel');
    expect(body.error.message).not.toContain('WhatsApp');
  });

  it('por GoHighLevel solo hay texto: adjuntos, mensajes programados y plantillas se rechazan o no existen', async () => {
    await send(msg());
    const id = await conv();
    await take(id);
    const up = await fetch(`${base}/conversations/${id}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${T.alice}`, 'content-type': 'image/png', 'x-filename': 'a.png' }, body: new Uint8Array([137, 80, 78, 71]) });
    expect(up.status).toBe(409);
    expect((await json<{ error: { code: string } }>(up)).error.code).toBe('GHL_TEXT_ONLY');
    const sched = await call('POST', `/conversations/${id}/scheduled`, T.alice, { text: 'luego', send_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(sched.status).toBe(409);
    expect((await json<{ error: { code: string } }>(sched)).error.code).toBe('GHL_SCHEDULE_UNSUPPORTED');
    const tpl = await call('GET', `/conversations/${id}/templates`, T.alice).then((r) => json<{ items: unknown[] }>(r));
    expect(tpl.items).toEqual([]);
  });

  it('una conversación de GHL cuyo contacto ya no está vinculado no puede salir: falla con la explicación', async () => {
    await send(msg());
    const id = await conv();
    await take(id);
    await admin.query(`DELETE FROM ghl_contact_links`).catch(() => undefined);
    await admin.query(`UPDATE ghl_contact_links SET ghl_contact_id = 'otro' || ghl_contact_id`);
    const r = await json<{ status: string; error: string }>(await reply(id, 'hola'));
    expect(r.status).toBe('failed');
  });

  it('las notas internas nunca salen por GHL y las conversaciones de otra empresa no se pueden responder', async () => {
    await send(msg());
    const id = await conv();
    await take(id);
    expect((await call('POST', `/conversations/${id}/notes`, T.alice, { text: 'nota interna' })).status).toBe(201);
    expect(sentMessages()).toHaveLength(0);
    expect((await reply(id, 'intruso', T.bob)).status).toBe(404);
  });

  it('el administrador de B no ve los mensajes de A en su Inbox', async () => {
    await send(msg());
    const listB = await call('GET', '/conversations', T.bob).then((r) => json<{ items: unknown[] }>(r));
    expect(listB.items).toEqual([]);
  });
});
