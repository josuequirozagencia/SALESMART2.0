// M5.8 — Reaccionar a un mensaje del cliente (ADR-50). Ruta cubierta (el registro de endpoints exige que este archivo la escriba tal cual):
//   PUT /v1/conversations/:id/messages/:messageId/reaction
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
  await admin.query('TRUNCATE messages, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
async function connect(token: string, phoneId: string, name: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

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
const meta = async (id: string): Promise<Record<string, unknown>> => (await admin.query('SELECT meta FROM messages WHERE id = $1', [id])).rows[0].meta as Record<string, unknown>;
const convState = async (id: string) => (await admin.query('SELECT status, unread_count, last_message_at FROM conversations WHERE id = $1', [id])).rows[0] as { status: string; unread_count: number; last_message_at: Date };
const count = async (conv: string): Promise<number> => Number((await admin.query('SELECT count(*) FROM messages WHERE conversation_id = $1', [conv])).rows[0].count);
const react = (token: string, conv: string, msg: string, emoji: string | null) => call('PUT', `/conversations/${conv}/messages/${msg}/reaction`, token, { emoji });

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
  fake().reactions.length = 0;
});

describe('reaccionar a un mensaje del cliente', () => {
  it('la dueña reacciona: sale por el proveedor al mensaje correcto, se guarda sobre el mensaje y NO crea un mensaje ni mueve la conversación', async () => {
    const c = await mkConv();
    const before = await convState(c.id);
    const r = await react(T.carol, c.id, c.inbound, '👍');
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ id: c.inbound, my_reaction: '👍' });
    expect(fake().reactions).toHaveLength(1);
    expect(fake().reactions[0]).toMatchObject({ phoneNumberId: '1090123456789', to: c.phone.slice(1), targetExternalId: c.ext, emoji: '👍' });
    expect((await meta(c.inbound))['my_reaction']).toBe('👍');
    expect(await count(c.id)).toBe(3); // los mismos tres de antes: una reacción no es un mensaje
    const after = await convState(c.id);
    expect(after.status).toBe(before.status);
    expect(after.unread_count).toBe(before.unread_count);
    expect(after.last_message_at.getTime()).toBe(before.last_message_at.getTime());
    // se ve en el hilo, sin filtrarse como dato interno
    const thread = await json<{ items: Array<{ id: string; my_reaction: string | null; extra: Record<string, unknown> | null }> }>(await call('GET', `/conversations/${c.id}/messages`, T.carol));
    const m = thread.items.find((x) => x.id === c.inbound)!;
    expect(m.my_reaction).toBe('👍');
    expect(m.extra).toBeNull();
  });

  it('cambiar de emoji reemplaza la reacción y null la quita', async () => {
    const c = await mkConv();
    expect((await react(T.carol, c.id, c.inbound, '❤️')).status).toBe(200);
    expect((await react(T.carol, c.id, c.inbound, '😂')).status).toBe(200);
    expect((await meta(c.inbound))['my_reaction']).toBe('😂');
    const r = await react(T.carol, c.id, c.inbound, null);
    expect(await json(r)).toEqual({ id: c.inbound, my_reaction: null });
    expect((await meta(c.inbound))['my_reaction']).toBeUndefined();
    expect(fake().reactions.map((x) => x.emoji)).toEqual(['❤️', '😂', '']);
  });

  it('la administradora (ve todo) también puede; una asesora que no es dueña no ve la conversación (404)', async () => {
    const c = await mkConv();
    expect((await react(T.alice, c.id, c.inbound, '👍')).status).toBe(200);
    expect((await react(T.eve, c.id, c.inbound, '👍')).status).toBe(404);
    expect(fake().reactions).toHaveLength(1);
  });

  it('solo reacciona a mensajes DEL CLIENTE de esa conversación: uno propio, una nota o uno ajeno dan 404', async () => {
    const c = await mkConv();
    const other = await mkConv();
    for (const m of [c.outbound, c.note, other.inbound, '11111111-1111-4111-8111-111111111111']) expect((await react(T.carol, c.id, m, '👍')).status, m).toBe(404);
    expect(fake().reactions).toHaveLength(0);
  });

  it('fuera de las 24 h: 409 WINDOW_CLOSED; con la conversación finalizada o sin asesor, también 409; nada sale', async () => {
    const old = await mkConv({ lastInbound: ago(25 * HOUR) });
    const r = await react(T.carol, old.id, old.inbound, '👍');
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('WINDOW_CLOSED');
    const closed = await mkConv({ status: 'closed' });
    expect(await code(await react(T.carol, closed.id, closed.inbound, '👍'))).toBe('CONVERSATION_CLOSED');
    const unassigned = await mkConv({ owner: null });
    expect((await react(T.alice, unassigned.id, unassigned.inbound, '👍')).status).toBe(409);
    expect(fake().reactions).toHaveLength(0);
  });

  it('valida el cuerpo: un texto que no es emoji, demasiado largo o campos de más dan 400', async () => {
    const c = await mkConv();
    for (const body of [{ emoji: 'hola' }, { emoji: '👍'.repeat(20) }, { emoji: 5 }, {}, { emoji: '👍', extra: 1 }]) {
      expect((await call('PUT', `/conversations/${c.id}/messages/${c.inbound}/reaction`, T.carol, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(fake().reactions).toHaveLength(0);
  });

  it('si el proveedor rechaza o no responde, la petición falla con 409 y no se guarda nada', async () => {
    const c = await mkConv();
    await admin.query(`UPDATE messages SET external_id = '[fallar:rechazo]x' WHERE id = $1`, [c.inbound]);
    const r = await react(T.carol, c.id, c.inbound, '👍');
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('REACTION_REJECTED');
    expect((await meta(c.inbound))['my_reaction']).toBeUndefined();
    // el número de la conexión ya no responde
    await admin.query(`UPDATE whatsapp_accounts SET phone_number_id = '99999999' WHERE channel_account_id = $1`, [channelA]);
    const d = await mkConv();
    const r2 = await react(T.carol, d.id, d.inbound, '👍');
    expect(r2.status).toBe(409);
    expect(await code(r2)).toBe('REACTION_UNAVAILABLE');
  });

  it('por un canal sin reacciones (QR/GoHighLevel) responde 409 REACTION_UNSUPPORTED', async () => {
    const c = await mkConv();
    await admin.query(`UPDATE channel_accounts SET provider = 'evolution' WHERE id = $1`, [channelA]);
    const r = await react(T.carol, c.id, c.inbound, '👍');
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('REACTION_UNSUPPORTED');
  });
});

describe('aislamiento A↔B y permisos', () => {
  it('sin sesión 401; la plataforma 403; la administradora de B no ve ni mueve nada de A (404)', async () => {
    const a = await mkConv();
    expect((await call('PUT', `/conversations/${a.id}/messages/${a.inbound}/reaction`, undefined, { emoji: '👍' })).status).toBe(401);
    expect((await react(T.root, a.id, a.inbound, '👍')).status).toBe(403);
    expect((await react(T.bob, a.id, a.inbound, '👍')).status).toBe(404);
    const b = await mkConv({ org: ORG_B, owner: IDS.bob });
    expect((await react(T.alice, b.id, b.inbound, '👍')).status).toBe(404);
    // un mensaje de A con la conversación de B en la ruta: tampoco
    expect((await react(T.bob, b.id, a.inbound, '👍')).status).toBe(404);
    expect(fake().reactions).toHaveLength(0);
    expect((await meta(a.inbound))['my_reaction']).toBeUndefined();
  });
});
