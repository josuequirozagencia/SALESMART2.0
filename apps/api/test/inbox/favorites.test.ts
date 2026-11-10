// v10b (ADR-66) — Conversaciones «destacadas» con una estrella por persona. Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   PUT /v1/conversations/:id/favorite
//   DELETE /v1/conversations/:id/favorite
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
/** Una conversación con un mensaje del cliente (con identificador del proveedor), otro nuestro y una nota. */
async function mkConv(o: { org?: string; owner?: string | null; status?: string; lastInbound?: Date } = {}): Promise<{ id: string; inbound: string; outbound: string; note: string; phone: string; ext: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const channel = org === ORG_B ? channelB : channelA;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const status = o.status ?? (owner ? 'working' : 'unassigned');
  const phone = `+59398500${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [org, `Cliente ${seq}`])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const id = (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id, closed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 2, $9, $10) RETURNING id`,
      [org, contact, channel, status, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound ?? ago(HOUR), phone.slice(1), status === 'closed' ? new Date() : null],
    )
  ).rows[0].id as string;
  const ext = `wamid.IN.${seq}`;
  const mk = async (dir: 'in' | 'out', kind: string, extId: string | null): Promise<string> =>
    (
      await admin.query(
        `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, meta, status, sent_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'Hola', '{}'::jsonb, $8, $9) RETURNING id`,
        [org, id, channel, extId, dir, dir === 'in' ? 'contact' : 'human', kind, kind === 'note' ? 'internal' : dir === 'in' ? 'received' : 'sent', ago(HOUR)],
      )
    ).rows[0].id as string;
  return { id, inbound: await mk('in', 'text', ext), outbound: await mk('out', 'text', `wamid.OUT.${seq}`), note: await mk('out', 'note', null), phone, ext };
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
});


const star = (token: string, conv: string) => call('PUT', `/conversations/${conv}/favorite`, token);
const unstar = (token: string, conv: string) => call('DELETE', `/conversations/${conv}/favorite`, token);
interface View { id: string; favorite: boolean }
const list = async (token: string, q = ''): Promise<{ items: View[] }> => {
  const r = await call('GET', `/conversations?tab=working${q}`, token);
  expect(r.status).toBe(200);
  return json(r);
};
const stars = async (): Promise<Array<{ user_id: string; conversation_id: string; organization_id: string }>> => (await admin.query('SELECT user_id, conversation_id, organization_id FROM conversation_favorites ORDER BY created_at')).rows;

describe('estrella por persona', () => {
  it('poner la estrella la guarda para quien la puso y se ve en el detalle y el listado; quitarla la borra; repetir no cambia nada', async () => {
    const c = await mkConv();
    const r = await star(T.carol, c.id);
    expect(r.status).toBe(200);
    expect((await json<View>(r)).favorite).toBe(true);
    expect((await star(T.carol, c.id)).status).toBe(200); // repetir: sigue una sola
    expect(await stars()).toEqual([{ user_id: IDS.carol, conversation_id: c.id, organization_id: ORG_A }]);
    expect((await list(T.carol)).items.find((x) => x.id === c.id)?.favorite).toBe(true);
    expect((await json<View>(await call('GET', `/conversations/${c.id}`, T.carol))).favorite).toBe(true);
    const off = await unstar(T.carol, c.id);
    expect((await json<View>(off)).favorite).toBe(false);
    expect((await unstar(T.carol, c.id)).status).toBe(200); // quitar una que no está: tampoco cambia nada
    expect(await stars()).toEqual([]);
  });

  it('es PERSONAL: la estrella de una persona no la ve ni la quita otra, ni siquiera el administrador', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await star(T.carol, c.id);
    expect((await json<View>(await call('GET', `/conversations/${c.id}`, T.alice))).favorite).toBe(false); // el administrador la ve, pero sin estrella
    expect((await list(T.alice)).items.find((x) => x.id === c.id)?.favorite).toBe(false);
    expect((await list(T.alice, '&favorite=1')).items).toHaveLength(0);
    await star(T.alice, c.id);
    await unstar(T.alice, c.id); // quitar la suya no toca la de Carolina
    expect(await stars()).toEqual([{ user_id: IDS.carol, conversation_id: c.id, organization_id: ORG_A }]);
  });

  it('el filtro «favorite=1» trae solo las destacadas por quien pregunta, y respeta la pestaña', async () => {
    const a = await mkConv();
    const b = await mkConv();
    const closed = await mkConv({ status: 'closed' });
    await star(T.carol, a.id);
    await star(T.carol, closed.id);
    expect((await list(T.carol, '&favorite=1')).items.map((x) => x.id)).toEqual([a.id]);
    const all = await json<{ items: View[] }>(await call('GET', '/conversations?tab=closed&favorite=1', T.carol));
    expect(all.items.map((x) => x.id)).toEqual([closed.id]);
    expect((await list(T.carol)).items.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect((await call('GET', '/conversations?tab=working&favorite=0', T.carol)).status).toBe(400); // el filtro solo admite 1 o true
  });

  it('solo se puede destacar lo que se puede ver: una conversación ajena (de otro asesor) o inexistente da 404', async () => {
    const mine = await mkConv({ owner: IDS.carol });
    const evas = await mkConv({ owner: IDS.eve });
    expect((await star(T.carol, mine.id)).status).toBe(200);
    expect((await star(T.carol, evas.id)).status).toBe(404);
    expect((await unstar(T.carol, evas.id)).status).toBe(404);
    expect((await star(T.carol, '00000000-0000-4000-8000-000000000001')).status).toBe(404);
    expect(await stars()).toEqual([{ user_id: IDS.carol, conversation_id: mine.id, organization_id: ORG_A }]);
  });

  it('aislamiento A↔B: la empresa B no puede destacar una conversación de A (404) y su listado no trae nada de A', async () => {
    const a = await mkConv({ org: ORG_A });
    const b = await mkConv({ org: ORG_B, owner: IDS.bob });
    expect((await star(T.bob, a.id)).status).toBe(404);
    expect((await unstar(T.bob, a.id)).status).toBe(404);
    expect((await star(T.bob, b.id)).status).toBe(200);
    await star(T.alice, a.id);
    expect(await stars()).toEqual(expect.arrayContaining([{ user_id: IDS.bob, conversation_id: b.id, organization_id: ORG_B }, { user_id: IDS.alice, conversation_id: a.id, organization_id: ORG_A }]));
    expect((await list(T.bob, '&favorite=1')).items.map((x) => x.id)).toEqual([b.id]);
    expect((await list(T.alice, '&favorite=1')).items.map((x) => x.id)).toEqual([a.id]);
  });

  it('exige sesión; la base impide estrellas de otra empresa y solo app_rw las toca, sin UPDATE', async () => {
    const c = await mkConv();
    expect((await call('PUT', `/conversations/${c.id}/favorite`)).status).toBe(401);
    expect((await call('DELETE', `/conversations/${c.id}/favorite`)).status).toBe(401);
    // la clave foránea compuesta no admite una conversación de otra empresa
    await expect(admin.query(`INSERT INTO conversation_favorites(organization_id, conversation_id, user_id) VALUES ($1, $2, $3)`, [ORG_B, c.id, IDS.bob])).rejects.toThrow();
    const privs = async (role: string): Promise<string[]> => (await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'conversation_favorites' AND grantee = $1 ORDER BY privilege_type`, [role])).rows.map((r) => r.privilege_type as string);
    expect(await privs('app_rw')).toEqual(['DELETE', 'INSERT', 'SELECT']);
    expect(await privs('app_platform')).toEqual([]);
    expect(await privs('app_identity')).toEqual([]);
  });
});
