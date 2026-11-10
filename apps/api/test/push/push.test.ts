// v6 fase E — Notificaciones push del navegador (ADR-64). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/push/config
//   POST /v1/push/status
//   POST /v1/push/subscribe
//   POST /v1/push/unsubscribe
//   POST /v1/push/test
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { FakePushSender, PUSH_SENDER, PushModule } from '../../src/modules/push';
import { RealtimeModule, RealtimeService } from '../../src/modules/realtime';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, OpportunitiesModule, ChannelsModule, QueuesModule, InboxModule, RealtimeModule, PushModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
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
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'PUSH_PROVIDER', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY, PUSH_PROVIDER: 'fake', VAPID_PUBLIC_KEY: 'A'.repeat(87), VAPID_PRIVATE_KEY: 'B'.repeat(43), VAPID_SUBJECT: 'mailto:push@ejemplo.test' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE push_subscriptions, notifications, message_mentions, scheduled_messages, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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
  return (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING id`,
      [org, contact, org === ORG_B ? channelB : channelA, status, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, phone.slice(1)],
    )
  ).rows[0].id as string;
}
const sender = (): FakePushSender => app.get(PUSH_SENDER, { strict: false }) as FakePushSender;
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
  sender().reset();
});


// ═════════════════════════════════════════════════════════════════════════════
const EP_A = 'https://fcm.googleapis.com/fcm/send/dispositivo-de-alicia';
const EP_C = 'https://updates.push.services.mozilla.com/wpush/v2/dispositivo-de-carol';
const EP_E = 'https://web.push.apple.com/dispositivo-de-eva';
const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const sub = (token: string, endpoint: string, show_text = false) => call('POST', '/push/subscribe', token, { endpoint, keys, show_text });
const status = async (token: string, endpoint: string) => ok<{ subscribed: boolean; show_text: boolean }>(await call('POST', '/push/status', token, { endpoint }));
const rows = async (): Promise<Array<{ user_id: string; organization_id: string; endpoint: string; revoked_at: Date | null; show_text: boolean }>> => (await admin.query('SELECT user_id, organization_id, endpoint, revoked_at, show_text FROM push_subscriptions ORDER BY endpoint')).rows;

async function mkInbound(conv: string, o: { text?: string | null; kind?: string; direction?: 'in' | 'out' } = {}): Promise<string> {
  const direction = o.direction ?? 'in';
  return (
    await admin.query(
      `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
      [ORG_A, conv, channelA, direction, direction === 'in' ? 'contact' : 'human', o.kind ?? 'text', o.text === undefined ? 'Hola, ¿tienen cita para mañana?' : o.text, direction === 'in' ? 'received' : 'sent'],
    )
  ).rows[0].id as string;
}
const wait = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
};
/** Lo que haría el servidor al recibir un mensaje: avisar al tiempo real, que además genera el push. */
const arrives = (conv: string, msg: string): void => app.get(RealtimeService, { strict: false }).touch(ORG_A, conv, { message: { id: msg, kind: 'created' }, inbound: true });

describe('acceso, permisos y aislamiento', () => {
  it('sin sesión 401 y la plataforma 403 en todas las rutas', async () => {
    const routes: Array<[string, string, unknown?]> = [['GET', '/push/config'], ['POST', '/push/status', { endpoint: EP_A }], ['POST', '/push/subscribe', { endpoint: EP_A, keys }], ['POST', '/push/unsubscribe', { endpoint: EP_A }], ['POST', '/push/test']];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('config: dice si el servidor puede mandar push y entrega la clave pública (nunca la privada)', async () => {
    const c = await ok<{ enabled: boolean; public_key: string | null }>(await call('GET', '/push/config', T.carol));
    expect(c).toEqual({ enabled: true, public_key: 'A'.repeat(87) });
    expect(JSON.stringify(c)).not.toContain('B'.repeat(43));
  });

  it('solo se aceptan direcciones de los servicios de push de los navegadores (anti-SSRF)', async () => {
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://evil.example.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.test/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'no-es-una-url']) {
      expect((await sub(T.carol, endpoint)).status, endpoint).toBe(400);
    }
    expect(await rows()).toEqual([]);
    for (const endpoint of [EP_A, EP_C, EP_E, 'https://wns2-par02p.notify.windows.com/w/?token=x']) expect((await sub(T.carol, endpoint)).status, endpoint).toBe(200);
  });

  it('claves mal formadas o campos de más: 400', async () => {
    expect((await call('POST', '/push/subscribe', T.carol, { endpoint: EP_A, keys: { p256dh: 'x!', auth: 'y' } })).status).toBe(400);
    expect((await call('POST', '/push/subscribe', T.carol, { endpoint: EP_A, keys, otra: 1 })).status).toBe(400);
  });

  it('suscribirse, ver el estado, cambiar «mostrar el texto» y darse de baja; la dirección nunca se devuelve', async () => {
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: false, show_text: false });
    const r = await ok<Record<string, unknown>>(await sub(T.carol, EP_C, true));
    expect(r).toEqual({ subscribed: true, show_text: true });
    expect(JSON.stringify(r)).not.toContain('mozilla');
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: true, show_text: true });
    await ok(await sub(T.carol, EP_C, false)); // mismo navegador: se actualiza, no se duplica
    expect((await rows()).filter((x) => x.endpoint === EP_C)).toHaveLength(1);
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: true, show_text: false });
    expect(await ok(await call('POST', '/push/unsubscribe', T.carol, { endpoint: EP_C }))).toEqual({ subscribed: false, show_text: false });
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: false, show_text: false });
    await ok(await sub(T.carol, EP_C)); // volver a activarlo reutiliza la fila
    expect((await rows()).filter((x) => x.endpoint === EP_C)).toHaveLength(1);
    expect((await rows())[0]!.revoked_at).toBeNull();
  });

  it('el navegador de otra persona no se da de baja ni se ve como propio; uno compartido pasa a quien se suscribe', async () => {
    await ok(await sub(T.carol, EP_C));
    expect(await status(T.eve, EP_C)).toEqual({ subscribed: false, show_text: false });
    await ok(await call('POST', '/push/unsubscribe', T.eve, { endpoint: EP_C }));
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: true, show_text: false });
    await ok(await sub(T.eve, EP_C)); // el mismo navegador, ahora de Eva
    expect((await rows()).find((x) => x.endpoint === EP_C)!.user_id).toBe(IDS.eve);
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: false, show_text: false });
  });

  it('A↔B: la misma dirección en otra empresa es otra suscripción; B no ve ni toca la de A', async () => {
    await ok(await sub(T.alice, EP_A, true));
    expect(await status(T.bob, EP_A)).toEqual({ subscribed: false, show_text: false });
    await ok(await call('POST', '/push/unsubscribe', T.bob, { endpoint: EP_A }));
    expect(await status(T.alice, EP_A)).toEqual({ subscribed: true, show_text: true });
    await ok(await sub(T.bob, EP_A));
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(new Set(r.map((x) => x.organization_id))).toEqual(new Set([ORG_A, ORG_B]));
  });
});

describe('aviso de un mensaje entrante', () => {
  it('va al responsable de la conversación y a nadie más; sin mostrar el texto dice solo «Mensaje nuevo»', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await ok(await sub(T.carol, EP_C, false));
    await ok(await sub(T.eve, EP_E, true)); // no es la responsable
    await ok(await sub(T.alice, EP_A, true)); // administradora: ve todo, pero hay responsable
    arrives(conv, await mkInbound(conv));
    await wait(() => sender().sent.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(sender().sent).toHaveLength(1);
    const m = sender().sent[0]!;
    expect(m.endpoint).toBe(EP_C);
    const p = JSON.parse(m.payload) as { title: string; body: string; url: string; conversation_id: string };
    expect(p).toMatchObject({ title: expect.stringMatching(/^Cliente \d+$/) as string, body: 'Mensaje nuevo', url: `/inbox/${conv}`, conversation_id: conv });
    expect(JSON.stringify(p)).not.toContain('mañana');
  });

  it('con «mostrar el texto» lleva el mensaje recortado; un archivo lleva su tipo', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await ok(await sub(T.carol, EP_C, true));
    arrives(conv, await mkInbound(conv, { text: 'x'.repeat(300) }));
    await wait(() => sender().sent.length >= 1);
    expect((JSON.parse(sender().sent[0]!.payload) as { body: string }).body).toHaveLength(90);
    arrives(conv, await mkInbound(conv, { text: null, kind: 'image' }));
    await wait(() => sender().sent.length >= 2);
    expect((JSON.parse(sender().sent[1]!.payload) as { body: string }).body).toBe('📷 Foto');
  });

  it('sin responsable avisa a quienes la pueden ver (administración), no a un asesor sin acceso', async () => {
    const conv = await mkConv({ owner: null });
    await ok(await sub(T.alice, EP_A, false));
    await ok(await sub(T.eve, EP_E, false));
    arrives(conv, await mkInbound(conv));
    await wait(() => sender().sent.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(sender().sent.map((x) => x.endpoint)).toEqual([EP_A]);
  });

  it('un mensaje saliente no genera push, ni una suscripción dada de baja', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await ok(await sub(T.carol, EP_C));
    arrives(conv, await mkInbound(conv, { direction: 'out' }));
    await new Promise((r) => setTimeout(r, 800));
    expect(sender().sent).toHaveLength(0);
    await ok(await call('POST', '/push/unsubscribe', T.carol, { endpoint: EP_C }));
    arrives(conv, await mkInbound(conv));
    await new Promise((r) => setTimeout(r, 800));
    expect(sender().sent).toHaveLength(0);
  });

  it('si el servicio de push dice que el navegador ya no existe (410), la suscripción se da de baja', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await ok(await sub(T.carol, EP_C));
    sender().results.set(EP_C, 'gone');
    arrives(conv, await mkInbound(conv));
    await wait(() => false, 1200);
    expect((await rows()).find((x) => x.endpoint === EP_C)!.revoked_at).not.toBeNull();
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: false, show_text: false });
  });

  it('A↔B: un mensaje de la empresa A no avisa a las suscripciones de B', async () => {
    const conv = await mkConv({ owner: null });
    await ok(await sub(T.bob, EP_A));
    arrives(conv, await mkInbound(conv));
    await new Promise((r) => setTimeout(r, 800));
    expect(sender().sent).toHaveLength(0);
  });
});

describe('notificación de prueba', () => {
  // El límite (una cada 10 s) vive en memoria del servicio: cada prueba corre «11 s más tarde» que la anterior para no heredarlo
  let skew = 0;
  beforeEach(() => {
    skew += 11_000;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);
  });
  afterEach(() => vi.restoreAllMocks());

  it('manda el aviso (con «force») solo a los navegadores de quien la pide, en esta empresa; sin suscripción dice 0 enviados', async () => {
    expect(await ok<{ sent: number; gone: number; failed: number }>(await call('POST', '/push/test', T.alice))).toEqual({ sent: 0, gone: 0, failed: 0 }); // sin suscripción: 0 enviados
    await ok(await sub(T.carol, EP_C));
    await ok(await sub(T.eve, EP_E)); // otra persona: no recibe la de Carolina
    await ok(await sub(T.bob, EP_A)); // otra empresa: tampoco
    expect(await ok<{ sent: number }>(await call('POST', '/push/test', T.carol))).toEqual({ sent: 1, gone: 0, failed: 0 });
    expect(sender().sent.map((x) => x.endpoint)).toEqual([EP_C]);
    expect(JSON.parse(sender().sent[0]!.payload)).toMatchObject({ title: 'Notificación de prueba', force: true, url: '/settings/notifications' });
  });

  it('una prueba cada 10 s por persona (429 con espera), y otra persona no se ve afectada', async () => {
    await ok(await sub(T.carol, EP_C));
    await ok(await call('POST', '/push/test', T.carol));
    const r = await call('POST', '/push/test', T.carol);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call('POST', '/push/test', T.eve)).status).toBe(200);
  });

  it('un navegador que ya no existe (410) se da de baja y se cuenta', async () => {
    await ok(await sub(T.carol, EP_C));
    sender().results.set(EP_C, 'gone');
    expect(await ok<{ gone: number }>(await call('POST', '/push/test', T.carol))).toMatchObject({ sent: 0, gone: 1 });
    expect(await status(T.carol, EP_C)).toEqual({ subscribed: false, show_text: false });
  });
});
