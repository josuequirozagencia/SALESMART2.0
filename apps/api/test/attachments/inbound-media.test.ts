// M5.6d — Descarga de archivos entrantes y vencimiento de huérfanos (ADR-50). No pasa por rutas HTTP (el webhook ya se prueba aparte):
// ejercita InboundMediaService/AttachmentsJob directamente, como lo haría la tarea periódica.
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
import { AttachmentsJob, EICAR, FakeScanner, InboundMediaService, StorageGateway, VIRUS_SCANNER, DOWNLOAD_MAX_ATTEMPTS, ORPHAN_TTL_MS } from '../../src/modules/attachments';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = { platformOrg: '00000000-0000-4000-8000-0000000000f0', alice: 'a0000000-0000-4000-8000-00000000000a', bob: 'b0000000-0000-4000-8000-00000000000b', root: 'f0000000-0000-4000-8000-0000000000f1' };
const KEY = randomBytes(32).toString('base64');

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
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
  const members: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of members) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'client_admin')`, [IDS.alice, ORG_A]);
  await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'client_admin')`, [IDS.bob, ORG_B]);
  await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'super_admin')`, [IDS.root, IDS.platformOrg]);
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
async function connect(token: string, phoneId: string, name: string, org: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: org === ORG_B ? '1234567890124' : '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

const fakeWa = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;
const fakeScanner = (): FakeScanner => app.get(VIRUS_SCANNER, { strict: false }) as FakeScanner;
const fakeStorage = () => (app.get(StorageGateway, { strict: false }) as StorageGateway).fake;

let seq = 0;
/** Un contacto, conversación y un adjunto ENTRANTE `pending` con su `source_media_id`, listos para que la tarea los recoja. */
async function mkPendingInbound(o: { org?: string; mediaId?: string; kind?: string; channel?: string } = {}): Promise<{ attachmentId: string; conversationId: string; mediaId: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [org, `Cliente ${seq}`])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const channel = o.channel ?? (org === ORG_B ? channelB : channelA);
  const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, unread_count, peer_id, last_inbound_at) VALUES (gen_random_uuid(), $1, $2, $3, 'unassigned', 1, $4, now()) RETURNING id`, [org, contact, channel, phone.slice(1)])).rows[0].id as string;
  const mediaId = o.mediaId ?? `media-${seq}`;
  const attachment = (await admin.query(
    `INSERT INTO message_attachments(id, organization_id, conversation_id, direction, kind, mime_type, state, scan_status, source_media_id, next_attempt_at)
     VALUES (gen_random_uuid(), $1, $2, 'in', $3, 'image/jpeg', 'pending', 'pending', $4, now() - interval '1 minute') RETURNING id`,
    [org, conv, o.kind ?? 'image', mediaId],
  )).rows[0].id as string;
  return { attachmentId: attachment, conversationId: conv, mediaId };
}
const row = async (id: string) => (await admin.query(`SELECT state, scan_status, error, attempts, next_attempt_at, storage_key, size_bytes FROM message_attachments WHERE id = $1`, [id])).rows[0] as { state: string; scan_status: string; error: string | null; attempts: number; next_attempt_at: Date | null; storage_key: string | null; size_bytes: number | null };
const runDue = (org = ORG_A, now = new Date()) => TenantContext.run({ organizationId: org }, () => app.get(InboundMediaService).runDue(now));

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  channelA = await connect(await login('alice@a.test'), '1090123460001', 'Ventas', ORG_A);
  channelB = await connect(await login('bob@b.test'), '1090123460002', 'Soporte', ORG_B);
  fakeWa().media.clear();
  fakeWa().downloaded.length = 0;
  fakeStorage().objects.clear();
  fakeScanner().scanned.length = 0;
  fakeScanner().down = false;
  fakeStorage().down = false;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('descarga de un archivo entrante', () => {
  it('descarga, revisa y guarda: queda ready con su tamaño, checksum y revisión limpia; una pasada sin pendientes no hace nada', async () => {
    const { attachmentId, mediaId } = await mkPendingInbound();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    fakeWa().media.set(mediaId, { bytes, mimeType: 'image/jpeg' });
    expect(await runDue()).toBe(1);
    const r = await row(attachmentId);
    expect(r).toMatchObject({ state: 'ready', scan_status: 'clean', error: null, size_bytes: bytes.length });
    expect(r.storage_key).toMatch(new RegExp(`^org/${ORG_A}/attachments/`));
    expect(fakeScanner().scanned).toEqual([bytes.length]);
    expect(await runDue()).toBe(0); // ya no hay nada pendiente
  });

  it('un archivo infectado (EICAR) nunca se guarda: queda infected con su motivo', async () => {
    const { attachmentId, mediaId } = await mkPendingInbound();
    fakeWa().media.set(mediaId, { bytes: Buffer.from(EICAR, 'latin1'), mimeType: 'image/jpeg' });
    expect(await runDue()).toBe(1);
    const r = await row(attachmentId);
    expect(r.state, JSON.stringify(r)).toBe('infected');
    expect(r.scan_status).toBe('infected');
    expect(r.error).toContain('antivirus');
    expect(r.storage_key).toBeNull();
    expect(fakeStorage().objects.size).toBe(0); // no quedó nada guardado
  });

  it('un fallo pasajero del proveedor se reintenta con espera creciente, hasta el máximo de intentos', async () => {
    const { attachmentId } = await mkPendingInbound({ mediaId: 'down' }); // el fake simula que el proveedor no responde
    const before = Date.now();
    expect(await runDue()).toBe(1);
    let r = await row(attachmentId);
    expect(r).toMatchObject({ state: 'pending', attempts: 1 });
    expect(r.next_attempt_at!.getTime()).toBeGreaterThan(before);
    // adelanta la hora de cada reintento (un segundo ATRÁS: el reloj de la base y el de Node no coinciden al milisegundo)
    const due = () => admin.query(`UPDATE message_attachments SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [attachmentId]);
    for (let i = 2; i < DOWNLOAD_MAX_ATTEMPTS; i++) {
      await due();
      await runDue();
      r = await row(attachmentId);
      expect(r, `intento ${i}`).toMatchObject({ state: 'pending', attempts: i });
    }
    // el último intento permitido ya no se reprograma: queda fallido con su explicación
    await due();
    await runDue();
    r = await row(attachmentId);
    expect(r).toMatchObject({ state: 'failed', attempts: DOWNLOAD_MAX_ATTEMPTS, next_attempt_at: null });
    expect(r.error).toContain('No pudimos descargar');
    await due();
    expect(await runDue()).toBe(0); // fallido: no se vuelve a tocar
  });

  it('un archivo vencido en Meta (media_unavailable) o antivirus caído no se reintenta igual: uno queda fallido de inmediato, el otro vuelve a intentarse', async () => {
    const expired = await mkPendingInbound({ mediaId: 'nunca-existio' }); // no está en el mapa del fake: media_unavailable
    expect(await runDue()).toBe(1);
    expect((await row(expired.attachmentId)).error).toContain('ya no está disponible');
    expect((await row(expired.attachmentId)).state).toBe('failed');
    expect((await row(expired.attachmentId)).attempts).toBe(1); // no sigue reintentando

    const antivirusDown = await mkPendingInbound({ mediaId: 'media-2' });
    fakeWa().media.set('media-2', { bytes: Buffer.from([1, 2, 3, 4]), mimeType: 'image/jpeg' });
    fakeScanner().down = true;
    expect(await runDue()).toBe(1);
    const r = await row(antivirusDown.attachmentId);
    expect(r).toMatchObject({ state: 'pending', attempts: 1 }); // se reintenta: puede ser pasajero
    fakeScanner().down = false;
  });

  it('con la conexión desactivada no se llega a pedir el archivo al proveedor', async () => {
    const { attachmentId } = await mkPendingInbound({ mediaId: 'media-3' });
    fakeWa().media.set('media-3', { bytes: Buffer.from([1]), mimeType: 'image/jpeg' });
    await admin.query(`UPDATE channel_accounts SET status = 'disabled' WHERE id = $1`, [channelA]);
    expect(await runDue()).toBe(1);
    const r = await row(attachmentId);
    expect(r.state).toBe('failed');
    expect(r.error).toContain('desactivada');
    expect(fakeWa().downloaded).toEqual([]);
  });

  it('A↔B: una pasada de la empresa A nunca toca ni descarga los pendientes de la empresa B', async () => {
    const a = await mkPendingInbound({ org: ORG_A, mediaId: 'media-a' });
    const b = await mkPendingInbound({ org: ORG_B, mediaId: 'media-b' });
    fakeWa().media.set('media-a', { bytes: Buffer.from([1]), mimeType: 'image/jpeg' });
    fakeWa().media.set('media-b', { bytes: Buffer.from([2]), mimeType: 'image/jpeg' });
    expect(await runDue(ORG_A)).toBe(1);
    expect((await row(a.attachmentId)).state).toBe('ready');
    expect((await row(b.attachmentId)).state).toBe('pending'); // intacto: ni se intentó
    expect(fakeWa().downloaded).toEqual(['media-a']);
    expect(await runDue(ORG_B)).toBe(1);
    expect((await row(b.attachmentId)).state).toBe('ready');
  });

  it('la tarea (AttachmentsJob) recorre las empresas con número conectado y procesa las dos', async () => {
    const a = await mkPendingInbound({ org: ORG_A, mediaId: 'media-x' });
    const b = await mkPendingInbound({ org: ORG_B, mediaId: 'media-y' });
    fakeWa().media.set('media-x', { bytes: Buffer.from([9]), mimeType: 'image/jpeg' });
    fakeWa().media.set('media-y', { bytes: Buffer.from([9]), mimeType: 'image/jpeg' });
    const touched = await app.get(AttachmentsJob).run(new Date());
    expect(touched).toBeGreaterThanOrEqual(2);
    expect((await row(a.attachmentId)).state).toBe('ready');
    expect((await row(b.attachmentId)).state).toBe('ready');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('vencimiento de huérfanos', () => {
  it('un archivo subido y nunca enviado vence a las 24 h y se borra del almacenamiento; uno reciente no', async () => {
    // sube uno "a mano" (como lo deja ConversationAttachmentsService.upload)
    const key1 = 'org/test/attachments/old';
    const key2 = 'org/test/attachments/recent';
    fakeStorage().objects.set(key1, { body: Buffer.from('x'), contentType: 'image/jpeg' });
    fakeStorage().objects.set(key2, { body: Buffer.from('y'), contentType: 'image/jpeg' });
    const conv = (await mkPendingInbound()).conversationId;
    const old = (await admin.query(`INSERT INTO message_attachments(id, organization_id, conversation_id, direction, kind, mime_type, state, scan_status, storage_key, size_bytes, created_at) VALUES (gen_random_uuid(), $1, $2, 'out', 'image', 'image/jpeg', 'ready', 'clean', $3, 1, now() - interval '25 hours') RETURNING id`, [ORG_A, conv, key1])).rows[0].id as string;
    const recent = (await admin.query(`INSERT INTO message_attachments(id, organization_id, conversation_id, direction, kind, mime_type, state, scan_status, storage_key, size_bytes, created_at) VALUES (gen_random_uuid(), $1, $2, 'out', 'image', 'image/jpeg', 'ready', 'clean', $3, 1, now() - interval '1 hour') RETURNING id`, [ORG_A, conv, key2])).rows[0].id as string;
    expect(ORPHAN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    await runDue();
    expect((await row(old)).state).toBe('expired');
    expect((await row(recent)).state).toBe('ready');
    expect(fakeStorage().objects.has(key1)).toBe(false); // se borró del almacenamiento
    expect(fakeStorage().objects.has(key2)).toBe(true);
  });

  it('un adjunto ENTRANTE ready (ya descargado) no vence aunque sea viejo: el vencimiento es solo para lo que una persona subió y no envió', async () => {
    const conv = (await mkPendingInbound()).conversationId;
    const key = 'org/test/attachments/inbound-old';
    fakeStorage().objects.set(key, { body: Buffer.from('z'), contentType: 'image/jpeg' });
    const id = (await admin.query(`INSERT INTO message_attachments(id, organization_id, conversation_id, direction, kind, mime_type, state, scan_status, storage_key, size_bytes, created_at) VALUES (gen_random_uuid(), $1, $2, 'in', 'image', 'image/jpeg', 'ready', 'clean', $3, 1, now() - interval '48 hours') RETURNING id`, [ORG_A, conv, key])).rows[0].id as string;
    await runDue();
    expect((await row(id)).state).toBe('ready');
    expect(fakeStorage().objects.has(key)).toBe(true);
  });
});
