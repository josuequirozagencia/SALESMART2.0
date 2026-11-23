// V21.2 — Enviar un archivo de la biblioteca desde el chat (ADR-75 #3: se COPIA a un adjunto propio). Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   POST /v1/conversations/:id/library/:assetId/send
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { StorageGateway } from '../../src/modules/attachments';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { LibraryModule } from '../../src/modules/library';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, LibraryModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A, dueña de la conversación
  eve: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob', string>;
let channelA = '';
let channelB = '';
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE media_assets, media_folders, message_attachments, messages, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
async function connect(token: string, phoneId: string, name: string, waba = '1234567890123'): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: waba, phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

let seq = 0;
async function mkConv(o: { owner?: string | null; org?: string; lastInbound?: Date | null } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, $5, $6, $7, 1, $8) RETURNING id`, [org, contact, org === ORG_B ? channelB : channelA, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, phone.slice(1)])).rows[0].id as string;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 5)]);
interface Asset { id: string; usable_by_advisors: boolean }
interface ChatMsg { id: string; kind: string; text: string | null; attachment: { id: string; kind: string } | null; status: string }
const asset = async (token: string, name = 'foto.jpg'): Promise<Asset> => {
  const r = await fetch(`${base}/library/assets`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent(name), authorization: `Bearer ${token}` }, body: JPEG });
  expect(r.status).toBe(201);
  return json<Asset>(r);
};
const send = (token: string | undefined, conv: string, id: string, body: unknown = {}) => call('POST', `/conversations/${conv}/library/${id}/send`, token, body);
const attachments = async () => (await admin.query(`SELECT * FROM message_attachments ORDER BY created_at`)).rows as Array<Record<string, unknown>>;
const storage = () => app.get(StorageGateway);

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'REQUIRE_VIRUS_SCAN']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte', '1234567890124');
});

describe('enviar desde la biblioteca', () => {
  it('la asesora envía un archivo a su conversación con pie: sale como imagen con una COPIA propia; el original queda intacto, también tras archivarlo, y la copia vencida no lo toca', async () => {
    const conv = await mkConv();
    const a = await asset(T.alice);
    const r = await send(T.carol, conv, a.id, { caption: 'Mira nuestros cortes' });
    expect(r.status, await r.clone().text()).toBe(201);
    const m = await json<ChatMsg>(r);
    expect(m).toMatchObject({ kind: 'image', text: 'Mira nuestros cortes', attachment: { kind: 'image' } });
    const [copy] = await attachments();
    expect(copy).toMatchObject({ conversation_id: conv, direction: 'out', kind: 'image', state: 'ready', created_by: IDS.carol, message_id: m.id });
    const libraryKey = `org/${ORG_A}/library/${a.id}`;
    expect(String(copy!['storage_key'])).toMatch(new RegExp(`^org/${ORG_A}/attachments/`));
    expect(copy!['storage_key']).not.toBe(libraryKey);
    expect((await admin.query(`SELECT state FROM media_assets WHERE id = $1`, [a.id])).rows[0].state).toBe('ready');
    // archivar el original no rompe lo ya enviado
    expect((await call('POST', `/library/assets/${a.id}/archive`, T.alice)).status).toBe(200);
    expect((await call('GET', `/attachments/${m.attachment!.id}/url`, T.carol)).status).toBe(200);
    // la copia vence y se borra: el archivo de la biblioteca sigue ahí
    await admin.query(`UPDATE message_attachments SET state = 'expired'`);
    await TenantContext.run({ organizationId: ORG_A }, () => storage().delete(String(copy!['storage_key'])));
    expect((await TenantContext.run({ organizationId: ORG_A }, () => storage().get(libraryKey))).length).toBe(404);
    // y la auditoría registra el envío sin la clave ni el contenido
    const audit = JSON.stringify((await admin.query(`SELECT field, new_value FROM audit_logs WHERE entity_type = 'media_asset' AND field = 'sent'`)).rows);
    expect(audit).toContain(conv);
    expect(audit).not.toContain('org/');
    expect(audit).not.toContain('library/');
  });

  it('la asesora solo envía lo marcado para asesores y vigente; el administrador sí envía lo interno; lo de otra empresa nunca (404) y no se copia nada', async () => {
    const conv = await mkConv();
    const closed = await asset(T.alice, 'interno.jpg');
    const gone = await asset(T.alice, 'archivado.jpg');
    expect((await call('PATCH', `/library/assets/${closed.id}`, T.alice, { usable_by_advisors: false })).status).toBe(200);
    expect((await call('POST', `/library/assets/${gone.id}/archive`, T.alice)).status).toBe(200);
    const theirs = await asset(T.bob, 'de-b.jpg');
    for (const id of [closed.id, gone.id, theirs.id, '00000000-0000-4000-8000-000000000999']) expect((await send(T.carol, conv, id)).status, id).toBe(404);
    expect(await attachments()).toEqual([]);
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    expect((await send(T.bob, convB, closed.id)).status).toBe(404); // B no ve lo de A
    expect(await attachments()).toEqual([]);
    expect((await send(T.alice, conv, closed.id)).status).toBe(201); // quien administra sí envía lo interno
    expect(await attachments()).toHaveLength(1);
  });

  it('solo quien puede escribir en la conversación: otra asesora (404) sin leer la biblioteca; sin sesión 401; pie de más 400; ventana de 24 h cerrada 409', async () => {
    const conv = await mkConv();
    const a = await asset(T.alice);
    expect((await send(undefined, conv, a.id)).status).toBe(401);
    expect((await send(T.eve, conv, a.id)).status).toBe(404);
    expect((await send(T.carol, conv, a.id, { caption: 'x'.repeat(1025) })).status).toBe(400);
    expect((await send(T.carol, conv, a.id, { otro: 1 })).status).toBe(400);
    expect(await attachments()).toEqual([]);
    expect((await admin.query(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'media_asset' AND field = 'sent'`)).rows[0].n).toBe(0);
    const old = await mkConv({ lastInbound: ago(25 * HOUR) });
    const closed = await send(T.carol, old, a.id);
    expect(closed.status).toBe(409);
    expect((await admin.query(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [old])).rows[0].n).toBe(0); // no salió nada
  });
});
