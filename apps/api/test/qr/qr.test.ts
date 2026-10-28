// M9.6 — WhatsApp por QR (ADR-54/ADR-31): conexiones, webhook de Evolution, medios, envío con calentamiento y sesión caída, latido. Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/qr-channels
//   POST /v1/qr-channels
//   GET /v1/qr-channels/:id
//   POST /v1/qr-channels/:id/qr
//   POST /v1/qr-channels/:id/disconnect
//   PATCH /v1/qr-channels/:id
//   DELETE /v1/qr-channels/:id
//   POST /v1/integrations/qr/webhook/:routeId
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AttachmentsModule, InboundMediaService } from '../../src/modules/attachments';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, WebhookEventsService } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule, OutboundDispatcher } from '../../src/modules/inbox';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { PlatformCredentialsReader } from '../../src/modules/platform';
import { QrHeartbeatJob, QrModule, QR_SESSION, FAKE_QR_KEY, FakeQrSession, MAX_QR_CHANNELS, QrSessionError } from '../../src/modules/qr';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({
  imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, QueuesModule, ChannelsModule, AttachmentsModule, InboxModule, QrModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })],
})
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = { platformOrg: '00000000-0000-4000-8000-0000000000f0', alice: 'a0000000-0000-4000-8000-00000000000a', carol: 'c0000000-0000-4000-8000-0000000000c3', bob: 'b0000000-0000-4000-8000-00000000000b' };
const HOUR = 3_600_000;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
const saved = { ...process.env };
const fake = (): FakeQrSession => app.get(QR_SESSION, { strict: false }) as FakeQrSession;

async function seed(): Promise<void> {
  await admin.query('TRUNCATE webhook_events, message_attachments, messages, conversations, contact_phones, contacts, qr_accounts, whatsapp_accounts, channel_routes, channel_accounts, queues, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
  await admin.query('TRUNCATE qr_routes');
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

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);

interface View { id: string; provider: string; is_official: boolean; name: string; state: string; phone: string | null; profile_name: string | null; down_since: string | null; warmup: { day: number; daily_limit: number }; last_error: string | null }
const mk = async (token: string, name = 'Chip de ventas'): Promise<View> => {
  const r = await call('POST', '/qr-channels', token, { name });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  return json<View>(r);
};
const instanceOf = async (id: string): Promise<string> => (await admin.query(`SELECT instance_name FROM qr_accounts WHERE channel_account_id = $1`, [id])).rows[0].instance_name as string;
/** La dirección del webhook que se le dio a Evolution (la única vez que existe el token en claro). */
const hookOf = async (id: string): Promise<{ route: string; token: string }> => {
  const u = new URL(fake().instances.get(await instanceOf(id))!.webhookUrl);
  return { route: u.pathname.split('/').pop()!, token: u.searchParams.get('token')! };
};
const post = async (id: string, evt: Record<string, unknown>, over: { route?: string; token?: string | null } = {}): Promise<Response> => {
  const h = await hookOf(id);
  const url = `/integrations/qr/webhook/${over.route ?? h.route}${over.token === null ? '' : `?token=${over.token ?? h.token}`}`;
  return call('POST', url, undefined, evt);
};
const SECRETS = { destination: 'http://x/hook?token=TOKEN-SECRETO', apikey: 'APIKEY-DE-LA-INSTANCIA', server_url: 'https://evolution.ejemplo.com', date_time: '2026-10-27T15:00:00.000Z', sender: '593990000001@s.whatsapp.net' };
const evt = (instance: string, event: string, data: unknown) => ({ event, instance, data, ...SECRETS });
const upsert = (instance: string, id: string, message: Record<string, unknown>, who = '593990000002') => evt(instance, 'messages.upsert', { key: { remoteJid: `${who}@s.whatsapp.net`, remoteJidAlt: `${who}@s.whatsapp.net`, fromMe: false, id, participant: '', addressingMode: 'lid' }, pushName: 'Cliente Prueba', status: 'DELIVERY_ACK', message, messageType: Object.keys(message)[0], messageTimestamp: Math.floor(Date.now() / 1000), instanceId: 'i-1', source: 'android' });
const open = async (id: string): Promise<void> => {
  const inst = await instanceOf(id);
  fake().setState(inst, 'open'); // en WhatsApp la sesión quedó abierta: Evolution responde «open» cuando se le pregunta
  expect((await post(id, evt(inst, 'connection.update', { instance: 'x', wuid: '593990000001@s.whatsapp.net', profileName: 'Negocio', state: 'open', statusReason: 200 }))).status).toBe(200);
};
const runEvents = (org = ORG_A) => inOrg(org, async () => app.get(WebhookEventsService).runDue(new Date(Date.now() + 1000), await app.get(OrgDirectoryService).current()));
const qrRow = async (id: string) => (await admin.query(`SELECT * FROM qr_accounts WHERE channel_account_id = $1`, [id])).rows[0] as Record<string, unknown>;
const convOf = async (id: string) => (await admin.query(`SELECT * FROM conversations WHERE channel_account_id = $1`, [id])).rows[0] as Record<string, unknown> | undefined;

/** Un mensaje saliente en cola en la conversación (como lo deja el Inbox). */
async function queueOut(conv: string, channel: string, body: string | null, over: { kind?: string; sentAt?: Date } = {}): Promise<string> {
  const r = await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at, attempts, next_attempt_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', $4, $5, 'queued', $6, 0, $6) RETURNING id`, [ORG_A, conv, channel, over.kind ?? 'text', body, over.sentAt ?? new Date()]);
  return r.rows[0].id as string;
}
const dispatch = (id: string, now = new Date()) => inOrg(ORG_A, () => app.get(OutboundDispatcher).dispatchOne(id, now));
const msg = async (id: string) => (await admin.query(`SELECT * FROM messages WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER', 'QR_PROVIDER', 'WHATSAPP_PROVIDER', 'PROVIDER_CREDENTIALS_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: process.env['TEST_LOG'] ?? 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.com', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', QR_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: randomBytes(32).toString('base64') });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => {
  await app.close();
  await admin.end();
  process.env = saved;
});
beforeEach(async () => {
  await seed();
  fake().reset();
  app.get(OrgDirectoryService).invalidate();
  // La plataforma tiene Evolution configurado (la URL y la clave las guarda el Súper Admin en Proveedores)
  vi.spyOn(app.get(PlatformCredentialsReader), 'active').mockImplementation((service: string) => Promise.resolve(service === 'whatsapp_qr' ? { provider: 'evolution', values: { base_url: 'https://evolution.ejemplo.com', api_key: FAKE_QR_KEY } } : null));
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
});
afterEach(() => vi.restoreAllMocks());

// ═══════════════════════════════════════════════════════════════════════════ conexiones

describe('conexiones por QR', () => {
  it('sin sesión 401; el asesor 403; lo de A no se ve ni se toca desde B (404) y la lista de B está vacía', async () => {
    const v = await mk(T.alice);
    const routes: Array<[string, string, unknown?]> = [['GET', '/qr-channels'], ['POST', '/qr-channels', { name: 'X' }], ['GET', `/qr-channels/${v.id}`], ['POST', `/qr-channels/${v.id}/qr`], ['POST', `/qr-channels/${v.id}/disconnect`], ['PATCH', `/qr-channels/${v.id}`, { name: 'Y' }], ['DELETE', `/qr-channels/${v.id}`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
    for (const [m, p, b] of routes.filter(([, p]) => p.includes(v.id))) expect((await call(m, p, T.bob, b)).status, `${m} ${p} de otra empresa`).toBe(404);
    expect((await json<{ items: View[] }>(await call('GET', '/qr-channels', T.bob))).items).toEqual([]);
    expect((await json<{ items: View[] }>(await call('GET', '/qr-channels', T.alice))).items.map((x) => x.name)).toEqual(['Chip de ventas']);
    expect((await call('GET', '/qr-channels/no-es-uuid', T.alice)).status).toBe(400);
  });

  it('crea la conexión: canal NO oficial, instancia aleatoria en Evolution con su webhook; el token solo existe como hash y nada secreto vuelve al navegador', async () => {
    const v = await mk(T.alice);
    expect(v).toMatchObject({ provider: 'evolution', is_official: false, name: 'Chip de ventas', state: 'connecting', phone: null, warmup: { day: 1, daily_limit: 20 } });
    const inst = await instanceOf(v.id);
    expect(inst).toMatch(/^ss-[0-9a-f]{24}$/);
    expect(inst).not.toMatch(/barber|norte/i);
    const h = await hookOf(v.id);
    expect(h.token).toMatch(/^qrw_/);
    const route = (await admin.query(`SELECT * FROM qr_routes WHERE channel_account_id = $1`, [v.id])).rows[0];
    expect(route.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(route)).not.toContain(h.token);
    const ch = (await admin.query(`SELECT provider, is_official, credentials_sealed FROM channel_accounts WHERE id = $1`, [v.id])).rows[0];
    expect(ch).toEqual({ provider: 'evolution', is_official: false, credentials_sealed: null });
    expect(JSON.stringify(v)).not.toMatch(new RegExp(`${inst}|qrw_|apikey|${FAKE_QR_KEY}|base_url`));
    expect((await admin.query(`SELECT source FROM audit_logs WHERE entity_type = 'channel' AND entity_id = $1`, [v.id])).rows).toEqual([{ source: 'manual' }]);
  });

  it('sin Evolution configurado en la plataforma → 503 con el motivo; con el servidor caído → 503 y no queda nada a medias', async () => {
    vi.spyOn(app.get(PlatformCredentialsReader), 'active').mockResolvedValue(null);
    const off = await call('POST', '/qr-channels', T.alice, { name: 'X' });
    expect(off.status).toBe(503);
    expect(JSON.stringify(await off.json())).toContain('QR_NOT_CONFIGURED');
    expect((await json<{ available: boolean }>(await call('GET', '/qr-channels', T.alice))).available).toBe(false);
    vi.restoreAllMocks();
    vi.spyOn(app.get(PlatformCredentialsReader), 'active').mockResolvedValue({ provider: 'evolution', values: { base_url: 'https://evolution.ejemplo.com', api_key: FAKE_QR_KEY } });
    vi.spyOn(fake(), 'createInstance').mockRejectedValue(new QrSessionError('unavailable', 'x'));
    const down = await call('POST', '/qr-channels', T.alice, { name: 'Y' });
    expect(down.status).toBe(503);
    expect((await admin.query(`SELECT count(*)::int AS n FROM channel_accounts`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM qr_accounts`)).rows[0].n).toBe(0);
  });

  it('nombre único, máximo de conexiones y cola válida', async () => {
    await mk(T.alice, 'Uno');
    expect((await call('POST', '/qr-channels', T.alice, { name: 'uno' })).status).toBe(409);
    expect((await call('POST', '/qr-channels', T.alice, { name: 'Otro', queue_id: '00000000-0000-4000-8000-00000000dead' })).status).toBe(404);
    expect((await call('POST', '/qr-channels', T.alice, { name: '', extra: 1 })).status).toBe(400);
    for (let i = 2; i <= MAX_QR_CHANNELS; i++) await mk(T.alice, `Chip ${i}`);
    expect((await call('POST', '/qr-channels', T.alice, { name: 'De más' })).status).toBe(409);
  });

  it('pide un QR (con imagen) y, cuando el teléfono lo escanea, el estado pasa a «open» con el teléfono, el perfil y el calentamiento', async () => {
    const v = await mk(T.alice);
    const qr = await json<{ qr: string | null; state: string; expires_in: number }>(await call('POST', `/qr-channels/${v.id}/qr`, T.alice));
    expect(qr).toMatchObject({ state: 'connecting', expires_in: 30 });
    expect(qr.qr).toMatch(/^data:image\/png;base64,/);
    await open(v.id); // Evolution avisa por el webhook
    const got = await json<View>(await call('GET', `/qr-channels/${v.id}`, T.alice));
    expect(got).toMatchObject({ state: 'open', phone: '+593990000001', profile_name: 'Negocio', down_since: null, warmup: { day: 1, daily_limit: 20 } });
    expect(await json(await call('POST', `/qr-channels/${v.id}/qr`, T.alice))).toMatchObject({ qr: null, state: 'open' });
    expect((await admin.query(`SELECT source, new_value FROM audit_logs WHERE field = 'qr_session' AND entity_id = $1`, [v.id])).rows).toEqual([{ source: 'automation', new_value: 'open' }]);
  });

  it('si Evolution perdió la instancia, pedir un QR la vuelve a crear con un token nuevo (el anterior deja de servir)', async () => {
    const v = await mk(T.alice);
    const before = await hookOf(v.id);
    fake().instances.delete(await instanceOf(v.id));
    const qr = await json<{ qr: string | null }>(await call('POST', `/qr-channels/${v.id}/qr`, T.alice));
    expect(qr.qr).toBeTruthy();
    const after = await hookOf(v.id);
    expect(after.route).toBe(before.route);
    expect(after.token).not.toBe(before.token);
    expect((await post(v.id, evt(await instanceOf(v.id), 'qrcode.updated', {}), { token: before.token })).status).toBe(404);
  });

  it('cerrar la sesión la deja «logged_out»; renombrar y borrar (cierra la sesión, borra la instancia, corta el webhook y conserva las conversaciones)', async () => {
    const v = await mk(T.alice);
    await open(v.id);
    await post(v.id, upsert(await instanceOf(v.id), 'IN-0000000000000001', { conversation: 'Hola' }));
    await runEvents();
    const h = await hookOf(v.id);
    const inst = await instanceOf(v.id);
    expect(await json(await call('POST', `/qr-channels/${v.id}/disconnect`, T.alice))).toMatchObject({ state: 'logged_out' });
    expect(fake().instances.get(inst)!.state).toBe('logged_out');
    expect(await json(await call('PATCH', `/qr-channels/${v.id}`, T.alice, { name: 'Renombrado' }))).toMatchObject({ name: 'Renombrado' });
    expect(await json(await call('DELETE', `/qr-channels/${v.id}`, T.alice))).toEqual({ id: v.id, deleted: true });
    expect(fake().instances.has(inst)).toBe(false);
    expect((await json<{ items: View[] }>(await call('GET', '/qr-channels', T.alice))).items).toEqual([]);
    expect((await call('GET', `/qr-channels/${v.id}`, T.alice)).status).toBe(404);
    expect((await call('POST', `/integrations/qr/webhook/${h.route}?token=${h.token}`, undefined, upsert(inst, 'IN-0000000000000002', { conversation: 'Otra' }))).status).toBe(404);
    expect((await admin.query(`SELECT count(*)::int AS n FROM conversations WHERE channel_account_id = $1`, [v.id])).rows[0].n).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════ webhook

describe('webhook de Evolution', () => {
  it('es público pero cerrado: identificador o token desconocido, sin token o de otra conexión → 404 uniforme', async () => {
    const v = await mk(T.alice, 'Uno');
    const w = await mk(T.alice, 'Dos');
    const inst = await instanceOf(v.id);
    const body = upsert(inst, 'X-0000000000000001', { conversation: 'hola' });
    expect((await post(v.id, body, { token: 'otro-token' })).status).toBe(404);
    expect((await post(v.id, body, { token: null })).status).toBe(404);
    expect((await post(v.id, body, { route: '00000000-0000-4000-8000-00000000dead' })).status).toBe(404);
    expect((await call('POST', '/integrations/qr/webhook/no-es-uuid?token=x', undefined, body)).status).toBe(404);
    const other = await hookOf(w.id);
    expect((await call('POST', `/integrations/qr/webhook/${(await hookOf(v.id)).route}?token=${other.token}`, undefined, body)).status).toBe(404); // el token de otra conexión no sirve
    expect((await admin.query(`SELECT count(*)::int AS n FROM webhook_events`)).rows[0].n).toBe(0);
  });

  it('un mensaje llega, se guarda SIN la apikey ni la dirección del webhook, se procesa y crea el contacto, la conversación y el mensaje; repetido no duplica', async () => {
    const v = await mk(T.alice);
    await open(v.id);
    const inst = await instanceOf(v.id);
    const e = upsert(inst, '3A5DDA30C62991A6C847', { conversation: 'Hola, ¿tienen turno?' });
    expect((await post(v.id, e)).status).toBe(200);
    expect((await post(v.id, e)).status).toBe(200); // reintento idéntico
    const rows = (await admin.query(`SELECT payload FROM webhook_events`)).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/APIKEY-DE-LA-INSTANCIA|TOKEN-SECRETO|evolution\.ejemplo|"apikey"|"destination"/);
    await runEvents();
    const conv = (await convOf(v.id))!;
    expect(conv).toMatchObject({ status: 'unassigned', peer_id: '593990000002@s.whatsapp.net' });
    expect((await admin.query(`SELECT e164, c.name FROM contact_phones p JOIN contacts c ON c.id = p.contact_id`)).rows).toEqual([{ e164: '+593990000002', name: 'Cliente Prueba' }]);
    expect((await admin.query(`SELECT direction, kind, body, external_id FROM messages WHERE direction = 'in'`)).rows).toEqual([{ direction: 'in', kind: 'text', body: 'Hola, ¿tienen turno?', external_id: '3A5DDA30C62991A6C847' }]);
    await post(v.id, e);
    await runEvents();
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages`)).rows[0].n).toBe(1);
  });

  it('los avisos de grupos, de otra instancia y los del propio chip no crean nada', async () => {
    const v = await mk(T.alice);
    const inst = await instanceOf(v.id);
    await post(v.id, upsert(inst, 'G-0000000000000001', { conversation: 'grupo' }, '120363424375113025'));
    await post(v.id, { ...upsert(inst, 'G-0000000000000002', { conversation: 'grupo' }), data: { key: { remoteJid: '120363424375113025@g.us', fromMe: false, id: 'G-0000000000000002' }, message: { conversation: 'x' } } });
    await post(v.id, upsert('ss-otra-instancia-0000', 'O-0000000000000001', { conversation: 'ajeno' }));
    await post(v.id, { ...upsert(inst, 'P-0000000000000001', { conversation: 'mio' }), data: { key: { remoteJid: '593990000002@s.whatsapp.net', fromMe: true, id: 'P-0000000000000001' }, message: { conversation: 'mio' } } });
    await runEvents();
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages`)).rows[0].n).toBe(0);
  });

  it('un archivo que llega en base64 NO se guarda en el aviso: va al almacenamiento y el adjunto queda listo (con su revisión) y sin rastro temporal', async () => {
    const v = await mk(T.alice);
    const inst = await instanceOf(v.id);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082', 'hex');
    await post(v.id, upsert(inst, 'IMG-0000000000000001', { imageMessage: { mimetype: 'image/png', caption: 'mira' }, base64: png.toString('base64') } as never));
    const payload = JSON.stringify((await admin.query(`SELECT payload FROM webhook_events`)).rows);
    expect(payload).not.toContain(png.toString('base64'));
    expect(payload).toContain('[archivo:');
    await runEvents();
    const att0 = (await admin.query(`SELECT state, source_media_id FROM message_attachments`)).rows[0];
    expect(att0.state).toBe('pending');
    expect(att0.source_media_id).toMatch(new RegExp(`^org/${ORG_A}/qr-inbound/`));
    await inOrg(ORG_A, () => app.get(InboundMediaService).runDue(new Date(Date.now() + 1000)));
    const att = (await admin.query(`SELECT state, mime_type, size_bytes, storage_key FROM message_attachments`)).rows[0];
    expect(att).toMatchObject({ state: 'ready', mime_type: 'image/png', size_bytes: png.length });
    expect(att.storage_key).toMatch(new RegExp(`^org/${ORG_A}/attachments/`));
    expect((await admin.query(`SELECT body FROM messages WHERE direction = 'in'`)).rows).toEqual([{ body: 'mira' }]);
  });

  it('la sesión: cerrar desde el teléfono (close + 401) la deja «logged_out» con la hora de la caída y una sola auditoría; «connecting» no es una caída', async () => {
    const v = await mk(T.alice);
    const inst = await instanceOf(v.id);
    await open(v.id);
    await post(v.id, evt(inst, 'connection.update', { instance: inst, state: 'connecting', statusReason: 200 }));
    expect((await qrRow(v.id))['down_since']).toBeNull();
    await post(v.id, evt(inst, 'connection.update', { instance: inst, state: 'close', statusReason: 401 }));
    await post(v.id, evt(inst, 'connection.update', { instance: inst, state: 'close', statusReason: 401 }));
    const row = await qrRow(v.id);
    expect(row).toMatchObject({ state: 'logged_out' });
    expect(row['down_since']).toBeInstanceOf(Date);
    expect(String(row['last_error'])).toContain('escanea un QR nuevo');
    expect((await admin.query(`SELECT new_value FROM audit_logs WHERE field = 'qr_session' ORDER BY id`)).rows.map((r) => r.new_value)).toEqual(['open', 'logged_out']);
    await open(v.id);
    expect(await qrRow(v.id)).toMatchObject({ state: 'open', down_since: null, last_error: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════════ envío

describe('envío por la sesión', () => {
  async function ready(): Promise<{ v: View; conv: string }> {
    const v = await mk(T.alice);
    await open(v.id);
    await post(v.id, upsert(await instanceOf(v.id), 'IN-0000000000000001', { conversation: 'Hola' }));
    await runEvents();
    return { v, conv: (await convOf(v.id))!['id'] as string };
  }

  it('un texto sale por la instancia al teléfono del cliente; los estados (enviado, entregado, leído) llegan por el webhook y NUNCA retroceden aunque lleguen fuera de orden', async () => {
    const { v, conv } = await ready();
    const id = await queueOut(conv, v.id, 'Claro, te espero a las 3');
    expect(await dispatch(id)).toEqual({ outcome: 'sent' });
    expect(fake().sent).toHaveLength(1);
    expect(fake().sent[0]).toMatchObject({ instance: await instanceOf(v.id), to: '593990000002', text: 'Claro, te espero a las 3' });
    const m = await msg(id);
    expect(m).toMatchObject({ status: 'sent', error: null });
    const ext = String(m['external_id']);
    const inst = await instanceOf(v.id);
    const upd = (status: string) => evt(inst, 'messages.update', { keyId: ext, remoteJid: '257720267587711@lid', fromMe: true, status, instanceId: 'i-1' });
    await post(v.id, upd('READ'));
    await post(v.id, upd('DELIVERY_ACK')); // llega después y es anterior: no baja de «leído»
    await post(v.id, upd('SERVER_ACK'));
    await runEvents();
    expect((await msg(id))['status']).toBe('read');
  });

  it('el Inbox sabe que el canal es por QR (no oficial) y si su sesión está abierta o caída; no tiene ventana de 24 h', async () => {
    const { v, conv } = await ready();
    const detail = async () => json<{ channel: { kind: string; session?: string }; window: { open: boolean } }>(await call('GET', `/conversations/${conv}`, T.alice));
    expect(await detail()).toMatchObject({ channel: { kind: 'qr', session: 'open' }, window: { open: true } });
    await admin.query(`UPDATE conversations SET last_inbound_at = now() - interval '5 days' WHERE id = $1`, [conv]);
    expect((await detail()).window.open).toBe(true); // sin ventana de 24 h: se puede escribir aunque el cliente no haya escrito en días
    await post(v.id, evt(await instanceOf(v.id), 'connection.update', { state: 'close', statusReason: 401 }));
    expect((await detail()).channel).toMatchObject({ kind: 'qr', session: 'down' });
  });

  it('con la sesión caída el mensaje ESPERA (no falla ni gasta intentos) y sale cuando se vuelve a vincular; pasadas 24 h se da por fallido', async () => {
    const { v, conv } = await ready();
    const inst = await instanceOf(v.id);
    await post(v.id, evt(inst, 'connection.update', { state: 'close', statusReason: 401 }));
    const id = await queueOut(conv, v.id, 'Mensaje mientras estás caído');
    const r = await dispatch(id);
    expect(r).toEqual({ outcome: 'retry', code: 'session_down' });
    expect(await msg(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(fake().sent).toHaveLength(0);
    for (let i = 0; i < 3; i++) await dispatch(id, new Date(Date.now() + (i + 1) * 70_000));
    expect(await msg(id)).toMatchObject({ status: 'queued', attempts: 0 });
    await open(v.id);
    expect(await dispatch(id, new Date(Date.now() + 10 * 60_000))).toEqual({ outcome: 'sent' });
    expect(fake().sent.map((s) => s.text)).toEqual(['Mensaje mientras estás caído']);
    // un mensaje que lleva más de 24 h esperando una sesión caída se da por fallido
    await post(v.id, evt(inst, 'connection.update', { state: 'close', statusReason: 401 }));
    const old = await queueOut(conv, v.id, 'Muy viejo', { sentAt: new Date(Date.now() - 25 * HOUR) });
    expect(await dispatch(old, new Date(Date.now() + 20 * 60_000))).toEqual({ outcome: 'failed', code: 'qr_session_down' });
    expect(String((await msg(old))['error'])).toContain('24 horas');
  });

  it('si Evolution responde que la sesión no está abierta aunque se creyera abierta, el mensaje espera y la conexión queda marcada como caída', async () => {
    const { v, conv } = await ready();
    fake().setState(await instanceOf(v.id), 'closed');
    const id = await queueOut(conv, v.id, 'Hola');
    expect(await dispatch(id)).toEqual({ outcome: 'retry', code: 'session_down' });
    expect(await msg(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await qrRow(v.id)).toMatchObject({ state: 'closed' });
  });

  it('calentamiento: el límite del día (20 el primer día) y la pausa mínima entre mensajes hacen esperar al siguiente, sin gastar intentos', async () => {
    const { v, conv } = await ready();
    for (let i = 0; i < 20; i++) await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at, external_id) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', 'text', 'previo', 'sent', now() - interval '2 hours', $4)`, [ORG_A, conv, v.id, `PREV${i}`]);
    const id = await queueOut(conv, v.id, 'El número 21');
    expect(await dispatch(id)).toEqual({ outcome: 'retry', code: 'rate_limited' });
    expect(await msg(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(fake().sent).toHaveLength(0);
    // pasados 3 días (calentamiento: 50 por día) ya cabe
    await admin.query(`UPDATE qr_accounts SET first_connected_at = now() - interval '3 days' WHERE channel_account_id = $1`, [v.id]);
    await admin.query(`UPDATE messages SET sent_at = now() - interval '5 hours' WHERE body = 'previo'`);
    expect(await dispatch(id, new Date(Date.now() + 2 * HOUR))).toEqual({ outcome: 'sent' });
    // pausa mínima: otro mensaje justo después espera unos segundos
    const next = await queueOut(conv, v.id, 'Enseguida');
    const gap = await dispatch(next, new Date());
    expect(gap).toEqual({ outcome: 'retry', code: 'rate_limited' });
    expect(await dispatch(next, new Date(Date.now() + 10_000))).toEqual({ outcome: 'sent' });
  });

  it('no se pueden enviar plantillas ni stickers por QR (falla con su motivo); un error del servidor se reintenta y un número inválido falla', async () => {
    const { v, conv } = await ready();
    const tpl = await queueOut(conv, v.id, 'plantilla', { kind: 'template' });
    expect(await dispatch(tpl)).toEqual({ outcome: 'failed', code: 'qr_unsupported' });
    fake().failNext('unavailable');
    const a = await queueOut(conv, v.id, 'reintento');
    expect(await dispatch(a)).toEqual({ outcome: 'retry', code: 'unavailable' });
    expect(await msg(a)).toMatchObject({ status: 'queued', attempts: 1 });
    const b = await queueOut(conv, v.id, 'a un número sin WhatsApp');
    await admin.query(`UPDATE messages SET sent_at = now() - interval '1 minute' WHERE id = $1`, [a]);
    expect(await dispatch(b, new Date(Date.now() + 30_000))).toMatchObject({ outcome: 'skipped' }); // el anterior (a) sigue en cola: se respeta el orden
    expect(await dispatch(a, new Date(Date.now() + 60_000))).toEqual({ outcome: 'sent' });
    fake().failNext('recipient_invalid');
    expect(await dispatch(b, new Date(Date.now() + 120_000))).toEqual({ outcome: 'failed', code: 'recipient_invalid' });
    expect(String((await msg(b))['error'])).not.toMatch(/593990000002|número sin WhatsApp/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════ latido

describe('latido de la sesión', () => {
  const beat = (now = new Date()) => app.get(QrHeartbeatJob).run(now);

  it('corrige el estado cuando se perdió el aviso: una sesión caída se marca, una recuperada se limpia, y la auditoría deja cada paso', async () => {
    const v = await mk(T.alice);
    await open(v.id);
    const inst = await instanceOf(v.id);
    fake().setState(inst, 'closed'); // se cayó y el aviso se perdió
    expect(await beat()).toBe(1);
    expect(await qrRow(v.id)).toMatchObject({ state: 'closed' });
    expect((await qrRow(v.id))['down_since']).toBeInstanceOf(Date);
    expect((await qrRow(v.id))['last_heartbeat_at']).toBeInstanceOf(Date);
    fake().setState(inst, 'open');
    await beat();
    expect(await qrRow(v.id)).toMatchObject({ state: 'open', down_since: null });
    expect((await admin.query(`SELECT new_value FROM audit_logs WHERE field = 'qr_session' ORDER BY id`)).rows.map((r) => r.new_value)).toEqual(['open', 'closed', 'open']);
  });

  it('si Evolution no responde no se marca la sesión como caída (se conserva lo último); si ya no tiene la instancia, está caída', async () => {
    const v = await mk(T.alice);
    await open(v.id);
    vi.spyOn(fake(), 'state').mockRejectedValueOnce(new QrSessionError('unavailable', 'x'));
    await beat();
    expect(await qrRow(v.id)).toMatchObject({ state: 'open' });
    fake().instances.delete(await instanceOf(v.id));
    await beat();
    expect(await qrRow(v.id)).toMatchObject({ state: 'closed' });
  });

  it('solo mira las conexiones vinculadas y activas (una sin vincular o borrada no se consulta)', async () => {
    const a = await mk(T.alice, 'Sin vincular');
    await admin.query(`UPDATE qr_accounts SET state = 'created' WHERE channel_account_id = $1`, [a.id]);
    const spy = vi.spyOn(fake(), 'state');
    expect(await beat()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
