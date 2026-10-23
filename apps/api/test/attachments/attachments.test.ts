// M5.6d — Adjuntos y audio (ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   POST /v1/conversations/:id/attachments
//   GET /v1/attachments/:id/url
//   POST /v1/conversations/:id/media
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
import { OrganizationsModule } from '../../src/modules/organizations';
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
  alice: 'a0000000-0000-4000-8000-00000000000a',
  carol: 'c0000000-0000-4000-8000-0000000000c3',
  eve: 'e0000000-0000-4000-8000-0000000000e5',
  bob: 'b0000000-0000-4000-8000-00000000000b',
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
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE message_attachments, messages, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown, extraHeaders?: Record<string, string>) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extraHeaders ?? {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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
async function mkConv(o: { owner?: string | null; status?: string; org?: string; lastInbound?: Date | null } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const status = o.status ?? (owner ? 'working' : 'unassigned');
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING id`, [org, contact, org === ORG_B ? channelB : channelA, status, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, phone.slice(1)])).rows[0].id as string;
}
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

function jpegBytes(): Buffer { return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]); }
function pdfBytes(): Buffer { return Buffer.from('%PDF-1.4 fake pdf content\n', 'latin1'); }
function textBytes(s = 'Hola'): Buffer { return Buffer.from(s, 'utf8'); }

async function uploadRaw(token: string, conv: string, bytes: Buffer, contentType: string, filename?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': contentType, authorization: `Bearer ${token}` };
  if (filename) headers['x-filename'] = encodeURIComponent(filename);
  return fetch(`${base}/conversations/${conv}/attachments`, { method: 'POST', headers, body: bytes });
}
interface Att { id: string; kind: string; mime_type: string; filename: string | null; size_bytes: number; scan_status: string; error: string | null; url: string | null; expires_at: string | null }
interface ChatMsg { id: string; kind: string; text: string | null; attachment: Att | null; status: string }

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
  fake().media.clear();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('permisos y aislamiento', () => {
  it('sin sesión 401; la plataforma 403', async () => {
    const conv = await mkConv();
    const r1 = await uploadRaw('' as string, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    expect([401, 403]).toContain(r1.status);
    const r2 = await call('GET', `/attachments/${NOBODY}/url`, T.root);
    expect(r2.status).toBe(403);
    const r3 = await call('POST', `/conversations/${conv}/media`, T.root, { attachment_id: NOBODY });
    expect(r3.status).toBe(403);
  });

  it('A↔B: nadie sube, ve url ni envía media en conversaciones de otra empresa (404)', async () => {
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const up = await uploadRaw(T.carol, convA, jpegBytes(), 'image/jpeg', 'foto.jpg');
    expect(up.status).toBe(201);
    const att = await json<Att>(up);
    // B no puede ver ni usar el adjunto de A
    expect((await call('GET', `/attachments/${att.id}/url`, T.bob)).status).toBe(404);
    expect((await call('POST', `/conversations/${convB}/media`, T.bob, { attachment_id: att.id })).status).toBe(404);
    // A no puede subir en conversación de B
    const up2 = await uploadRaw(T.alice, convB, jpegBytes(), 'image/jpeg', 'foto2.jpg');
    expect(up2.status).toBe(404);
  });

  it('quien no ve la conversación recibe 404 al subir y al pedir url', async () => {
    const conv = await mkConv(); // de carol
    const r = await uploadRaw(T.eve, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    expect(r.status).toBe(404);
    const up = await uploadRaw(T.carol, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    const att = await json<Att>(up);
    expect((await call('GET', `/attachments/${att.id}/url`, T.eve)).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('subir adjunto', () => {
  it('sube una imagen y queda ready con su url firmada; el hilo trae attachment', async () => {
    const conv = await mkConv();
    const up = await uploadRaw(T.carol, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    expect(up.status).toBe(201);
    const att = await json<Att>(up);
    expect(att).toMatchObject({ kind: 'image', mime_type: 'image/jpeg', scan_status: 'clean' });
    const urlRes = await call('GET', `/attachments/${att.id}/url`, T.carol);
    expect(urlRes.status).toBe(200);
    const u = await json<{ url: string; expires_at: string }>(urlRes);
    expect(u.url).toContain('fake-storage');
  });

  it('valida tipo no permitido (415), vacío (400), demasiado grande (413) y contenido que no corresponde (422)', async () => {
    const conv = await mkConv();
    const badType = await uploadRaw(T.carol, conv, textBytes('x'), 'image/gif', 'a.gif');
    expect(badType.status).toBe(415);
    const empty = await uploadRaw(T.carol, conv, Buffer.alloc(0), 'image/jpeg', 'a.jpg');
    expect([400, 422]).toContain(empty.status);
    const mismatch = await uploadRaw(T.carol, conv, textBytes('texto plano'), 'image/jpeg', 'a.jpg');
    expect(mismatch.status).toBe(422);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('enviar adjunto', () => {
  it('envía un adjunto ya subido como mensaje del hilo y el fake lo recibe', async () => {
    const conv = await mkConv({ lastInbound: ago(10 * MIN) });
    const up = await uploadRaw(T.carol, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    const att = await json<Att>(up);
    const sent = await ok<ChatMsg>(await call('POST', `/conversations/${conv}/media`, T.carol, { attachment_id: att.id, caption: 'Mira esto' }), 201);
    expect(sent.kind).toBe('image');
    expect(sent.attachment).not.toBeNull();
    expect(fake().outbox.length).toBe(1);
    // lo que salió por el proveedor: el archivo tal cual, su tipo, su nombre y el pie
    expect(fake().outbox[0]!.media).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', size: jpegBytes().length, caption: 'Mira esto' });
    expect(fake().outbox[0]!.media!.bytes.equals(jpegBytes())).toBe(true);
  });

  it('no se puede enviar un adjunto de otra conversación ni dos veces', async () => {
    const conv = await mkConv();
    const conv2 = await mkConv();
    const up = await uploadRaw(T.carol, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    const att = await json<Att>(up);
    const wrong = await call('POST', `/conversations/${conv2}/media`, T.carol, { attachment_id: att.id });
    expect(wrong.status).toBe(404);
    await ok(await call('POST', `/conversations/${conv}/media`, T.carol, { attachment_id: att.id }), 201);
    const again = await call('POST', `/conversations/${conv}/media`, T.carol, { attachment_id: att.id });
    expect(again.status).toBe(409);
  });

  it('fuera de la ventana de 24h no se envía media (409 WINDOW_CLOSED)', async () => {
    const conv = await mkConv({ lastInbound: ago(25 * HOUR) });
    const up = await uploadRaw(T.carol, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    const att = await json<Att>(up);
    // subir sí se pudo (la ventana se valida al enviar), pero enviar media no
    const r = await call('POST', `/conversations/${conv}/media`, T.carol, { attachment_id: att.id });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('WINDOW_CLOSED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('url de adjunto', () => {
  it('quien puede ver la conversación puede pedir la url; solo ready se entrega (409 si no)', async () => {
    const conv = await mkConv();
    const up = await uploadRaw(T.carol, conv, jpegBytes(), 'image/jpeg', 'foto.jpg');
    const att = await json<Att>(up);
    expect((await call('GET', `/attachments/${att.id}/url`, T.carol)).status).toBe(200);
    // un adjunto de otra persona sin ver la conv → 404
    expect((await call('GET', `/attachments/${att.id}/url`, T.eve)).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('base de datos', () => {
  it('RLS forzada y app_rw sin DELETE; org/<id>/attachments/<uuid> y scans', async () => {
    const t = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'message_attachments'`)).rows[0];
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const privs = (await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'message_attachments' AND grantee = 'app_rw' ORDER BY 1`)).rows.map((r) => r.privilege_type as string);
    expect(privs).not.toContain('DELETE');
    expect(privs).toEqual(expect.arrayContaining(['INSERT', 'SELECT', 'UPDATE']));
    const conv = await mkConv();
    const up = await uploadRaw(T.carol, conv, pdfBytes(), 'application/pdf', 'doc.pdf');
    const att = await json<Att>(up);
    const row = (await admin.query(`SELECT storage_key, scan_status FROM message_attachments WHERE id = $1`, [att.id])).rows[0];
    expect(row.storage_key).toMatch(/^org\//);
    expect(['clean', 'skipped']).toContain(row.scan_status);
  });
});
