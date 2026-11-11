// v11 S2 — a qué conversación lleva el icono «Mensaje» de un contacto. Ruta cubierta (el registro de endpoints exige que este archivo la escriba tal cual):
//   GET /v1/contacts/:contactId/conversation
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
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
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
let channelA2 = ''; // segunda conexión de A: «una conversación abierta por contacto y canal» obliga a usar otro canal para tener dos abiertas
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
  await admin.query('TRUNCATE conversation_favorites, messages, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma', 'UTC'], [ORG_A, 'client', 'Barbería Norte', 'America/Guayaquil'], [ORG_B, 'client', 'Estudio Luna', 'UTC']];
  for (const [id, kind, name, tz] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, tz]);
  const users: Array<[string, string, string]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', 'Root']];
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
async function connect(token: string, phoneId: string, name: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

let seq = 0;
async function mkContact(org: string): Promise<string> {
  seq += 1;
  return (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [org, `Cliente ${seq}`])).rows[0].id as string;
}
/** Una conversación de ese contacto con el estado, el dueño y la hora del último mensaje que se pidan. */
async function mkConv(contact: string, o: { org?: string; owner?: string | null; status?: string; last?: Date; deleted?: boolean; second?: boolean } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const channel = org === ORG_B ? channelB : o.second ? channelA2 : channelA;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const status = o.deleted ? 'closed' : (o.status ?? 'working'); // una conversación eliminada siempre queda finalizada (conversations_deleted_closed)
  return (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, peer_id, closed_at, deleted_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [org, contact, channel, status, owner, owner ? new Date() : null, o.last ?? ago(HOUR), `59398600${String(seq).padStart(4, '0')}`, status === 'closed' ? new Date() : null, o.deleted ? new Date() : null],
    )
  ).rows[0].id as string;
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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte');
  channelA2 = await connect(T.alice, '1090123456781', 'Soporte A');
});


const of = (token: string | undefined, contact: string) => call('GET', `/contacts/${contact}/conversation`, token);
const NONE = '00000000-0000-4000-8000-000000000001';
interface Err { error: { code: string } }

describe('conversación de un contacto', () => {
  it('devuelve la conversación ABIERTA más reciente aunque haya otra finalizada más nueva', async () => {
    const k = await mkContact(ORG_A);
    const oldOpen = await mkConv(k, { last: ago(5 * HOUR) });
    const newerOpen = await mkConv(k, { last: ago(2 * HOUR), second: true });
    await mkConv(k, { status: 'closed', last: ago(5 * MIN) });
    const r = await of(T.carol, k);
    expect(r.status).toBe(200);
    expect(await json<{ conversation_id: string }>(r)).toEqual({ conversation_id: newerOpen });
    expect(oldOpen).not.toBe(newerOpen);
  });

  it('sin ninguna abierta devuelve la más reciente; una «pendiente» o «sin asignar» también cuenta como abierta', async () => {
    const k = await mkContact(ORG_A);
    await mkConv(k, { status: 'closed', last: ago(9 * HOUR) });
    const recent = await mkConv(k, { status: 'closed', last: ago(3 * HOUR) });
    expect((await json<{ conversation_id: string }>(await of(T.carol, k))).conversation_id).toBe(recent);
    const pending = await mkConv(k, { status: 'pending', last: ago(8 * HOUR), second: true });
    expect((await json<{ conversation_id: string }>(await of(T.carol, k))).conversation_id).toBe(pending);
  });

  it('sin conversaciones, con un contacto inexistente o con una conversación eliminada: el mismo 404 NO_CONVERSATION', async () => {
    const empty = await mkContact(ORG_A);
    const deletedOnly = await mkContact(ORG_A);
    await mkConv(deletedOnly, { deleted: true });
    for (const k of [empty, deletedOnly, NONE]) {
      const r = await of(T.alice, k);
      expect(r.status, k).toBe(404);
      expect((await json<Err>(r)).error.code).toBe('NO_CONVERSATION');
    }
  });

  it('visibilidad por persona: la asesora solo llega a lo que ve; el administrador, a todo; lo ajeno responde igual que lo inexistente', async () => {
    const k = await mkContact(ORG_A);
    const evas = await mkConv(k, { owner: IDS.eve });
    const carolRes = await of(T.carol, k);
    expect(carolRes.status).toBe(404);
    expect((await json<Err>(carolRes)).error.code).toBe('NO_CONVERSATION');
    expect((await json<{ conversation_id: string }>(await of(T.alice, k))).conversation_id).toBe(evas);
    const mine = await mkConv(k, { owner: IDS.carol, last: ago(7 * HOUR), second: true });
    expect((await json<{ conversation_id: string }>(await of(T.carol, k))).conversation_id).toBe(mine); // de las suyas, aunque la de Eva sea más nueva
  });

  it('aislamiento A↔B: la empresa B no llega a un contacto de A (404) ni A a uno de B', async () => {
    const ka = await mkContact(ORG_A);
    const kb = await mkContact(ORG_B);
    const ca = await mkConv(ka);
    const cb = await mkConv(kb, { org: ORG_B, owner: IDS.bob });
    expect((await of(T.bob, ka)).status).toBe(404);
    expect((await of(T.alice, kb)).status).toBe(404);
    expect((await json<{ conversation_id: string }>(await of(T.alice, ka))).conversation_id).toBe(ca);
    expect((await json<{ conversation_id: string }>(await of(T.bob, kb))).conversation_id).toBe(cb);
  });

  it('sin sesión es 401 y un identificador mal formado es 400', async () => {
    const k = await mkContact(ORG_A);
    await mkConv(k);
    expect((await of(undefined, k)).status).toBe(401);
    expect((await of(T.alice, 'no-es-un-uuid')).status).toBe(400);
  });
});
