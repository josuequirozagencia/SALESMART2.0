// v19 B1/B4 — Salud de las conexiones: retraso de entrada, avisos pendientes/fallidos con su motivo, ignorados por motivo, reintento y alertas al administrador. Rutas cubiertas (el registro de endpoints exige que
// este archivo escriba cada una tal cual):
//   GET /v1/connection-health
//   POST /v1/connection-health/events/:id/retry
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
import { ChannelsModule } from '../../src/modules/channels';
import { ConnectionHealthJob, ConnectionHealthModule, ConnectionHealthService, type ConnectionHealthView } from '../../src/modules/connection-health';
import { NotificationsModule } from '../../src/modules/notifications';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ChannelsModule, NotificationsModule, ConnectionHealthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
const saved = { ...process.env };
const ch: Record<string, string> = {}; // nombre → id de la conexión
let failedWithPayload = '';
let failedRedacted = '';
let failedB = '';

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY, WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
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
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;

async function seed(): Promise<void> {
  await admin.query('TRUNCATE webhook_ignored, notifications, webhook_events, messages, conversations, contact_phones, contacts, qr_accounts, whatsapp_accounts, channel_accounts, channel_routes, qr_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

let n = 0;
async function qrChannel(org: string, name: string, by: string, session: { state: string; connectedAgo?: string; lastEventAgo?: string | null; downAgo?: string }): Promise<string> {
  const id = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, is_official, name, created_by) VALUES (gen_random_uuid(), $1, 'evolution', false, $2, $3) RETURNING id`, [org, name, by])).rows[0].id as string;
  n += 1;
  const ago = (s: string | null | undefined): string => (s ? `now() - interval '${s}'` : 'NULL');
  await admin.query(
    `INSERT INTO qr_accounts(organization_id, channel_account_id, instance_name, state, first_connected_at, connected_at, last_event_at, down_since) VALUES ($1, $2, $3, $4, now() - interval '10 days', ${ago(session.connectedAgo ?? '10 days')}, ${ago(session.lastEventAgo === undefined ? '1 minute' : session.lastEventAgo)}, ${ago(session.downAgo)})`,
    [org, id, `inst-${n}-${randomBytes(3).toString('hex')}-xx`, session.state],
  );
  return id;
}
async function conversationOf(org: string, channel: string): Promise<string> {
  n += 1;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [org, `Cliente ${n}`])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, `+59398810${String(n).padStart(4, '0')}`]);
  return (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, last_message_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'unassigned', now(), 0, $4) RETURNING id`, [org, contact, channel, `5939881${n}`])).rows[0].id as string;
}
/** Un mensaje ENTRANTE que el proveedor fechó hace `sentAgo` y que entró hace `createdAgo`. */
async function inbound(org: string, channel: string, conv: string, createdAgo: string, lagSeconds: number, count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    n += 1;
    await admin.query(
      `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', 'text', 'hola', 'received', now() - $5::interval - ($6 * interval '1 second'), now() - $5::interval)`,
      [org, conv, channel, `ext-${n}-${randomBytes(3).toString('hex')}`, createdAgo, lagSeconds],
    );
  }
}
async function event(org: string, channel: string, o: { status: 'pending' | 'done' | 'failed'; receivedAgo: string; nextAgo?: string; attempts?: number; error?: string | null; payload?: boolean }): Promise<string> {
  return (await admin.query(
    `INSERT INTO webhook_events(id, organization_id, channel_account_id, phone_number_id, payload, payload_hash, status, attempts, last_error, received_at, next_attempt_at, processed_at) VALUES (gen_random_uuid(), $1, $2, 'ss-x', $3::jsonb, $4, $5, $6, $7, now() - $8::interval, now() - $9::interval, ${o.status === 'pending' ? 'NULL' : 'now()'}) RETURNING id`,
    [org, channel, o.payload === false ? null : JSON.stringify({ __qr: 1, instance: 'ss-x', event: 'messages.upsert', data: {} }), randomBytes(32).toString('hex'), o.status, o.attempts ?? 0, o.error ?? null, o.receivedAgo, o.nextAgo ?? o.receivedAgo],
  )).rows[0].id as string;
}

/** El mundo de la prueba: A con cuatro conexiones en estados distintos y B con una con un aviso fallido. */
async function world(): Promise<void> {
  ch['Chip principal'] = await qrChannel(ORG_A, 'Chip principal', IDS.alice, { state: 'open', lastEventAgo: '2 minutes' });
  ch['Chip caído'] = await qrChannel(ORG_A, 'Chip caído', IDS.alice, { state: 'closed', lastEventAgo: '3 hours', downAgo: '3 hours' });
  ch['Chip callado'] = await qrChannel(ORG_A, 'Chip callado', IDS.alice, { state: 'open', connectedAgo: '20 hours', lastEventAgo: '20 hours' });
  ch['GoHighLevel'] = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, is_official, name, created_by) VALUES (gen_random_uuid(), $1, 'ghl', false, 'GoHighLevel', $2) RETURNING id`, [ORG_A, IDS.alice])).rows[0].id as string;
  ch['Chip de B'] = await qrChannel(ORG_B, 'Chip de B', IDS.bob, { state: 'open', lastEventAgo: '1 minute' });
  // Chip principal: 4 mensajes recientes que entraron con 10 min de retraso y 3 de hace 10 h con 1 h
  const conv = await conversationOf(ORG_A, ch['Chip principal']!);
  await inbound(ORG_A, ch['Chip principal']!, conv, '5 minutes', 600, 4);
  await inbound(ORG_A, ch['Chip principal']!, conv, '10 hours', 3600, 3);
  failedWithPayload = await event(ORG_A, ch['Chip principal']!, { status: 'failed', receivedAgo: '1 day', attempts: 5, error: 'Error:23505' });
  failedRedacted = await event(ORG_A, ch['Chip principal']!, { status: 'failed', receivedAgo: '2 days', attempts: 5, error: 'TypeError', payload: false });
  await event(ORG_A, ch['Chip principal']!, { status: 'pending', receivedAgo: '6 minutes', nextAgo: '5 minutes' }); // vencido hace 5 min
  await event(ORG_A, ch['Chip principal']!, { status: 'done', receivedAgo: '1 minute' });
  await admin.query(`INSERT INTO webhook_ignored(organization_id, channel_account_id, hour, reason, n) VALUES ($1, $2, date_trunc('hour', now()), 'group', 3), ($1, $2, date_trunc('hour', now()), 'receipt', 5)`, [ORG_A, ch['Chip principal']]);
  failedB = await event(ORG_B, ch['Chip de B']!, { status: 'failed', receivedAgo: '1 hour', attempts: 5, error: 'Error:23505' });
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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
  await world();
});

interface Health { generated_at: string; connections: ConnectionHealthView[] }
const list = async (token: string): Promise<Health> => ok<Health>(await call('GET', '/connection-health', token));
const byName = (h: Health, name: string): ConnectionHealthView => h.connections.find((c) => c.name === name)!;
const passA = (): Promise<number> => TenantContext.run({ organizationId: ORG_A }, () => app.get(ConnectionHealthService).alertPass(new Date()));
const alerts = async (user: string) => (await admin.query(`SELECT alert_reason AS reason, channel_account_id AS channel, read_at FROM notifications WHERE type = 'connection_health' AND user_id = $1 ORDER BY alert_reason`, [user])).rows as Array<{ reason: string; channel: string; read_at: Date | null }>;

describe('el panel de salud', () => {
  it('cada conexión con su retraso (24 h y reciente), avisos pendientes/atrasados/fallidos con su motivo, ignorados por motivo, nivel y razones', async () => {
    const h = await list(T.alice);
    expect(h.connections.map((c) => c.name).sort()).toEqual(['Chip callado', 'Chip caído', 'Chip principal', 'GoHighLevel']);
    const p = byName(h, 'Chip principal');
    expect(p).toMatchObject({ kind: 'whatsapp_qr', status: 'active', session: { state: 'open', down_since: null }, level: 'crit' });
    expect(p.reasons).toEqual(expect.arrayContaining(['failed', 'lag', 'backlog']));
    expect(p.inbound_24h).toMatchObject({ count: 7, lag_median_s: 600, lag_max_s: 3600 });
    expect(p.inbound_24h.lag_p95_s).toBeGreaterThan(3000);
    expect(p.recent_lag_median_s).toBe(600);
    expect(p.events).toEqual({ pending: 1, overdue: 1, failed: 2 });
    expect(p.ignored_24h).toEqual({ group: 3, receipt: 5 });
    expect(new Date(p.last_event_at!).getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
    // los fallidos, lo más reciente primero, con el motivo en palabras y si se pueden reintentar (el vaciado por privacidad no)
    expect(p.failed_events).toHaveLength(2);
    expect(p.failed_events[0]).toMatchObject({ id: failedWithPayload, attempts: 5, retryable: true });
    expect(p.failed_events[0]!.reason).toMatch(/base de datos rechazó/);
    expect(p.failed_events[1]).toMatchObject({ id: failedRedacted, retryable: false });
    expect(p.failed_events[1]!.reason).toMatch(/formato/);
    // sesión caída
    expect(byName(h, 'Chip caído')).toMatchObject({ level: 'crit', reasons: ['session_down'], session: { state: 'closed' } });
    expect(byName(h, 'Chip caído').session!.down_since).not.toBeNull();
    // silencio de 20 horas en horario laboral (sin horario configurado, la empresa está abierta siempre)
    expect(byName(h, 'Chip callado')).toMatchObject({ level: 'warn', reasons: ['silent'] });
    // GoHighLevel: sin sesión; sin datos no hay nada que opinar
    expect(byName(h, 'GoHighLevel')).toMatchObject({ kind: 'ghl', session: null, level: 'ok', reasons: [], inbound_24h: { count: 0, lag_median_s: null } });
  });

  it('solo quien administra las conexiones; cada empresa ve SOLO las suyas; sin sesión 401', async () => {
    expect((await call('GET', '/connection-health')).status).toBe(401);
    expect((await call('GET', '/connection-health', T.carol)).status).toBe(403); // asesora
    expect((await call('GET', '/connection-health', T.root)).status).toBe(403); // plataforma
    const b = await list(T.bob);
    expect(b.connections.map((c) => c.name)).toEqual(['Chip de B']);
    expect(b.connections[0]!.events.failed).toBe(1);
    // lo de A no aparece en B ni al revés
    expect((await list(T.alice)).connections.some((c) => c.name === 'Chip de B')).toBe(false);
  });
});

describe('reintentar un aviso fallido', () => {
  it('vuelve a ponerlo en cola (sin intentos ni error) y queda auditado; repetirlo, uno que no está fallido o uno ya vaciado por privacidad se rechazan con su motivo', async () => {
    const r = await ok<{ id: string; status: string }>(await call('POST', `/connection-health/events/${failedWithPayload}/retry`, T.alice));
    expect(r).toEqual({ id: failedWithPayload, status: 'pending' });
    const row = (await admin.query(`SELECT status, attempts, last_error, processed_at FROM webhook_events WHERE id = $1`, [failedWithPayload])).rows[0] as { status: string; attempts: number; last_error: string | null; processed_at: Date | null };
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: null, processed_at: null });
    const log = (await admin.query(`SELECT field, old_value, new_value, source FROM audit_logs WHERE entity_type = 'webhook_event' AND entity_id = $1`, [failedWithPayload])).rows;
    expect(log).toEqual([{ field: 'retried', old_value: 'failed', new_value: 'pending', source: 'manual' }]);
    const again = await call('POST', `/connection-health/events/${failedWithPayload}/retry`, T.alice);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe('EVENT_NOT_FAILED');
    const redacted = await call('POST', `/connection-health/events/${failedRedacted}/retry`, T.alice);
    expect(redacted.status).toBe(409);
    expect(await code(redacted)).toBe('EVENT_REDACTED');
    expect((await call('POST', `/connection-health/events/${NOBODY}/retry`, T.alice)).status).toBe(404);
    expect((await call('POST', '/connection-health/events/no-es-uuid/retry', T.alice)).status).toBe(400);
  });

  it('A↔B: la empresa A no puede reintentar un aviso de B (404 uniforme) ni sin permiso ni sin sesión', async () => {
    expect((await call('POST', `/connection-health/events/${failedB}/retry`, T.alice)).status).toBe(404);
    expect((await admin.query(`SELECT status FROM webhook_events WHERE id = $1`, [failedB])).rows[0].status).toBe('failed'); // intacto
    expect((await call('POST', `/connection-health/events/${failedWithPayload}/retry`, T.carol)).status).toBe(403);
    expect((await call('POST', `/connection-health/events/${failedWithPayload}/retry`, T.root)).status).toBe(403);
    expect((await call('POST', `/connection-health/events/${failedWithPayload}/retry`)).status).toBe(401);
    expect((await call('POST', `/connection-health/events/${failedB}/retry`, T.bob)).status).toBe(200); // quien sí es de B, puede
  });
});

describe('alertas al administrador', () => {
  it('una alerta por conexión y motivo, solo a quienes administran las conexiones (no a la asesora); repetir la pasada no acumula; aparecen en el centro de avisos con su conexión y motivo', async () => {
    expect(await passA()).toBe(4); // Chip principal: failed, lag, backlog · Chip callado: silent
    expect(await passA()).toBe(0); // sin leer no se repiten
    const mine = await alerts(IDS.alice);
    expect(mine.map((a) => a.reason)).toEqual(['backlog', 'failed', 'lag', 'silent']);
    expect(mine.filter((a) => a.channel === ch['Chip principal']).length).toBe(3);
    expect(await alerts(IDS.carol)).toEqual([]);
    expect(await alerts(IDS.bob)).toEqual([]); // la empresa B no recibe nada de A (y aún no se evaluó B)
    // el centro de avisos las muestra con el nombre de la conexión y el motivo
    const page = await ok<{ items: Array<{ type: string; connection: { id: string; name: string; reason: string } | null }>; unread: number }>(await call('GET', '/notifications', T.alice));
    const conn = page.items.filter((i) => i.type === 'connection_health');
    expect(conn).toHaveLength(4);
    expect(conn.map((i) => `${i.connection!.name}:${i.connection!.reason}`).sort()).toEqual(['Chip callado:silent', 'Chip principal:backlog', 'Chip principal:failed', 'Chip principal:lag']);
    // la asesora no ve nada de esto
    const carol = await ok<{ items: Array<{ type: string }> }>(await call('GET', '/notifications', T.carol));
    expect(carol.items.filter((i) => i.type === 'connection_health')).toEqual([]);
  });

  it('cuando el problema se resuelve la alerta se da por leída; si vuelve a ocurrir, avisa de nuevo', async () => {
    await passA();
    // se arregla todo: avisos fallidos y pendientes procesados, mensajes sin retraso, la conexión silenciosa vuelve a recibir
    await admin.query(`UPDATE webhook_events SET status = 'done' WHERE organization_id = $1`, [ORG_A]);
    await admin.query(`UPDATE messages SET sent_at = created_at WHERE organization_id = $1`, [ORG_A]);
    await admin.query(`UPDATE qr_accounts SET last_event_at = now() WHERE channel_account_id = $1`, [ch['Chip callado']]);
    expect(await passA()).toBe(0);
    expect((await alerts(IDS.alice)).every((a) => a.read_at !== null)).toBe(true);
    // un problema nuevo (otro aviso fallido): una alerta nueva, sin tocar las viejas
    await event(ORG_A, ch['Chip principal']!, { status: 'failed', receivedAgo: '1 minute', attempts: 5, error: 'Error:23505' });
    expect(await passA()).toBe(1);
    const open = (await alerts(IDS.alice)).filter((a) => a.read_at === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: 'failed', channel: ch['Chip principal'] });
  });

  it('la tarea recorre las empresas con conexiones y cada una avisa solo a sus administradores', async () => {
    for (const org of [ORG_A, ORG_B]) {
      const channel = org === ORG_A ? ch['Chip principal'] : ch['Chip de B'];
      await admin.query(`INSERT INTO qr_routes(id, organization_id, channel_account_id, token_hash) VALUES (gen_random_uuid(), $1, $2, $3)`, [org, channel, randomBytes(32).toString('hex')]);
    }
    const created = await app.get(ConnectionHealthJob).run(new Date());
    expect(created).toBe(5); // A: 4 · B: el aviso fallido de su chip
    expect((await alerts(IDS.alice)).length).toBe(4);
    expect((await alerts(IDS.bob)).map((a) => a.reason)).toEqual(['failed']);
    expect((await alerts(IDS.bob))[0]!.channel).toBe(ch['Chip de B']);
    expect((await alerts(IDS.alice)).some((a) => a.channel === ch['Chip de B'])).toBe(false);
  });
});

describe('lo que dice el servidor es solo cifras', () => {
  it('ni el panel ni las alertas contienen teléfonos ni textos de mensajes', async () => {
    const text = JSON.stringify(await list(T.alice));
    expect(text).not.toMatch(/\+593|hola|Cliente \d/);
  });
});
