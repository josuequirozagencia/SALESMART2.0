// M5.2 — Webhook de Meta y entrada de mensajes (ADR-50). Rutas públicas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/channels/meta/webhook
//   POST /v1/channels/meta/webhook
import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, EVENT_BATCH, EVENT_MAX_ATTEMPTS, FAKE_WHATSAPP_TOKEN, MAX_BATCHES_PER_RUN, PAYLOAD_RETENTION_DAYS, WebhookEventsJob } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { ConversationsService } from '../../src/modules/conversations';
import { OrganizationsModule } from '../../src/modules/organizations';
import { PlatformCredentialsReader } from '../../src/modules/platform';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a',
  bob: 'b0000000-0000-4000-8000-00000000000b',
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const KEY = randomBytes(32).toString('base64');
const APP_SECRET = 'app-secret-de-prueba-9f8e7d6c5b4a3210';
const VERIFY_TOKEN = 'verify-token-de-prueba-0a1b2c3d4e5f';
const PHONE_A = '1090123456789'; // número de la empresa A
const PHONE_B = '1090123456780'; // número de la empresa B
const ANA = '593984217730';
const BETO = '593991234567';
const T0 = 1_760_000_000; // segundos desde 1970 de los mensajes de prueba

let admin: Client;
let main: INestApplication;
let base = '';
let hash = '';
let rootToken = '';
let aliceToken = '';
let bobToken = '';
let channelA = '';
let channelB = '';
const apps: INestApplication[] = [];
const saved = { ...process.env };

async function start(): Promise<{ app: INestApplication; base: string }> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return { app, base: `${await app.getUrl()}/v1` };
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const callAt = (b: string, method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${b}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const call = (method: string, path: string, token?: string, body?: unknown) => callAt(base, method, path, token, body);
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const code = async (r: Response): Promise<string> => ((await r.json()) as { error: { code: string } }).error.code;

// ── Meta: firma y cargas ─────────────────────────────────────────────────────
const sign = (raw: Buffer | string, secret = APP_SECRET): string => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

interface WaOpts { phoneId?: string; from?: string; id?: string; text?: string; name?: string; ts?: number; message?: Record<string, unknown> | null; statuses?: Array<Record<string, unknown>> }
/** Aviso de Meta con UN mensaje (por defecto de texto) y, si se pide, estados. */
function wa(o: WaOpts = {}): Record<string, unknown> {
  const from = o.from ?? ANA;
  const message = o.message === null ? undefined : { from, id: o.id ?? 'wamid.A1', timestamp: String(o.ts ?? T0), type: 'text', text: { body: o.text ?? 'Hola, quiero una cita' }, ...(o.message ?? {}) };
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: '1234567890123', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550006789', phone_number_id: o.phoneId ?? PHONE_A }, contacts: [{ profile: { name: o.name ?? 'Ana Torres' }, wa_id: from }], ...(message ? { messages: [message] } : {}), ...(o.statuses ? { statuses: o.statuses } : {}) } }] }],
  };
}
const raw = (payload: unknown): string => JSON.stringify(payload);
/** Manda un aviso firmado (o con la firma que se indique; `null` = sin cabecera). */
function post(payload: unknown, sig?: string | null, b = base): Promise<Response> {
  const body = typeof payload === 'string' ? payload : raw(payload);
  return fetch(`${b}/channels/meta/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-hub-signature-256': sig ?? sign(body) }) }, body });
}
const verifyUrl = (q: Record<string, string>, b = base): string => `${b}/channels/meta/webhook?${new URLSearchParams(q).toString()}`;
const goodChallenge = { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' };

const runJob = (now = new Date()): Promise<number> => main.get(WebhookEventsJob).run(now);

// ── Base de datos ────────────────────────────────────────────────────────────
interface EventRow { id: string; organization_id: string; phone_number_id: string; status: string; attempts: number; last_error: string | null; payload: Record<string, unknown> | null; redacted_at: Date | null; processed_at: Date | null; next_attempt_at: Date }
const events = async (org?: string): Promise<EventRow[]> => (await admin.query(`SELECT * FROM webhook_events ${org ? `WHERE organization_id = '${org}'` : ''} ORDER BY received_at, id`)).rows as EventRow[];
interface ConvRow { id: string; organization_id: string; contact_id: string; channel_account_id: string; status: string; owner_id: string | null; queue_id: string | null; unread_count: number; last_message_at: Date | null; last_inbound_at: Date | null }
const convs = async (org = ORG_A): Promise<ConvRow[]> => (await admin.query('SELECT * FROM conversations WHERE organization_id = $1 ORDER BY created_at, id', [org])).rows as ConvRow[];
interface MsgRow { id: string; conversation_id: string; external_id: string | null; direction: string; sender_type: string; kind: string; body: string | null; media: Record<string, unknown> | null; meta: Record<string, unknown>; status: string; error: string | null; sent_at: Date; delivered_at: Date | null; read_at: Date | null }
const msgs = async (org = ORG_A): Promise<MsgRow[]> => (await admin.query('SELECT * FROM messages WHERE organization_id = $1 ORDER BY sent_at, id', [org])).rows as MsgRow[];
interface ContactRow { id: string; name: string; source: string; consent: string; created_by: string | null }
const contactsOf = async (org = ORG_A): Promise<Array<ContactRow & { phone: string }>> =>
  (await admin.query(`SELECT c.*, p.e164 AS phone FROM contacts c JOIN contact_phones p ON p.contact_id = c.id AND p.organization_id = c.organization_id WHERE c.organization_id = $1 ORDER BY c.created_at`, [org])).rows;
const iso = (s: number): string => new Date(s * 1000).toISOString();

async function seed(): Promise<void> {
  await admin.query('TRUNCATE messages, conversations, webhook_events, whatsapp_accounts, channel_accounts, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, platform_audit, provider_credentials, provider_selection, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  for (const [id, email] of [[IDS.alice, 'alice@a.test'], [IDS.bob, 'bob@b.test'], [IDS.root, 'root@plat.test']] as const) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

/** La plataforma guarda la aplicación de Meta y la pone en uso (por la API, como lo haría el Súper Admin). */
async function configurePlatform(): Promise<void> {
  const saveR = await call('PUT', '/platform/providers/whatsapp_official/meta_cloud/credentials', rootToken, { values: { app_id: '1234567890', app_secret: APP_SECRET, verify_token: VERIFY_TOKEN } });
  expect(saveR.status).toBe(200);
  expect((await call('PUT', '/platform/providers/whatsapp_official/active', rootToken, { provider: 'meta_cloud' })).status).toBe(200);
}
async function connect(token: string, phoneId: string, name: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  const s = await start();
  main = s.app;
  base = s.base;
});
afterAll(async () => { for (const a of apps) await a.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  main.get(PlatformCredentialsReader).invalidate(); // las tablas se vaciaron por fuera del servicio: se olvida lo guardado en memoria
  rootToken = await login('root@plat.test');
  aliceToken = await login('alice@a.test');
  bobToken = await login('bob@b.test');
  await configurePlatform();
  channelA = await connect(aliceToken, PHONE_A, 'Ventas');
  channelB = await connect(bobToken, PHONE_B, 'Soporte');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('verificación inicial (GET)', () => {
  it('devuelve el desafío como texto plano solo con el modo y el token de verificación correctos', async () => {
    const r = await fetch(verifyUrl(goodChallenge));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await r.text()).toBe('1158201444');
  });

  it('un token, un modo o un desafío incorrectos o ausentes responden 403 uniforme', async () => {
    for (const q of [{ ...goodChallenge, 'hub.verify_token': 'otro-token' }, { ...goodChallenge, 'hub.mode': 'unsubscribe' }, { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }, { 'hub.mode': 'subscribe', 'hub.challenge': '1' }, {}]) {
      const r = await fetch(verifyUrl(q as Record<string, string>));
      expect(r.status, JSON.stringify(q)).toBe(403);
      expect(await code(r)).toBe('WEBHOOK_REJECTED');
    }
  });
});

describe('plataforma sin configurar', () => {
  it('sin la aplicación de Meta guardada, o guardada pero no en uso, GET y POST responden 503 y no guardan nada', async () => {
    await call('PUT', '/platform/providers/whatsapp_official/active', rootToken, { provider: null }); // se quita de uso (invalida la memoria al instante)
    for (const r of [await fetch(verifyUrl(goodChallenge)), await post(wa())]) {
      expect(r.status).toBe(503);
      expect(await code(r)).toBe('WEBHOOK_NOT_CONFIGURED');
    }
    expect(await events()).toEqual([]);
    // vuelve a ponerse en uso y funciona al instante
    expect((await call('PUT', '/platform/providers/whatsapp_official/active', rootToken, { provider: 'meta_cloud' })).status).toBe(200);
    expect((await fetch(verifyUrl(goodChallenge))).status).toBe(200);
  });

  it('cambiar el secreto de la aplicación surte efecto en el acto: la firma con el secreto anterior deja de valer', async () => {
    const p = wa();
    expect((await post(p)).status).toBe(200);
    const next = 'otro-secreto-de-la-app-1234567890abcdef';
    await call('PUT', '/platform/providers/whatsapp_official/active', rootToken, { provider: null });
    expect((await call('PUT', '/platform/providers/whatsapp_official/meta_cloud/credentials', rootToken, { values: { app_secret: next } })).status).toBe(200);
    await call('PUT', '/platform/providers/whatsapp_official/active', rootToken, { provider: 'meta_cloud' });
    expect((await post(wa({ id: 'wamid.B1' }))).status).toBe(403); // firmado con el secreto viejo
    expect((await post(wa({ id: 'wamid.B1' }), sign(raw(wa({ id: 'wamid.B1' })), next))).status).toBe(200);
  });
});

describe('lector de credenciales de la plataforma', () => {
  it('guarda lo leído 30 s (cada aviso lo consulta) y después vuelve a la base de datos; nunca devuelve algo que no esté en uso', async () => {
    const reader = main.get(PlatformCredentialsReader);
    const first = await reader.active('whatsapp_official');
    expect(first).toMatchObject({ provider: 'meta_cloud', values: { app_secret: APP_SECRET, verify_token: VERIFY_TOKEN, app_id: '1234567890' } });
    await admin.query(`DELETE FROM provider_selection`); // un cambio hecho por fuera del servicio no se nota de inmediato…
    expect(await reader.active('whatsapp_official')).toEqual(first);
    expect(await reader.active('whatsapp_official', Date.now() + 29_000)).toEqual(first);
    expect(await reader.active('whatsapp_official', Date.now() + 31_000)).toBeNull(); // …pero sí pasados los 30 s
    expect(await reader.active('mail')).toBeNull(); // un servicio sin proveedor en uso
  });

  it('con una clave maestra distinta a la que cifró los datos, se trata como «sin credenciales» (503 del webhook) y no como un error', async () => {
    await admin.query(`UPDATE provider_credentials SET secrets_sealed = regexp_replace(secrets_sealed, '[A-Za-z0-9]', 'x', 'g') WHERE service = 'whatsapp_official'`); // sobre ilegible
    main.get(PlatformCredentialsReader).invalidate();
    const r = await fetch(verifyUrl(goodChallenge));
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('WEBHOOK_NOT_CONFIGURED');
  });
});

describe('firma del aviso (POST)', () => {
  it('sin firma, con firma equivocada, de otro cuerpo o mal formada: 403 y no se guarda nada', async () => {
    const p = wa();
    const body = raw(p);
    const cases: Array<[string, string | null]> = [['sin cabecera', null], ['vacía', ''], ['secreto equivocado', sign(body, 'otro')], ['de otro cuerpo', sign(raw(wa({ id: 'wamid.X' })))], ['sin prefijo', sign(body).slice(7)], ['sha1', `sha1=${sign(body).slice(7)}`], ['corta', sign(body).slice(0, 20)]];
    for (const [label, sig] of cases) {
      const r = await post(body, sig);
      expect(r.status, label).toBe(403);
      expect(await code(r), label).toBe('WEBHOOK_REJECTED');
    }
    expect(await events()).toEqual([]);
  });

  it('la firma es sobre los bytes EXACTOS: el mismo JSON con otro formato no vale', async () => {
    const p = wa();
    const sig = sign(raw(p));
    expect((await post(JSON.stringify(p, null, 2), sig)).status).toBe(403);
    expect((await post(raw(p), sig)).status).toBe(200);
  });

  it('con firma válida pero un cuerpo que no es JSON: 400; con un JSON que no es de WhatsApp: 200 sin efecto', async () => {
    const notJson = 'esto no es json';
    expect((await post(notJson, sign(notJson))).status).toBe(400);
    for (const other of [{ object: 'page', entry: [] }, [], 'null', {}]) {
      const body = typeof other === 'string' ? other : raw(other);
      expect((await post(body, sign(body))).status, body).toBe(200);
    }
    expect(await events()).toEqual([]);
  });

  it('un cuerpo de más de 1 MB responde 413 sin procesarlo', async () => {
    const big = 'x'.repeat(1024 * 1024 + 10);
    const r = await post(big, sign(big));
    expect(r.status).toBe(413);
    expect(await code(r)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('una ruta con barra final no pasa por el lector crudo: no se puede verificar y se rechaza (400)', async () => {
    const body = raw(wa());
    const r = await fetch(`${base}/channels/meta/webhook/`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    expect(r.status).toBe(400);
    expect(await events()).toEqual([]);
  });

  it('demasiados fallos de firma desde una IP: 429 con Retry-After, y entonces ni un aviso válido pasa hasta que se libere (el límite es por proceso)', async () => {
    const s = await start(); // otra instancia: su límite empieza en cero y no afecta a las demás pruebas
    const b = s.base;
    const body = raw(wa());
    let last: Response | undefined;
    for (let i = 0; i < 30; i++) {
      last = await post(body, sign(body, 'malo'), b);
      expect(last.status).toBe(403);
    }
    last = await post(body, undefined, b); // firma válida, pero la IP ya está bloqueada
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await fetch(verifyUrl(goodChallenge, b))).status).toBe(429); // la verificación comparte el límite
    expect((await post(body)).status).toBe(200); // la instancia principal no se ve afectada
  });
});

describe('recibir y guardar', () => {
  it('un aviso de un número conectado se guarda ya con SU empresa, anota la hora del último aviso y no crea mensajes hasta que corre la tarea', async () => {
    const before = (await json<{ items: Array<{ id: string; last_event_at: string | null }> }>(await call('GET', '/channels', aliceToken))).items[0]!;
    expect(before.last_event_at).toBeNull();
    const r = await post(wa());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ organization_id: ORG_A, phone_number_id: PHONE_A, status: 'pending', attempts: 0 });
    expect(ev[0]!.payload).toMatchObject({ metadata: { phone_number_id: PHONE_A } });
    expect(await msgs()).toEqual([]);
    const after = (await json<{ items: Array<{ id: string; last_event_at: string | null }> }>(await call('GET', '/channels', aliceToken))).items[0]!;
    expect(after.id).toBe(channelA);
    expect(new Date(after.last_event_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('un número que no está conectado (o fue desconectado) responde 200 igual y no deja rastro', async () => {
    expect((await post(wa({ phoneId: '1090000000001' }))).status).toBe(200);
    await call('DELETE', `/channels/${channelA}`, aliceToken); // se desconecta: la ruta queda inactiva
    expect((await post(wa({ id: 'wamid.Z' }))).status).toBe(200);
    expect(await events()).toEqual([]);
  });

  it('Meta reintenta la MISMA entrega: se guarda una sola vez', async () => {
    const p = wa();
    for (let i = 0; i < 3; i++) expect((await post(p)).status).toBe(200);
    expect(await events()).toHaveLength(1);
  });

  it('un aviso con números de DOS empresas se reparte: cada empresa guarda solo lo suyo', async () => {
    const a = wa({ phoneId: PHONE_A, id: 'wamid.A1', text: 'para A' });
    const b = wa({ phoneId: PHONE_B, from: BETO, id: 'wamid.B1', text: 'para B', name: 'Beto Ruiz' });
    const both = { object: 'whatsapp_business_account', entry: [...(a['entry'] as unknown[]), ...(b['entry'] as unknown[])] };
    expect((await post(both)).status).toBe(200);
    const ev = await events();
    expect(ev.map((e) => [e.organization_id, e.phone_number_id]).sort()).toEqual([[ORG_A, PHONE_A], [ORG_B, PHONE_B]].sort());
    for (const e of ev) expect(JSON.stringify(e.payload)).not.toContain(e.organization_id === ORG_A ? 'para B' : 'para A'); // cada fila trae solo la parte de su número
    await runJob();
    expect((await msgs(ORG_A)).map((m) => m.body)).toEqual(['para A']);
    expect((await msgs(ORG_B)).map((m) => m.body)).toEqual(['para B']);
  });
});

describe('procesar: contacto, conversación y mensajes', () => {
  it('el primer mensaje de alguien nuevo crea su contacto (nombre del perfil, sin consentimiento, sin responsable), su conversación sin asignar y el mensaje', async () => {
    await post(wa());
    expect(await runJob()).toBe(1);
    const c = await contactsOf();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: 'Ana Torres', phone: `+${ANA}`, source: 'whatsapp', consent: 'unknown', created_by: null });
    const cv = await convs();
    expect(cv).toHaveLength(1);
    expect(cv[0]).toMatchObject({ contact_id: c[0]!.id, channel_account_id: channelA, status: 'unassigned', unread_count: 1 });
    expect(cv[0]!.last_message_at!.toISOString()).toBe(iso(T0));
    expect(cv[0]!.last_inbound_at!.toISOString()).toBe(iso(T0));
    const m = await msgs();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ conversation_id: cv[0]!.id, external_id: 'wamid.A1', direction: 'in', sender_type: 'contact', kind: 'text', body: 'Hola, quiero una cita', status: 'received', media: null });
    expect(m[0]!.meta).toEqual({ wa_id: ANA });
    expect(m[0]!.sent_at.toISOString()).toBe(iso(T0));
    const ev = await events();
    expect(ev[0]).toMatchObject({ status: 'done', attempts: 1, last_error: null });
    expect(ev[0]!.processed_at).not.toBeNull();
    // la creación del contacto y de la conversación quedan en la auditoría, SIN el texto del mensaje
    const audit = JSON.stringify((await admin.query(`SELECT * FROM audit_logs WHERE organization_id = $1`, [ORG_A])).rows);
    expect(audit).toContain('conversation');
    expect(audit).not.toContain('Hola, quiero una cita');
  });

  it('quien escribe por primera vez es un lead: el sistema le pone la etiqueta «Lead»; a un contacto que ya existía no se le pone ni se le quita nada, y no se manda ningún evento a Meta', async () => {
    expect((await call('POST', '/contacts', aliceToken, { name: 'Ya existía', phones: [`+${BETO}`] })).status).toBe(201);
    await post(wa({ id: 'wamid.N1' })); // Ana, nueva
    await post(wa({ from: BETO, id: 'wamid.E1', name: 'Beto' })); // Beto, que ya era contacto
    await runJob();
    const tagsOf = async (name: string) => (await admin.query(`SELECT t.system_key, ct.set_by FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id AND t.organization_id = ct.organization_id JOIN contacts c ON c.id = ct.contact_id WHERE c.organization_id = $1 AND c.name = $2`, [ORG_A, name])).rows;
    expect(await tagsOf('Ana Torres')).toEqual([{ system_key: 'lead', set_by: 'system' }]);
    expect(await tagsOf('Ya existía')).toEqual([]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM meta_events WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(0);
    await post(wa({ id: 'wamid.N2', ts: T0 + 5 })); // Ana vuelve a escribir: no se repite
    await runJob();
    expect(await tagsOf('Ana Torres')).toHaveLength(1);
  });

  it('los siguientes mensajes del mismo contacto caen en LA MISMA conversación (una abierta por contacto y canal) y suman no leídos', async () => {
    await post(wa({ id: 'wamid.A1', ts: T0 }));
    await post(wa({ id: 'wamid.A2', ts: T0 + 30, text: 'segundo' }));
    await runJob();
    await post(wa({ id: 'wamid.A3', ts: T0 + 60, text: 'tercero' }));
    await runJob();
    expect(await contactsOf()).toHaveLength(1);
    const cv = await convs();
    expect(cv).toHaveLength(1);
    expect(cv[0]).toMatchObject({ unread_count: 3, status: 'unassigned' });
    expect(cv[0]!.last_message_at!.toISOString()).toBe(iso(T0 + 60));
    expect((await msgs()).map((m) => m.body)).toEqual(['Hola, quiero una cita', 'segundo', 'tercero']);
  });

  it('un mensaje ANTIGUO que llega tarde no adelanta ni atrasa el último mensaje de la conversación', async () => {
    await post(wa({ id: 'wamid.A2', ts: T0 + 100 }));
    await runJob();
    await post(wa({ id: 'wamid.A1', ts: T0 }));
    await runJob();
    const cv = (await convs())[0]!;
    expect(cv.unread_count).toBe(2);
    expect(cv.last_message_at!.toISOString()).toBe(iso(T0 + 100));
    expect((await msgs()).map((m) => m.external_id)).toEqual(['wamid.A1', 'wamid.A2']); // en orden de envío
  });

  it('un contacto que ya existe con ese teléfono se reutiliza, sin tocar su nombre ni su consentimiento', async () => {
    const made = await call('POST', '/contacts', aliceToken, { name: 'Ana (manual)', phones: [`+${ANA}`], consent: 'granted' });
    expect(made.status).toBe(201);
    await post(wa());
    await runJob();
    const c = await contactsOf();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: 'Ana (manual)', consent: 'granted', source: 'manual' });
    expect((await convs())[0]!.contact_id).toBe(c[0]!.id);
  });

  it('un nombre de perfil con caracteres de control o larguísimo no rompe nada y queda dentro del límite', async () => {
    await post(wa({ name: `  Ana\u0007 ${'Torres '.repeat(60)}` }));
    await runJob();
    const name = (await contactsOf())[0]!.name;
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).not.toMatch(/\p{Cc}/u);
    expect(name.startsWith('Ana')).toBe(true);
  });

  it('el carácter NUL (U+0000) en un texto no lo rompe: PostgreSQL no lo admite, así que se quita al guardar el aviso y el mensaje', async () => {
    const r = await post(wa({ text: 'ho\u0000la', name: 'An\u0000a' }));
    expect(r.status).toBe(200);
    expect(JSON.stringify((await events())[0]!.payload)).not.toContain('\\u0000');
    await runJob();
    expect((await msgs())[0]!.body).toBe('hola');
    expect((await contactsOf())[0]!.name).toBe('Ana');
    expect((await events())[0]!.status).toBe('done');
  });

  it('el mismo mensaje en un aviso DISTINTO (mismo identificador) se ignora: ni duplica el mensaje ni suma no leídos', async () => {
    await post(wa({ id: 'wamid.A1' }));
    await runJob();
    await post(wa({ id: 'wamid.A1', text: 'texto distinto', ts: T0 + 5 })); // otra huella, mismo wamid
    expect(await runJob()).toBe(1);
    expect(await msgs()).toHaveLength(1);
    expect((await msgs())[0]!.body).toBe('Hola, quiero una cita');
    expect((await convs())[0]!.unread_count).toBe(1);
    expect((await events()).map((e) => e.status)).toEqual(['done', 'done']);
  });

  it('con la conversación cerrada, el siguiente mensaje abre otra; con la conversación esperando al cliente, vuelve a «trabajando»', async () => {
    await post(wa({ id: 'wamid.A1' }));
    await runJob();
    await admin.query(`UPDATE conversations SET status = 'waiting', owner_id = $2, assigned_at = now() WHERE organization_id = $1`, [ORG_A, IDS.alice]); // esperando al cliente: ya tiene quien la atiende
    await post(wa({ id: 'wamid.A2', ts: T0 + 10 }));
    await runJob();
    expect((await convs()).map((c) => c.status)).toEqual(['working']);
    await admin.query(`UPDATE conversations SET status = 'closed' WHERE organization_id = $1`, [ORG_A]);
    await post(wa({ id: 'wamid.A3', ts: T0 + 20 }));
    await runJob();
    const cv = await convs();
    expect(cv.map((c) => [c.status, c.unread_count])).toEqual([['closed', 2], ['unassigned', 1]]);
    expect(new Set((await msgs()).map((m) => m.conversation_id)).size).toBe(2);
  });

  it('adjuntos: queda la referencia y el pie, sin archivo (se descargarán en M5.6); las reacciones y los avisos del sistema se omiten; lo desconocido queda como «no compatible»', async () => {
    const mk = (id: string, ts: number, message: Record<string, unknown>) => post(wa({ id, ts, message: { type: message['type'], ...message } }));
    await mk('wamid.IMG', T0, { type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'mi corte' }, text: undefined });
    await mk('wamid.AUD', T0 + 1, { type: 'audio', audio: { id: 'media-2', mime_type: 'audio/ogg' }, text: undefined });
    await mk('wamid.RXN', T0 + 2, { type: 'reaction', reaction: { message_id: 'wamid.A0', emoji: '\u{1F44D}' }, text: undefined });
    await mk('wamid.ORD', T0 + 3, { type: 'order', order: {}, text: undefined });
    await runJob();
    const m = await msgs();
    expect(m.map((x) => [x.external_id, x.kind, x.body])).toEqual([['wamid.IMG', 'image', 'mi corte'], ['wamid.AUD', 'audio', null], ['wamid.ORD', 'unsupported', null]]);
    expect(m[0]!.media).toEqual({ id: 'media-1', mime_type: 'image/jpeg', filename: null });
    expect((await events()).map((e) => e.status)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('un teléfono que no tiene forma de E.164 se descarta sin romper el aviso ni crear contacto', async () => {
    await post(wa({ from: 'abc', id: 'wamid.BAD' }));
    await runJob();
    expect(await contactsOf()).toEqual([]);
    expect(await msgs()).toEqual([]);
    expect((await events())[0]!.status).toBe('done');
  });

  it('con una cola de reparto en la conexión, el mensaje que llega por el webhook queda asignado a un asesor (la tarea lee la identidad antes de abrir la transacción)', async () => {
    const q = await json<{ id: string }>(await call('POST', '/queues', aliceToken, { name: 'Ventas' }));
    expect((await call('PATCH', `/queues/${q.id}`, aliceToken, { distribution_on: true })).status).toBe(200);
    expect((await call('PUT', `/queues/${q.id}/members`, aliceToken, { members: [{ user_id: IDS.alice, active: true, weight: 1 }] })).status).toBe(200);
    expect((await call('PATCH', `/channels/${channelA}`, aliceToken, { queue_id: q.id })).status).toBe(200);
    await post(wa());
    await runJob();
    const cv = await convs();
    expect(cv).toHaveLength(1);
    expect(cv[0]).toMatchObject({ status: 'pending', owner_id: IDS.alice, queue_id: q.id });
    expect((await contactsOf())[0]!.id).toBe(cv[0]!.contact_id); // y el contacto quedó en su cartera
    expect((await admin.query(`SELECT owner_id FROM contacts WHERE organization_id = $1`, [ORG_A])).rows[0].owner_id).toBe(IDS.alice);
  });

  it('una conexión DESACTIVADA sigue recibiendo: los mensajes de clientes no se pierden', async () => {
    await call('PATCH', `/channels/${channelA}`, aliceToken, { status: 'disabled' });
    await post(wa());
    await runJob();
    expect(await msgs()).toHaveLength(1);
  });
});

describe('estados de entrega de los mensajes que enviamos', () => {
  /** Un mensaje NUESTRO ya enviado (el envío llega en M5.4): se inserta directo para probar los avisos de estado. */
  async function seedOutbound(status = 'sent'): Promise<string> {
    await post(wa({ id: 'wamid.IN1' }));
    await runJob();
    const conv = (await convs())[0]!;
    await admin.query(
      `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1,$2,$3,'wamid.OUT1','out','human','text','Hola Ana',$4, $5)`,
      [ORG_A, conv.id, channelA, status, new Date(T0 * 1000 + 5000)],
    );
    return conv.id;
  }
  const st = (state: string, ts: number, extra: Record<string, unknown> = {}) => ({ id: 'wamid.OUT1', status: state, timestamp: String(ts), recipient_id: ANA, ...extra });
  const out = async (): Promise<MsgRow> => (await msgs()).find((m) => m.external_id === 'wamid.OUT1')!;
  const feed = async (s: Record<string, unknown>, n: number) => { await post(wa({ message: null, statuses: [s], id: `evt-${n}` })); await runJob(); };

  it('entregado y leído avanzan el estado y guardan su hora', async () => {
    await seedOutbound();
    await feed(st('delivered', T0 + 10), 1);
    expect(await out()).toMatchObject({ status: 'delivered', delivered_at: new Date(T0 * 1000 + 10_000), read_at: null });
    await feed(st('read', T0 + 20), 2);
    expect(await out()).toMatchObject({ status: 'read', read_at: new Date(T0 * 1000 + 20_000) });
  });

  it('los avisos desordenados nunca retroceden el estado: «leído» y luego «entregado» deja «leído» con las dos horas', async () => {
    await seedOutbound();
    await feed(st('read', T0 + 20), 1);
    await feed(st('delivered', T0 + 10), 2);
    await feed(st('sent', T0 + 5), 3);
    expect(await out()).toMatchObject({ status: 'read', delivered_at: new Date(T0 * 1000 + 10_000), read_at: new Date(T0 * 1000 + 20_000) });
  });

  it('un fallo marca «failed» con el código y el título; pero no pisa un mensaje ya entregado', async () => {
    await seedOutbound();
    await feed(st('failed', T0 + 10, { errors: [{ code: 131047, title: 'Re-engagement message' }] }), 1);
    expect(await out()).toMatchObject({ status: 'failed', error: '131047: Re-engagement message' });
    await admin.query(`UPDATE messages SET status = 'delivered', error = NULL WHERE organization_id = $1 AND external_id = 'wamid.OUT1'`, [ORG_A]);
    await feed(st('failed', T0 + 30, { errors: [{ code: 1, title: 'x' }] }), 2);
    expect(await out()).toMatchObject({ status: 'delivered', error: null });
  });

  it('un estado de un mensaje que no conocemos se ignora sin error y no toca nada más', async () => {
    await seedOutbound();
    await post(wa({ message: null, statuses: [{ id: 'wamid.OTRO', status: 'read', timestamp: String(T0 + 9) }], id: 'evt-x' }));
    expect(await runJob()).toBe(1);
    expect((await events()).every((e) => e.status === 'done')).toBe(true);
    expect(await out()).toMatchObject({ status: 'sent', read_at: null });
  });

  it('un estado solo toca mensajes de ESA empresa y de ESE canal: la misma identificación en otra empresa no se ve afectada', async () => {
    await seedOutbound();
    await post(wa({ phoneId: PHONE_B, from: BETO, id: 'wamid.IN-B' }));
    await runJob();
    const convB = (await convs(ORG_B))[0]!;
    await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, status, sent_at) VALUES (gen_random_uuid(), $1,$2,$3,'wamid.OUT1','out','human','text','sent', now())`, [ORG_B, convB.id, channelB]);
    await feed(st('read', T0 + 20), 1); // el aviso llega por el número de A
    expect((await msgs(ORG_B)).find((m) => m.external_id === 'wamid.OUT1')!.status).toBe('sent');
    expect((await out()).status).toBe('read');
  });
});

describe('fallos, reintentos y concurrencia', () => {
  it('si un aviso falla se revierte TODO lo suyo (savepoint), se reintenta con espera y a la segunda sale; el error guardado no lleva el texto del cliente', async () => {
    const svc = main.get(ConversationsService);
    const original = svc.ingestInbound.bind(svc);
    vi.spyOn(svc, 'ingestInbound').mockImplementationOnce(async (...args) => {
      await original(...args); // hace el trabajo de verdad (contacto, conversación, mensaje)…
      throw new Error('boom con el texto secreto del cliente: Hola, quiero una cita'); // …y luego falla
    });
    await post(wa());
    const t0 = new Date();
    expect(await runJob(t0)).toBe(1);
    expect(await msgs()).toEqual([]); // revertido
    expect(await contactsOf()).toEqual([]);
    expect(await convs()).toEqual([]);
    let ev = (await events())[0]!;
    expect(ev).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Error' });
    expect(ev.last_error).not.toContain('secreto');
    expect(ev.next_attempt_at.getTime()).toBeGreaterThan(t0.getTime());
    expect(await runJob(t0)).toBe(0); // todavía no le toca
    expect(await runJob(new Date(t0.getTime() + 60_000))).toBe(1);
    ev = (await events())[0]!;
    expect(ev).toMatchObject({ status: 'done', attempts: 2, last_error: null });
    expect(await msgs()).toHaveLength(1);
  });

  it(`tras ${EVENT_MAX_ATTEMPTS} intentos el aviso queda «failed» y deja de reintentarse`, async () => {
    vi.spyOn(main.get(ConversationsService), 'ingestInbound').mockRejectedValue(new Error('siempre falla'));
    await post(wa());
    let now = Date.now();
    for (let i = 0; i < EVENT_MAX_ATTEMPTS; i++) {
      expect(await runJob(new Date(now))).toBe(1);
      now += 20 * 60_000;
    }
    expect((await events())[0]).toMatchObject({ status: 'failed', attempts: EVENT_MAX_ATTEMPTS, last_error: 'Error' });
    expect(await runJob(new Date(now + 3_600_000))).toBe(0);
    expect(await msgs()).toEqual([]);
  });

  it('un aviso malo no aborta a los demás del mismo lote', async () => {
    const svc = main.get(ConversationsService);
    const original = svc.ingestInbound.bind(svc);
    vi.spyOn(svc, 'ingestInbound').mockImplementation(async (tx, channel, m, assign) => {
      if (m.externalId === 'wamid.MALO') throw new Error('falla este');
      return original(tx, channel, m, assign);
    });
    await post(wa({ id: 'wamid.MALO', ts: T0 }));
    await post(wa({ id: 'wamid.BUENO', ts: T0 + 1 }));
    expect(await runJob()).toBe(2);
    expect((await msgs()).map((m) => m.external_id)).toEqual(['wamid.BUENO']);
    expect((await events()).map((e) => e.status)).toEqual(['pending', 'done']);
  });

  it('dos ejecuciones SIMULTÁNEAS de la tarea no procesan dos veces el mismo aviso (SKIP LOCKED) ni duplican el mensaje', async () => {
    for (let i = 0; i < 6; i++) await post(wa({ id: `wamid.C${i}`, ts: T0 + i, text: `m${i}` }));
    const [a, b] = await Promise.all([runJob(), runJob()]);
    expect(a + b).toBeGreaterThanOrEqual(6);
    expect(await runJob()).toBe(0);
    const m = await msgs();
    expect(m).toHaveLength(6);
    expect(new Set(m.map((x) => x.external_id)).size).toBe(6);
    expect((await convs())).toHaveLength(1);
    expect((await convs())[0]!.unread_count).toBe(6);
    expect((await events()).every((e) => e.status === 'done')).toBe(true);
  });

  it(`una ráfaga grande se drena en una sola pasada de la tarea (lotes de ${EVENT_BATCH}, hasta ${MAX_BATCHES_PER_RUN} seguidos por empresa)`, async () => {
    const total = EVENT_BATCH * 2 + 5;
    for (let i = 0; i < total; i++) await post(wa({ id: `wamid.S${i}`, ts: T0 + i, text: `m${i}` }));
    expect(await runJob()).toBe(total);
    expect(await runJob()).toBe(0);
    expect(await msgs()).toHaveLength(total);
    expect((await convs())[0]!.unread_count).toBe(total);
  });

  it('dos mensajes del MISMO contacto procesados a la vez por instancias distintas no abren dos conversaciones ni dos contactos', async () => {
    for (let i = 0; i < 8; i++) await post(wa({ id: `wamid.R${i}`, ts: T0 + i }));
    await Promise.all([runJob(), runJob(), runJob()]);
    expect(await contactsOf()).toHaveLength(1);
    expect(await convs()).toHaveLength(1);
    expect(await msgs()).toHaveLength(8);
  });
});

describe('retención de datos personales', () => {
  it(`a los ${PAYLOAD_RETENTION_DAYS} días el contenido de un aviso ya procesado se vacía; los recientes y los pendientes no se tocan`, async () => {
    await post(wa({ id: 'wamid.OLD', ts: T0 }));
    await post(wa({ id: 'wamid.NEW', ts: T0 + 1 }));
    await runJob();
    const [old, recent] = await events();
    const longAgo = new Date(Date.now() - (PAYLOAD_RETENTION_DAYS + 1) * 86_400_000);
    await admin.query(`UPDATE webhook_events SET processed_at = $2 WHERE id = $1`, [old!.id, longAgo]);
    await post(wa({ id: 'wamid.PEND', ts: T0 + 2 })); // pendiente: no se toca aunque sea viejo
    await admin.query(`UPDATE webhook_events SET received_at = $1 WHERE status = 'pending'`, [longAgo]);
    await runJob(new Date(Date.now() - 3_600_000 * 24 * 365)); // una pasada «en el pasado» no vacía nada
    expect((await events()).find((e) => e.id === old!.id)!.payload).not.toBeNull();
    await runJob();
    const after = await events();
    expect(after.find((e) => e.id === old!.id)).toMatchObject({ payload: null, status: 'done' });
    expect(after.find((e) => e.id === old!.id)!.redacted_at).not.toBeNull();
    expect(after.find((e) => e.id === recent!.id)!.payload).not.toBeNull();
    // el mensaje ya guardado no depende del aviso
    expect((await msgs()).map((m) => m.external_id)).toContain('wamid.OLD');
  });
});

describe('aislamiento A↔B y base de datos', () => {
  it('cada empresa solo ve sus eventos, conversaciones y mensajes (RLS); sin empresa activa no se ve nada', async () => {
    await post(wa({ phoneId: PHONE_A, id: 'wamid.A1' }));
    await post(wa({ phoneId: PHONE_B, from: BETO, id: 'wamid.B1', name: 'Beto Ruiz' }));
    await runJob();
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const t of ['webhook_events', 'conversations', 'messages']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      for (const t of ['webhook_events', 'conversations', 'messages']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(1);
      expect((await c.query(`SELECT body FROM messages`)).rows).toEqual([{ body: 'Hola, quiero una cita' }]);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect((await contactsOf(ORG_B)).map((x) => x.name)).toEqual(['Beto Ruiz']);
    expect((await contactsOf(ORG_A)).map((x) => x.name)).toEqual(['Ana Torres']);
  });

  it('un mismo teléfono que escribe a dos empresas es un contacto distinto en cada una', async () => {
    await post(wa({ phoneId: PHONE_A, id: 'wamid.A1' }));
    await post(wa({ phoneId: PHONE_B, id: 'wamid.B1' })); // la misma Ana escribe al número de B
    await runJob();
    const a = await contactsOf(ORG_A);
    const b = await contactsOf(ORG_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect((await convs(ORG_A))[0]!.contact_id).toBe(a[0]!.id);
    expect((await convs(ORG_B))[0]!.contact_id).toBe(b[0]!.id);
  });

  const as = async (url: string, sql: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  };

  it('solo app_rw toca estas tablas, y sin DELETE ni TRUNCATE (los mensajes no se borran)', async () => {
    for (const t of ['webhook_events', 'conversations', 'messages']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `DELETE ${t}`).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });

  it('las restricciones protegen la forma de los datos y las claves foráneas impiden cruzar empresas', async () => {
    await post(wa());
    await runJob();
    const conv = (await convs())[0]!;
    const sql = (text: string, params: unknown[] = []) => admin.query(text, params);
    const msg = (cols: string, vals: string) => `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, status, sent_at, ${cols}) VALUES (gen_random_uuid(), '${ORG_A}', '${conv.id}', '${channelA}', ${vals})`;
    await expect(sql(msg('external_id', `'in', 'human', 'text', 'received', now(), 'x1'`))).rejects.toThrow(/messages_sender_direction/); // lo que entra lo escribe el contacto
    await expect(sql(msg('external_id', `'out', 'contact', 'text', 'sent', now(), 'x2'`))).rejects.toThrow(/messages_sender_direction/);
    await expect(sql(msg('external_id', `'in', 'contact', 'video_note', 'received', now(), 'x3'`))).rejects.toThrow(/messages_kind_valid/);
    await expect(sql(msg('external_id', `'in', 'contact', 'text', 'raro', now(), 'x4'`))).rejects.toThrow(/messages_status_valid/);
    await expect(sql(msg('external_id', `'in', 'contact', 'text', 'received', now(), 'wamid.A1'`))).rejects.toThrow(/messages_channel_external_uq/);
    await expect(sql(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, status, sent_at) VALUES (gen_random_uuid(), '${ORG_B}', '${conv.id}', '${channelB}', 'in', 'contact', 'text', 'received', now())`)).rejects.toThrow(/messages_conversation_fk/); // conversación de otra empresa
    await expect(sql(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id) VALUES (gen_random_uuid(), '${ORG_A}', '${conv.contact_id}', '${channelA}')`)).rejects.toThrow(/conversations_one_open_uq/); // una sola abierta
    await expect(sql(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at) VALUES (gen_random_uuid(), '${ORG_A}', '${conv.contact_id}', '${channelA}', 'abierta', '${IDS.alice}', now())`)).rejects.toThrow(/conversations_status_valid/);
    await expect(sql(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id) VALUES (gen_random_uuid(), '${ORG_B}', '${conv.contact_id}', '${channelB}')`)).rejects.toThrow(/conversations_contact_fk/); // contacto de otra empresa
    await expect(sql(`INSERT INTO webhook_events(id, organization_id, channel_account_id, phone_number_id, payload_hash) VALUES (gen_random_uuid(), '${ORG_A}', '${channelA}', '${PHONE_A}', 'no-es-hex')`)).rejects.toThrow(/webhook_events_hash_shape/);
    await expect(sql(`INSERT INTO webhook_events(id, organization_id, channel_account_id, phone_number_id, payload_hash) VALUES (gen_random_uuid(), '${ORG_B}', '${channelA}', '${PHONE_A}', '${'a'.repeat(64)}')`)).rejects.toThrow(/webhook_events_channel_fk/);
    await expect(sql(`UPDATE conversations SET unread_count = -1 WHERE id = $1`, [conv.id])).rejects.toThrow(/conversations_unread_valid/);
  });
});

describe('«Proveedores» muestra la dirección del webhook', () => {
  it('para WhatsApp oficial trae la URL pública de este servidor; el resto de los servicios, null; nunca un secreto', async () => {
    const r = await call('GET', '/platform/providers', rootToken);
    const text = await r.text();
    expect(text).not.toContain(APP_SECRET);
    expect(text).not.toContain(VERIFY_TOKEN);
    const list = JSON.parse(text) as { services: Array<{ key: string; webhook_url: string | null }> };
    expect(list.services.find((s) => s.key === 'whatsapp_official')!.webhook_url).toBe('https://app.ejemplo.test/v1/channels/meta/webhook');
    expect(list.services.filter((s) => s.key !== 'whatsapp_official').every((s) => s.webhook_url === null)).toBe(true);
  });
});
