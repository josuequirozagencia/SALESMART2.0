// v13 S3.3 — Responder citando un mensaje (ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   POST /v1/conversations/:id/messages
//   GET /v1/conversations/:id/messages
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, OpportunitiesModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
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
let T: Record<'alice' | 'carol' | 'eve' | 'bob' | 'root', string>;
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
  await admin.query('TRUNCATE scheduled_messages, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
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
async function connect(token: string, phoneId: string, name: string, waba = '1234567890123'): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: waba, phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}


let seq = 0;
async function mkConv(o: { owner?: string | null; status?: string; org?: string; lastInbound?: Date | null; channel?: string } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const status = o.status ?? (owner ? 'working' : 'unassigned');
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING id`,
      [org, contact, o.channel ?? (org === ORG_B ? channelB : channelA), status, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, phone.slice(1)],
    )
  ).rows[0].id as string;
}
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte', '1234567890124');
  fake().outbox.length = 0;
});


interface Quote { id: string; direction: 'in' | 'out'; sender_type: string; author: { id: string; name: string } | null; kind: string; text: string | null }
interface Msg { id: string; text: string | null; status: string; reply_to: Quote | null }

/** Un mensaje ya guardado en la conversación (entrante o saliente), con o sin el identificador del proveedor. */
async function addMsg(conv: string, o: { dir?: 'in' | 'out'; ext?: string | null; body?: string | null; kind?: string; status?: string; by?: string | null } = {}): Promise<string> {
  const dir = o.dir ?? 'in';
  const kind = o.kind ?? 'text';
  const status = o.status ?? (kind === 'note' ? 'internal' : dir === 'in' ? 'received' : 'sent');
  const ext = o.ext === undefined ? `wamid.T${++seq}` : o.ext;
  return (
    await admin.query(
      `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at, created_by)
       SELECT gen_random_uuid(), organization_id, id, channel_account_id, $2, $3, $4, $5, $6, $7, now() - interval '5 minutes', $8 FROM conversations WHERE id = $1 RETURNING id`,
      [conv, ext, dir, dir === 'in' ? 'contact' : 'human', kind, o.body === undefined ? 'Hola' : o.body, status, o.by ?? null],
    )
  ).rows[0].id as string;
}
const reply = (token: string, conv: string, body: unknown) => call('POST', `/conversations/${conv}/messages`, token, body);
const replyOf = async (id: string) => (await admin.query(`SELECT reply_to_message_id FROM messages WHERE id = $1`, [id])).rows[0].reply_to_message_id as string | null;

describe('responder citando un mensaje', () => {
  it('guarda a cuál responde, lo manda al proveedor con su identificador y la vista trae la cita', async () => {
    const conv = await mkConv();
    const q = await addMsg(conv, { ext: 'wamid.C1', body: 'Quiero una cita para el viernes' });
    const sent = await ok<Msg>(await reply(T.carol, conv, { text: 'Claro, ¿a qué hora?', reply_to_message_id: q }), 201);
    expect(sent.reply_to).toEqual({ id: q, direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Quiero una cita para el viernes' });
    expect(sent.status).toBe('sent');
    expect(await replyOf(sent.id)).toBe(q);
    expect(fake().outbox).toHaveLength(1);
    expect(fake().outbox[0]).toMatchObject({ text: 'Claro, ¿a qué hora?', replyTo: { externalId: 'wamid.C1', fromMe: false, text: 'Quiero una cita para el viernes' } });
    // la lista del hilo también la trae; los mensajes sin cita llevan null
    const list = await ok<{ items: Msg[] }>(await call('GET', `/conversations/${conv}/messages`, T.carol));
    expect(list.items.find((m) => m.id === sent.id)!.reply_to).toMatchObject({ id: q, text: 'Quiero una cita para el viernes' });
    expect(list.items.find((m) => m.id === q)!.reply_to).toBeNull();
  });

  it('también se puede citar un mensaje NUESTRO (con quién lo escribió); el proveedor recibe fromMe', async () => {
    const conv = await mkConv();
    const mine = await addMsg(conv, { dir: 'out', ext: 'wamid.OUT1', body: 'Te espero a las 10', by: IDS.carol });
    const sent = await ok<Msg>(await reply(T.carol, conv, { text: 'Corrijo: a las 11', reply_to_message_id: mine }), 201);
    expect(sent.reply_to).toMatchObject({ id: mine, direction: 'out', sender_type: 'human', author: { id: IDS.carol, name: 'Carolina Vera' }, text: 'Te espero a las 10' });
    expect(fake().outbox[0]).toMatchObject({ replyTo: { externalId: 'wamid.OUT1', fromMe: true } });
  });

  it('sin `reply_to_message_id` el envío es el de siempre (sin cita)', async () => {
    const conv = await mkConv();
    const sent = await ok<Msg>(await reply(T.carol, conv, { text: 'Hola' }), 201);
    expect(sent.reply_to).toBeNull();
    expect(await replyOf(sent.id)).toBeNull();
    expect(fake().outbox[0]!.replyTo).toBeUndefined();
  });

  it('el mensaje citado debe ser de ESTA conversación y no una nota: si no, 404 uniforme (también uno de otra empresa); y debe haber salido ya', async () => {
    const conv = await mkConv();
    const other = await mkConv(); // otra conversación de la misma empresa
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const inOther = await addMsg(other, { ext: 'wamid.X1' });
    const inB = await addMsg(convB, { ext: 'wamid.B1' });
    const note = await addMsg(conv, { kind: 'note', dir: 'out', ext: null, by: IDS.carol });
    for (const id of [inOther, inB, note, NOBODY]) {
      const r = await reply(T.carol, conv, { text: 'Hola', reply_to_message_id: id });
      expect(r.status, id).toBe(404);
    }
    const notSent = await addMsg(conv, { dir: 'out', ext: null, status: 'failed', by: IDS.carol });
    expect(await code(await reply(T.carol, conv, { text: 'Hola', reply_to_message_id: notSent }))).toBe('REPLY_TARGET_NOT_SENT');
    expect((await reply(T.carol, conv, { text: 'Hola', reply_to_message_id: 'no-es-un-uuid' })).status).toBe(400);
    expect(fake().outbox).toEqual([]);
  });

  it('A↔B: la empresa B no puede citar un mensaje de A ni escribir en su conversación', async () => {
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const inA = await addMsg(convA, { ext: 'wamid.A1' });
    expect((await reply(T.bob, convB, { text: 'Hola', reply_to_message_id: inA })).status).toBe(404);
    expect((await reply(T.bob, convA, { text: 'Hola', reply_to_message_id: inA })).status).toBe(404);
  });

  it('con la ventana de 24 h cerrada no se responde (409 WINDOW_CLOSED) aunque cite; por GoHighLevel no hay citas (409 REPLY_UNSUPPORTED)', async () => {
    const closed = await mkConv({ lastInbound: ago(30 * HOUR) });
    const q = await addMsg(closed, { ext: 'wamid.W1' });
    expect(await code(await reply(T.carol, closed, { text: 'Hola', reply_to_message_id: q }))).toBe('WINDOW_CLOSED');
    const ghl = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, is_official, name, status) VALUES (gen_random_uuid(), $1, 'ghl', false, 'GoHighLevel', 'active') RETURNING id`, [ORG_A])).rows[0].id as string;
    const conv = await mkConv({ channel: ghl, lastInbound: ago(HOUR) });
    const g = await addMsg(conv, { ext: 'ghl-1' });
    expect(await code(await reply(T.carol, conv, { text: 'Hola', reply_to_message_id: g }))).toBe('REPLY_UNSUPPORTED');
  });

  it('si el citado pasa a ser una nota interna, el mensaje se ve sin cita (nunca se muestra una nota)', async () => {
    const conv = await mkConv();
    const q = await addMsg(conv, { ext: 'wamid.G1' });
    const sent = await ok<Msg>(await reply(T.carol, conv, { text: 'Va', reply_to_message_id: q }), 201);
    await admin.query(`UPDATE messages SET kind = 'note', status = 'internal', external_id = NULL WHERE id = $1`, [q]);
    const list = await ok<{ items: Msg[] }>(await call('GET', `/conversations/${conv}/messages`, T.carol));
    expect(list.items.find((m) => m.id === sent.id)!.reply_to).toBeNull();
  });
});

describe('base de datos', () => {
  it('la cita es una clave foránea compuesta de la misma empresa y no puede ser el propio mensaje', async () => {
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const a = await addMsg(convA, { ext: 'wamid.DB1' });
    const b = await addMsg(convB, { ext: 'wamid.DB2' });
    // un mensaje de B no puede citar a uno de A aunque se conozca el id (clave foránea compuesta con la empresa)
    await expect(admin.query(`UPDATE messages SET reply_to_message_id = $1 WHERE id = $2`, [a, b])).rejects.toThrow(/messages_reply_to_fk/);
    await expect(admin.query(`UPDATE messages SET reply_to_message_id = id WHERE id = $1`, [a])).rejects.toThrow(/messages_reply_not_self/);
  });
});
