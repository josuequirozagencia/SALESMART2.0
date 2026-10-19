// M5.5b — SLA, horario laboral, feriados y reasignación por falta de respuesta (ADR-07/50; F08, F09). Rutas cubiertas (el registro de endpoints exige que este archivo escriba
// cada una tal cual):
//   GET /v1/sla
//   PUT /v1/sla/policy
//   PUT /v1/sla/hours
//   POST /v1/sla/holidays
//   DELETE /v1/sla/holidays/:id
//   PUT /v1/queues/:id/hours
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule, type TenantTx } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { ConversationsService, type NormalizedMessage } from '../../src/modules/conversations';
import { InboxModule, ReassignService, SlaSweepJob } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { SlaService } from '../../src/modules/sla';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, OpportunitiesModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia, con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);
const TZ = 'America/Guayaquil';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob' | 'dave' | 'root', string>;
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
  await admin.query('TRUNCATE response_timers, sla_policies, business_hours, holidays, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, stage_history, opportunities, pipeline_stages, pipelines, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma', 'UTC'], [ORG_A, 'client', 'Barbería Norte', TZ], [ORG_B, 'client', 'Estudio Luna', 'UTC'], [AG1, 'agency', 'Agencia Uno', 'UTC']];
  for (const [id, kind, name, tz] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, tz]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.eve, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
  for (const [u, o, r, lv] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, lv]);
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
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
async function connect(token: string, phoneId: string, name: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

type Week = Record<string, Array<[string, string]>>;
interface Settings { policy: { target_minutes: number; risk_minutes: number }; hours: Week | null; holidays: Array<{ id: string; date: string; name: string; yearly: boolean }>; time_zone: string; open_now: boolean }
interface Queue { id: string; name: string; respect_hours: boolean; reassign_minutes: number; max_rotations: number; hours: Week | null; open_now: boolean }
interface Sla { kind: 'first' | 'followup'; state: 'ok' | 'risk' | 'late' | 'paused' | 'done'; started_at: string; due_at: string | null; response_seconds: number | null }
interface Conv { id: string; status: string; owner: { id: string; name: string } | null; sla: Sla | null }
interface List { items: Conv[]; counts: { working: number; pending: number; closed: number; unread: number } | null }
interface Msg { id: string }
interface TimerRow { kind: string; owner_id: string; started_at: Date; due_at: Date; reassign_at: Date | null; stopped_at: Date | null; stop_reason: string | null; response_seconds: number | null; replied_message_id: string | null }

// ── horarios ─────────────────────────────────────────────────────────────────
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const FULL: Array<[string, string]> = [['00:00', '24:00']];
/** Abierta las 24 horas, todos los días. */
const allDay = (): Week => Object.fromEntries(DAYS.map((d) => [d, FULL]));
/** Día de la semana de HOY en la zona de la empresa (Guayaquil no tiene horario de verano: UTC−5 todo el año). */
const localDow = (): number => new Date(Date.now() - 5 * HOUR).getUTCDay();
/** Abierta todos los días MENOS hoy: «ahora» la empresa está cerrada. */
const closedToday = (): Week => Object.fromEntries(DAYS.filter((_, i) => i !== localDow()).map((d) => [d, FULL]));
/** Lunes a sábado de 08:30 a 18:00 (el horario de una barbería). */
const barber = (): Week => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['08:30', '18:00']]]));

/** Lo que devuelve la API: siempre los siete días, con los cerrados vacíos. */
const full = (w: Week): Week => Object.fromEntries(DAYS.map((d) => [d, w[d] ?? []]));
const putHours = (token: string, days: Week | null) => call('PUT', '/sla/hours', token, { days });
const getSla = async (token = T.alice): Promise<Settings> => ok<Settings>(await call('GET', '/sla', token));

// ── colas ────────────────────────────────────────────────────────────────────
const mkQueue = async (name = 'Ventas'): Promise<Queue> => ok<Queue>(await call('POST', '/queues', T.alice, { name }), 201);
const patchQueue = async (id: string, body: Record<string, unknown>): Promise<Queue> => ok<Queue>(await call('PATCH', `/queues/${id}`, T.alice, body));
/** Una cola de A con reparto encendido, sus asesores y la conexión de A apuntando a ella. */
async function readyQueue(over: Record<string, unknown> = {}, who: Array<[string, boolean, number]> = [[IDS.alice, true, 1], [IDS.carol, true, 1], [IDS.eve, true, 1]]): Promise<string> {
  const q = await mkQueue();
  await patchQueue(q.id, { distribution_on: true, ...over });
  await ok(await call('PUT', `/queues/${q.id}/members`, T.alice, { members: who.map(([user_id, active, weight]) => ({ user_id, active, weight })) }));
  await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: q.id }));
  return q.id;
}

// ── conversaciones ───────────────────────────────────────────────────────────
let seq = 0;
interface Mk { owner?: string | null; status?: string; queue?: string | null; source?: 'distribution' | 'manual'; org?: string }
async function mkConv(o: Mk = {}): Promise<{ id: string; contact: string; message: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const channel = org === ORG_B ? channelB : channelA;
  const owner = o.owner ?? null;
  const status = o.status ?? (owner ? 'pending' : 'unassigned');
  const phone = `+59398600${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const id = (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, queue_id, last_message_at, last_inbound_at, unread_count, peer_id, assignment_source)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11) RETURNING id`,
      [org, contact, channel, status, owner, owner ? new Date() : null, o.queue ?? null, ago(30 * MIN), ago(HOUR), phone.slice(1), o.source ?? 'distribution'],
    )
  ).rows[0].id as string;
  const message = (
    await admin.query(
      `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', 'text', 'Hola', 'received', $5) RETURNING id`,
      [org, id, channel, `wamid.SEED${seq}`, ago(40 * MIN)],
    )
  ).rows[0].id as string;
  return { id, contact, message };
}
/** Un cronómetro ya armado (sin pasar por el servicio): para probar estados y filtros con fechas exactas. */
async function mkTimer(conv: string, owner: string, o: { due: Date; kind?: 'first' | 'followup'; started?: Date; reassign?: Date | null; org?: string }): Promise<void> {
  await admin.query(`INSERT INTO response_timers(id, organization_id, conversation_id, kind, owner_id, started_at, due_at, reassign_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`, [o.org ?? ORG_A, conv, o.kind ?? 'first', owner, o.started ?? ago(5 * MIN), o.due, o.reassign ?? null]);
}
const timers = async (conv: string): Promise<TimerRow[]> =>
  (await admin.query(`SELECT kind, owner_id, started_at, due_at, reassign_at, stopped_at, stop_reason, response_seconds, replied_message_id FROM response_timers WHERE conversation_id = $1 ORDER BY started_at, id`, [conv])).rows as TimerRow[];
const openTimer = async (conv: string): Promise<TimerRow | undefined> => (await timers(conv)).find((t) => t.stopped_at === null);
interface ConvRow { status: string; owner_id: string | null; queue_id: string | null; assigned_at: Date | null; assignment_source: string; rotations: number; tried_owners: string[]; contact_id: string }
const convRow = async (id: string): Promise<ConvRow> => (await admin.query('SELECT * FROM conversations WHERE id = $1', [id])).rows[0] as ConvRow;
const onlyConv = async (): Promise<string> => (await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at, id`, [ORG_A])).rows[0].id as string;
const contactOwner = async (id: string): Promise<string | null> => (await admin.query('SELECT owner_id FROM contacts WHERE id = $1', [id])).rows[0].owner_id as string | null;
const noteTexts = async (conv: string): Promise<string[]> => (await admin.query(`SELECT body FROM messages WHERE conversation_id = $1 AND kind = 'note' ORDER BY sent_at, id`, [conv])).rows.map((r: { body: string }) => r.body);
const audits = async (entityId: string) => (await admin.query(`SELECT entity_type, field, old_value, new_value, source FROM audit_logs WHERE entity_id = $1 ORDER BY at, id`, [entityId])).rows as Array<{ entity_type: string; field: string | null; old_value: unknown; new_value: unknown; source: string }>;
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

const get = async (token: string, id: string): Promise<Conv> => ok<Conv>(await call('GET', `/conversations/${id}`, token));
const list = async (token: string, qs = ''): Promise<List> => ok<List>(await call('GET', `/conversations${qs}`, token));
const ids = (l: List): string[] => l.items.map((c) => c.id);
const reply = (token: string, conv: string, text: string) => call('POST', `/conversations/${conv}/messages`, token, { text });
const transfer = (token: string, id: string, body: unknown) => call('POST', `/conversations/${id}/transfer`, token, body);

const phone = (n: number): string => `+59398400${String(n).padStart(4, '0')}`;
const msg = (from: string, id: string): NormalizedMessage => ({ externalId: id, from, fromRaw: from.slice(1), profileName: null, kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date() });
/** Entra un mensaje de `from` por la conexión de A: exactamente lo que hace la tarea que procesa los avisos de Meta. */
async function ingest(from: string, id: string): Promise<void> {
  await TenantContext.run({ organizationId: ORG_A }, async () => {
    const dir = await app.get(OrgDirectoryService).current({ fresh: true });
    const ctx = { now: new Date(), timeZone: dir.timeZone, assignable: dir.assignable };
    await app.get(Database).withTenant((tx) => app.get(ConversationsService).ingestInbound(tx, channelA, msg(from, id), ctx));
  });
}
/** Lo mismo que hace la tarea del SLA para la empresa A, con el reloj adelantado `ahead` ms. Devuelve cuántas conversaciones tocó. */
async function sweep(ahead: number, what: 'due' | 'pickup' = 'due'): Promise<number> {
  const now = new Date(Date.now() + ahead);
  return TenantContext.run({ organizationId: ORG_A }, async () => {
    const dir = await app.get(OrgDirectoryService).current({ fresh: true });
    return what === 'due' ? app.get(ReassignService).runDue(now, dir) : app.get(ReassignService).runPickup(now, dir);
  });
}
const inTx = <R,>(fn: (tx: TenantTx) => Promise<R>): Promise<R> => TenantContext.run({ organizationId: ORG_A }, () => app.get(Database).withTenant(fn));
const asLocal = (s: string): Date => new Date(`${s}-05:00`); // hora de Guayaquil

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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte');
  fake().outbox.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('configuración: permisos y aislamiento', () => {
  it('sin sesión 401; la plataforma 403; el asesor 403; la agencia con nivel «lectura» 403 (la de nivel «administrador» sí configura)', async () => {
    const q = await mkQueue();
    const routes: Array<[string, string, unknown?]> = [['GET', '/sla'], ['PUT', '/sla/policy', { target_minutes: 20, risk_minutes: 5 }], ['PUT', '/sla/hours', { days: null }], ['POST', '/sla/holidays', { date: '2026-12-25', name: 'Navidad' }], ['DELETE', `/sla/holidays/${NOBODY}`], ['PUT', `/queues/${q.id}/hours`, { days: null }]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
    await ok(await call('POST', '/context/switch', T.dave, { target: ORG_A }));
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    for (const [m, p, b] of routes) expect((await call(m, p, T.dave, b)).status, `${m} ${p} lectura`).toBe(403);
    await admin.query(`UPDATE organization_members SET access_level = 'admin' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await call('GET', '/sla', T.dave)).status).toBe(200);
    expect((await admin.query('SELECT count(*)::int AS n FROM sla_policies')).rows[0].n).toBe(0);
  });

  it('A↔B: cada empresa ve y cambia solo lo suyo; el feriado y la cola de otra empresa responden 404', async () => {
    await ok(await call('PUT', '/sla/policy', T.alice, { target_minutes: 30, risk_minutes: 10 }));
    await ok(await putHours(T.alice, barber()));
    const h = await ok<{ id: string }>(await call('POST', '/sla/holidays', T.alice, { date: '2026-12-25', name: 'Navidad' }), 201);
    const q = await mkQueue();
    // B parte de cero: no ve nada de A
    const b = await getSla(T.bob);
    expect(b).toMatchObject({ policy: { target_minutes: 15, risk_minutes: 3 }, hours: null, holidays: [], time_zone: 'UTC', open_now: true });
    expect((await call('DELETE', `/sla/holidays/${h.id}`, T.bob)).status).toBe(404);
    expect((await call('PUT', `/queues/${q.id}/hours`, T.bob, { days: barber() })).status).toBe(404);
    // lo de B no toca lo de A
    await ok(await call('PUT', '/sla/policy', T.bob, { target_minutes: 5, risk_minutes: 1 }));
    await ok(await putHours(T.bob, allDay()));
    await ok(await call('POST', '/sla/holidays', T.bob, { date: '2026-12-25', name: 'Navidad de B' }), 201); // misma fecha: no choca con la de A
    const a = await getSla(T.alice);
    expect(a.policy).toEqual({ target_minutes: 30, risk_minutes: 10 });
    expect(a.hours).toEqual(full(barber()));
    expect(a.holidays.map((x) => x.name)).toEqual(['Navidad']);
    expect((await call('DELETE', `/sla/holidays/${h.id}`, T.alice)).status).toBe(200);
    expect((await getSla(T.bob)).holidays.map((x) => x.name)).toEqual(['Navidad de B']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('configuración: política, horario y feriados', () => {
  it('sin nada guardado rigen 15 min de objetivo y 3 de aviso, abierta siempre; guardar la política la cambia, se audita y repetirla no deja rastro', async () => {
    expect(await getSla()).toMatchObject({ policy: { target_minutes: 15, risk_minutes: 3 }, hours: null, holidays: [], time_zone: TZ, open_now: true });
    const s = await ok<Settings>(await call('PUT', '/sla/policy', T.alice, { target_minutes: 20, risk_minutes: 5 }));
    expect(s.policy).toEqual({ target_minutes: 20, risk_minutes: 5 });
    expect((await getSla()).policy).toEqual({ target_minutes: 20, risk_minutes: 5 });
    await ok(await call('PUT', '/sla/policy', T.alice, { target_minutes: 20, risk_minutes: 5 })); // igual: no cambia nada
    await ok(await call('PUT', '/sla/policy', T.alice, { target_minutes: 25, risk_minutes: 0 }));
    const id = (await admin.query(`SELECT id FROM sla_policies`)).rows[0].id as string;
    expect((await admin.query('SELECT count(*)::int AS n FROM sla_policies')).rows[0].n).toBe(1);
    const a = await audits(id);
    expect(a.map((x) => [x.entity_type, x.old_value, x.new_value, x.source])).toEqual([
      ['sla_policy', null, { target_minutes: 20, risk_minutes: 5 }, 'manual'],
      ['sla_policy', { target_minutes: 20, risk_minutes: 5 }, { target_minutes: 25, risk_minutes: 0 }, 'manual'],
    ]);
  });

  it('valida la política: objetivo de 1 a 1440, aviso de 0 hasta el objetivo, enteros y sin campos de más', async () => {
    const bad = async (b: unknown, label: string) => expect((await call('PUT', '/sla/policy', T.alice, b)).status, label).toBe(400);
    await bad({ target_minutes: 0, risk_minutes: 0 }, 'objetivo 0');
    await bad({ target_minutes: 1441, risk_minutes: 1 }, 'objetivo 1441');
    await bad({ target_minutes: 10, risk_minutes: 11 }, 'aviso mayor que el objetivo');
    await bad({ target_minutes: 10, risk_minutes: -1 }, 'aviso negativo');
    await bad({ target_minutes: 10.5, risk_minutes: 1 }, 'decimal');
    await bad({ target_minutes: 10 }, 'falta el aviso');
    await bad({ target_minutes: 10, risk_minutes: 1, otro: 1 }, 'campo de más');
    expect((await admin.query('SELECT count(*)::int AS n FROM sla_policies')).rows[0].n).toBe(0);
    await ok(await call('PUT', '/sla/policy', T.alice, { target_minutes: 1440, risk_minutes: 1440 }));
    await ok(await call('PUT', '/sla/policy', T.alice, { target_minutes: 1, risk_minutes: 0 }));
  });

  it('el horario semanal se guarda, se devuelve igual, se audita y se quita con `days: null` (la empresa vuelve a estar abierta siempre)', async () => {
    const s = await ok<Settings>(await putHours(T.alice, barber()));
    expect(s.hours).toEqual(full(barber()));
    // varios tramos en un día y un día con tramo hasta las 24:00
    const split = { mon: [['08:00', '12:00'], ['14:00', '18:00']], tue: [['00:00', '24:00']] } as Week;
    expect((await ok<Settings>(await putHours(T.alice, split))).hours).toEqual({ mon: split['mon'], tue: split['tue'], wed: [], thu: [], fri: [], sat: [], sun: [] });
    await ok(await putHours(T.alice, split)); // igual: sin cambios
    const cleared = await ok<Settings>(await putHours(T.alice, null));
    expect(cleared).toMatchObject({ hours: null, open_now: true });
    await ok(await putHours(T.alice, null)); // ya estaba así
    expect((await admin.query(`SELECT count(*)::int AS n FROM business_hours`)).rows[0].n).toBe(0);
    const a = (await admin.query(`SELECT entity_type, old_value, new_value FROM audit_logs WHERE entity_type = 'business_hours' ORDER BY at, id`)).rows as Array<{ old_value: { scope: string } | null; new_value: { scope: string } | null }>;
    expect(a.map((x) => [x.old_value === null, x.new_value === null])).toEqual([[true, false], [false, false], [false, true]]);
  });

  it('rechaza horarios inválidos con el día que falla: más de 3 tramos, desordenados o solapados, horas imposibles, fin antes del inicio, semana sin ningún día abierto', async () => {
    const bad = async (days: unknown, path: string) => {
      const r = await call('PUT', '/sla/hours', T.alice, { days });
      expect(r.status, JSON.stringify(days)).toBe(400);
      const d = (await json<{ error: { details: Array<{ path: string }> } }>(r)).error.details[0]!;
      expect(d.path.startsWith(path), `${d.path} debería empezar por ${path}`).toBe(true);
    };
    await bad({ mon: [['08:00', '09:00'], ['10:00', '11:00'], ['12:00', '13:00'], ['14:00', '15:00']] }, 'days');
    await bad({ mon: [['10:00', '12:00'], ['08:00', '09:00']] }, 'days.mon');
    await bad({ tue: [['08:00', '12:00'], ['11:00', '13:00']] }, 'days.tue');
    await bad({ wed: [['25:00', '26:00']] }, 'days.wed');
    await bad({ thu: [['12:00', '08:00']] }, 'days.thu');
    await bad({ fri: [['08:00', '08:00']] }, 'days.fri');
    await bad({ sat: [['24:00', '24:00']] }, 'days.sat');
    await bad({ sun: [['8', '9']] }, 'days.sun');
    await bad({ mon: [] }, 'days'); // ningún día abierto: para «abierta siempre» se quita el horario
    await bad({}, 'days');
    expect((await call('PUT', '/sla/hours', T.alice, { days: { mon: [['08:00', '09:00']], lun: [] } })).status).toBe(400); // día que no existe
    expect((await call('PUT', '/sla/hours', T.alice, { days: allDay(), otro: 1 })).status).toBe(400);
    expect((await call('PUT', '/sla/hours', T.alice, {})).status).toBe(400);
    expect((await getSla()).hours).toBeNull();
    // «24:00» solo vale como final
    expect((await putHours(T.alice, { mon: [['00:00', '24:00']] })).status).toBe(200);
  });

  it('«abierta ahora» sigue el horario y los feriados de la empresa', async () => {
    await ok(await putHours(T.alice, allDay()));
    expect((await getSla()).open_now).toBe(true);
    await ok(await putHours(T.alice, closedToday()));
    expect((await getSla()).open_now).toBe(false);
    await ok(await putHours(T.alice, allDay()));
    const today = new Date(Date.now() - 5 * HOUR).toISOString().slice(0, 10);
    await ok(await call('POST', '/sla/holidays', T.alice, { date: today, name: 'Hoy cerramos' }), 201);
    expect((await getSla()).open_now).toBe(false);
    // un feriado anual cuenta cada año en la misma fecha
    const h = (await getSla()).holidays[0]!;
    await ok(await call('DELETE', `/sla/holidays/${h.id}`, T.alice));
    expect((await getSla()).open_now).toBe(true);
    await ok(await call('POST', '/sla/holidays', T.alice, { date: `2001-${today.slice(5)}`, name: 'Cada año', yearly: true }), 201);
    expect((await getSla()).open_now).toBe(false);
  });

  it('feriados: se agregan y se listan por fecha; la misma fecha dos veces es 409; quitarlo es borrado lógico y la fecha se puede volver a usar; fechas inválidas son 400; tope de 200', async () => {
    const h1 = await ok<{ id: string; date: string; name: string; yearly: boolean }>(await call('POST', '/sla/holidays', T.alice, { date: '2026-12-25', name: '  Navidad ' }), 201);
    expect(h1).toMatchObject({ date: '2026-12-25', name: 'Navidad', yearly: false });
    await ok(await call('POST', '/sla/holidays', T.alice, { date: '2026-01-01', name: 'Año Nuevo', yearly: true }), 201);
    expect((await getSla()).holidays.map((h) => [h.date, h.name, h.yearly])).toEqual([['2026-01-01', 'Año Nuevo', true], ['2026-12-25', 'Navidad', false]]);
    const dup = await call('POST', '/sla/holidays', T.alice, { date: '2026-12-25', name: 'Otra' });
    expect([dup.status, await code(dup)]).toEqual([409, 'HOLIDAY_EXISTS']);
    for (const b of [{ date: '2026-02-30', name: 'x' }, { date: '25/12/2026', name: 'x' }, { date: '1999-12-25', name: 'x' }, { date: '2026-12-25', name: '' }, { date: '2026-12-26', name: 'x'.repeat(81) }, { date: '2026-12-26', name: 'a\u0007b' }, { date: '2026-12-26' }, { date: '2026-12-26', name: 'x', otro: 1 }]) {
      expect((await call('POST', '/sla/holidays', T.alice, b)).status, JSON.stringify(b)).toBe(400);
    }
    // quitar: 200, repetirlo 404 (ya no está), y la fecha queda libre; la fila sigue en la base con su marca de borrado
    await ok(await call('DELETE', `/sla/holidays/${h1.id}`, T.alice));
    expect((await call('DELETE', `/sla/holidays/${h1.id}`, T.alice)).status).toBe(404);
    expect((await call('DELETE', '/sla/holidays/no-es-uuid', T.alice)).status).toBe(400);
    expect((await admin.query(`SELECT deleted_at FROM holidays WHERE id = $1`, [h1.id])).rows[0].deleted_at).not.toBeNull();
    await ok(await call('POST', '/sla/holidays', T.alice, { date: '2026-12-25', name: 'Navidad otra vez' }), 201);
    expect((await audits(h1.id)).map((x) => [x.entity_type, x.old_value === null, x.new_value === null])).toEqual([['holiday', true, false], ['holiday', false, true]]);
    // tope: 200 vigentes
    await admin.query(`INSERT INTO holidays(id, organization_id, day, name) SELECT gen_random_uuid(), $1, DATE '2030-01-01' + g, 'f' || g FROM generate_series(0, 197) g`, [ORG_A]);
    expect((await getSla()).holidays).toHaveLength(200);
    const over = await call('POST', '/sla/holidays', T.alice, { date: '2035-05-05', name: 'Uno más' });
    expect([over.status, await code(over)]).toEqual([409, 'HOLIDAY_LIMIT']);
  });

  it('cola: horario propio (lo ve en la lista con «abierta ahora»), volver al de la empresa con `days: null`, 404 si no existe; y los campos de reasignación se validan', async () => {
    const q = await mkQueue();
    expect(q).toMatchObject({ respect_hours: false, reassign_minutes: 0, max_rotations: 3, hours: null, open_now: true });
    const r = await ok<Queue>(await call('PUT', `/queues/${q.id}/hours`, T.alice, { days: closedToday() }));
    expect(r.hours).toEqual(full(closedToday()));
    expect(r.open_now).toBe(false);
    expect((await ok<{ items: Queue[] }>(await call('GET', '/queues', T.alice))).items[0]).toMatchObject({ hours: full(closedToday()), open_now: false });
    expect((await getSla()).hours).toBeNull(); // el horario de la empresa no cambió
    const back = await ok<Queue>(await call('PUT', `/queues/${q.id}/hours`, T.alice, { days: null }));
    expect(back).toMatchObject({ hours: null, open_now: true });
    expect((await call('PUT', `/queues/${q.id}/hours`, T.alice, { days: { mon: [] } })).status).toBe(400);
    expect((await call('PUT', `/queues/${NOBODY}/hours`, T.alice, { days: null })).status).toBe(404);
    expect((await call('PUT', '/queues/no-es-uuid/hours', T.alice, { days: null })).status).toBe(400);
    const p = await patchQueue(q.id, { respect_hours: true, reassign_minutes: 10, max_rotations: 2 });
    expect(p).toMatchObject({ respect_hours: true, reassign_minutes: 10, max_rotations: 2 });
    for (const b of [{ reassign_minutes: -1 }, { reassign_minutes: 1441 }, { reassign_minutes: 1.5 }, { max_rotations: 0 }, { max_rotations: 11 }, { respect_hours: 'si' }]) {
      expect((await call('PATCH', `/queues/${q.id}`, T.alice, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await audits(q.id)).map((a) => a.field)).toEqual(expect.arrayContaining(['respect_hours', 'reassign_minutes', 'max_rotations']));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('cronómetros de respuesta', () => {
  it('al repartir una conversación corre la primera respuesta: vence a los 15 min (por omisión), sin reasignación si la cola no la pide; la política de la empresa manda', async () => {
    await readyQueue();
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    const [t] = await timers(id);
    expect(t).toMatchObject({ kind: 'first', owner_id: IDS.alice, stopped_at: null, reassign_at: null });
    expect(t!.due_at.getTime() - t!.started_at.getTime()).toBe(15 * MIN);
    const v = await get(T.alice, id);
    expect(v.sla).toMatchObject({ kind: 'first', state: 'ok', response_seconds: null });
    expect(v.sla!.due_at).toBe(t!.due_at.toISOString());
    // con otra política, el siguiente cronómetro usa el objetivo nuevo
    await ok(await call('PUT', '/sla/policy', T.alice, { target_minutes: 40, risk_minutes: 5 }));
    await ingest(phone(2), 'wamid.2');
    const second = (await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [ORG_A])).rows[0].id as string;
    const [t2] = await timers(second);
    expect(t2!.due_at.getTime() - t2!.started_at.getTime()).toBe(40 * MIN);
    // si la cola reasigna, el cronómetro también sabe cuándo toca
    const q = (await ok<{ items: Queue[] }>(await call('GET', '/queues', T.alice))).items[0]!;
    await patchQueue(q.id, { reassign_minutes: 10 });
    await ingest(phone(3), 'wamid.3');
    const third = (await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [ORG_A])).rows[0].id as string;
    const [t3] = await timers(third);
    expect(t3!.reassign_at!.getTime() - t3!.started_at.getTime()).toBe(10 * MIN);
  });

  it('una conversación sin asignar no tiene cronómetro; al tomarla corre desde ese momento; un asesor que no ve todo no puede tomarla', async () => {
    const q = await mkQueue();
    const c = await mkConv({ queue: q.id });
    expect(await timers(c.id)).toEqual([]);
    expect((await get(T.alice, c.id)).sla).toBeNull();
    expect((await call('POST', `/conversations/${c.id}/take`, T.carol)).status).toBe(403); // tomar es de quien ve todo
    const v = await ok<Conv>(await call('POST', `/conversations/${c.id}/take`, T.alice));
    expect(v.sla).toMatchObject({ kind: 'first', state: 'ok' });
    const [t] = await timers(c.id);
    expect(t).toMatchObject({ kind: 'first', owner_id: IDS.alice, stopped_at: null });
    await ok(await call('POST', `/conversations/${c.id}/take`, T.alice)); // repetir no abre otro
    expect(await timers(c.id)).toHaveLength(1);
  });

  it('estados: al día, en riesgo (dentro de la ventana de aviso), vencido y en pausa (fuera de horario); el filtro `sla` y los números del Inbox siguen el mismo criterio', async () => {
    const okC = await mkConv({ owner: IDS.alice });
    const riskC = await mkConv({ owner: IDS.alice });
    const lateC = await mkConv({ owner: IDS.alice });
    const noneC = await mkConv({ owner: IDS.alice });
    await mkTimer(okC.id, IDS.alice, { due: new Date(Date.now() + 10 * MIN) });
    await mkTimer(riskC.id, IDS.alice, { due: new Date(Date.now() + 2 * MIN) });
    await mkTimer(lateC.id, IDS.alice, { due: new Date(Date.now() - MIN) });
    expect((await get(T.alice, okC.id)).sla!.state).toBe('ok');
    expect((await get(T.alice, riskC.id)).sla!.state).toBe('risk');
    expect((await get(T.alice, lateC.id)).sla!.state).toBe('late');
    expect((await get(T.alice, noneC.id)).sla).toBeNull();
    const l = await list(T.alice, '?tab=pending');
    expect(Object.fromEntries(l.items.map((c) => [c.id, c.sla?.state ?? null]))).toEqual({ [okC.id]: 'ok', [riskC.id]: 'risk', [lateC.id]: 'late', [noneC.id]: null });
    // filtro: «ok» incluye lo que no tiene cronómetro; «late» y «risk» solo lo suyo
    expect(ids(await list(T.alice, '?tab=pending&sla=late')).sort()).toEqual([lateC.id]);
    expect(ids(await list(T.alice, '?tab=pending&sla=risk')).sort()).toEqual([riskC.id]);
    expect(ids(await list(T.alice, '?tab=pending&sla=ok')).sort()).toEqual([okC.id, noneC.id].sort());
    expect((await list(T.alice, '?tab=pending&sla=late')).counts!.pending).toBe(1);
    expect((await call('GET', '/conversations?sla=muy-tarde', T.alice)).status).toBe(400);
    // la ventana de aviso la fija la política: con 15 min de aviso, lo que vence en 10 ya está en riesgo
    await ok(await call('PUT', '/sla/policy', T.alice, { target_minutes: 60, risk_minutes: 15 }));
    expect((await get(T.alice, okC.id)).sla!.state).toBe('risk');
    // fuera de horario el reloj se detiene: lo que aún no venció queda «en pausa»; lo vencido sigue vencido
    await ok(await putHours(T.alice, closedToday()));
    expect((await get(T.alice, okC.id)).sla!.state).toBe('paused');
    expect((await get(T.alice, lateC.id)).sla!.state).toBe('late');
    // el asesor solo ve los cronómetros de lo suyo
    await admin.query(`UPDATE conversations SET owner_id = $1 WHERE id = $2`, [IDS.carol, okC.id]);
    expect(ids(await list(T.carol, '?tab=pending')).sort()).toEqual([okC.id]);
    expect((await get(T.carol, okC.id)).sla!.state).toBe('paused');
  });

  it('el primer mensaje HUMANO detiene el cronómetro y guarda cuánto tardó; una nota no lo detiene; el de un colaborador con permiso de responder, sí', async () => {
    await readyQueue();
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    await admin.query(`UPDATE response_timers SET started_at = now() - interval '10 minutes', due_at = now() + interval '5 minutes' WHERE conversation_id = $1`, [id]);
    // una nota interna no cuenta como respuesta al cliente
    await ok(await call('POST', `/conversations/${id}/notes`, T.alice, { text: 'Voy a llamarle' }), 201);
    expect((await openTimer(id))!.stop_reason).toBeNull();
    const sent = await ok<Msg>(await reply(T.alice, id, 'Hola, en qué te ayudo'), 201);
    const [t] = await timers(id);
    expect(t).toMatchObject({ stop_reason: 'human_reply', replied_message_id: sent.id });
    expect(t!.response_seconds).toBeGreaterThanOrEqual(600);
    expect(t!.response_seconds).toBeLessThan(620);
    expect(await openTimer(id)).toBeUndefined();
    const v = await get(T.alice, id);
    expect(v.sla).toMatchObject({ kind: 'first', state: 'done', due_at: null });
    expect(v.sla!.response_seconds).toBe(t!.response_seconds);
    // colaborador con permiso de responder: su mensaje detiene el cronómetro de una conversación en curso
    const c = await mkConv({ owner: IDS.carol, status: 'working' });
    await mkTimer(c.id, IDS.carol, { due: new Date(Date.now() + 10 * MIN), started: ago(4 * MIN) });
    await ok(await call('POST', `/conversations/${c.id}/share`, T.carol, { user_id: IDS.eve, permission: 'reply' }));
    expect((await openTimer(c.id))!.stop_reason).toBeNull(); // compartir no la detiene
    await ok(await reply(T.eve, c.id, 'Yo te ayudo'), 201);
    expect((await timers(c.id))[0]).toMatchObject({ stop_reason: 'human_reply', owner_id: IDS.carol });
  });

  it('respuestas posteriores: cuando el cliente vuelve a escribir corre otro cronómetro desde su mensaje; dos mensajes seguidos no abren dos; responder lo detiene', async () => {
    await readyQueue();
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    await ok(await reply(T.alice, id, 'Hola'), 201);
    expect(await openTimer(id)).toBeUndefined();
    await ingest(phone(1), 'wamid.2');
    const open = (await openTimer(id))!;
    expect(open).toMatchObject({ kind: 'followup', owner_id: IDS.alice, reassign_at: null });
    expect(open.due_at.getTime() - open.started_at.getTime()).toBe(15 * MIN);
    expect((await get(T.alice, id)).sla).toMatchObject({ kind: 'followup', state: 'ok' });
    await ingest(phone(1), 'wamid.3'); // otro mensaje con el cronómetro abierto: no abre otro
    expect((await timers(id)).filter((t) => t.stopped_at === null)).toHaveLength(1);
    await ok(await reply(T.alice, id, 'Claro, te cuento'), 201);
    const all = await timers(id);
    expect(all.map((t) => [t.kind, t.stop_reason])).toEqual([['first', 'human_reply'], ['followup', 'human_reply']]);
    // de nuevo «al día»: la última medición cerrada es la de primera respuesta
    expect((await get(T.alice, id)).sla).toMatchObject({ kind: 'first', state: 'done' });
  });

  it('finalizar detiene el cronómetro sin respuesta; finalizar otra vez no hace nada; transferir cierra el anterior y arranca el de quien la recibe', async () => {
    await readyQueue({ reassign_minutes: 10 });
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(2), 'wamid.2');
    const [a, b] = (await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at, id`, [ORG_A])).rows.map((r: { id: string }) => r.id) as [string, string];
    await ok(await call('POST', `/conversations/${a}/close`, T.alice));
    expect((await timers(a))[0]).toMatchObject({ stop_reason: 'closed', response_seconds: null });
    await ok(await call('POST', `/conversations/${a}/close`, T.alice));
    expect(await timers(a)).toHaveLength(1);
    expect((await get(T.alice, a)).sla).toBeNull(); // sin respuesta no hay nada que mostrar
    // transferir b (de carol a eve): el cronómetro de carol queda «transferido» y eve empieza el suyo
    expect((await convRow(b)).owner_id).toBe(IDS.carol);
    await ok(await transfer(T.alice, b, { to_user_id: IDS.eve }));
    const all = await timers(b);
    expect(all.map((t) => [t.owner_id, t.stop_reason])).toEqual([[IDS.carol, 'transferred'], [IDS.eve, null]]);
    expect(all[1]!.reassign_at).not.toBeNull();
    expect(all[1]!.started_at.getTime()).toBeGreaterThan(all[0]!.started_at.getTime());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('tiempo abierto: horario, feriados y horario propio de la cola', () => {
  const start = async (conv: string, owner: string, queue: string | null, at: Date): Promise<void> => {
    await inTx((tx) => app.get(SlaService).startFirst(tx, { id: conv, ownerId: owner, queueId: queue }, { now: at, timeZone: TZ }));
  };
  const stop = async (conv: string, message: string, at: Date): Promise<void> => {
    await inTx((tx) => app.get(SlaService).stopOnReply(tx, conv, message, { now: at, timeZone: TZ }));
  };

  it('lunes a sábado de 08:30 a 18:00: lo que llega el sábado a las 17:50 vence el lunes a las 08:35, y el tiempo de respuesta cuenta solo horas abiertas', async () => {
    await ok(await putHours(T.alice, barber()));
    const c = await mkConv({ owner: IDS.carol });
    await start(c.id, IDS.carol, null, asLocal('2026-10-17T17:50:00')); // sábado
    const [t] = await timers(c.id);
    expect(t!.due_at).toEqual(asLocal('2026-10-19T08:35:00')); // 10 min el sábado + 5 el lunes (el domingo está cerrado)
    // responde el lunes a las 09:00: 10 min del sábado + 30 del lunes = 40 min, no 39 horas
    await stop(c.id, c.message, asLocal('2026-10-19T09:00:00'));
    expect((await timers(c.id))[0]).toMatchObject({ stop_reason: 'human_reply', response_seconds: 2400 });
  });

  it('dentro del horario corre normal; un feriado salta el día completo', async () => {
    await ok(await putHours(T.alice, barber()));
    const c = await mkConv({ owner: IDS.carol });
    await start(c.id, IDS.carol, null, asLocal('2026-10-20T10:00:00')); // martes
    expect((await timers(c.id))[0]!.due_at).toEqual(asLocal('2026-10-20T10:15:00'));
    // el lunes 19 es feriado: lo del sábado vence el martes 20 a las 08:35
    await ok(await call('POST', '/sla/holidays', T.alice, { date: '2026-10-19', name: 'Feriado' }), 201);
    const d = await mkConv({ owner: IDS.carol });
    await start(d.id, IDS.carol, null, asLocal('2026-10-17T17:50:00'));
    expect((await timers(d.id))[0]!.due_at).toEqual(asLocal('2026-10-20T08:35:00'));
    // un feriado anual aplica en cualquier año (el 19 de octubre de 2027 es martes)
    await ok(await call('DELETE', `/sla/holidays/${(await getSla()).holidays[0]!.id}`, T.alice));
    await ok(await call('POST', '/sla/holidays', T.alice, { date: '2020-10-19', name: 'Cada año', yearly: true }), 201);
    const e = await mkConv({ owner: IDS.carol });
    await start(e.id, IDS.carol, null, asLocal('2026-10-17T17:50:00'));
    expect((await timers(e.id))[0]!.due_at).toEqual(asLocal('2026-10-20T08:35:00'));
  });

  it('sin horario guardado está abierta siempre: 15 min son 15 min, de noche y en domingo', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await start(c.id, IDS.carol, null, asLocal('2026-10-18T23:50:00')); // domingo por la noche
    expect((await timers(c.id))[0]!.due_at).toEqual(asLocal('2026-10-19T00:05:00'));
  });

  it('una cola con horario propio usa el suyo (no el de la empresa); al quitarlo vuelve al de la empresa', async () => {
    await ok(await putHours(T.alice, barber()));
    const q = await mkQueue('Soporte');
    await ok(await call('PUT', `/queues/${q.id}/hours`, T.alice, { days: { mon: [['10:00', '12:00']], tue: [['10:00', '12:00']], wed: [['10:00', '12:00']], thu: [['10:00', '12:00']], fri: [['10:00', '12:00']] } }));
    const c = await mkConv({ owner: IDS.carol, queue: q.id });
    await start(c.id, IDS.carol, q.id, asLocal('2026-10-16T11:55:00')); // viernes: 5 min antes de que cierre la cola
    expect((await timers(c.id))[0]!.due_at).toEqual(asLocal('2026-10-19T10:10:00')); // 5 min el viernes + 10 el lunes
    // sin horario propio, la cola cae al de la empresa (viernes hasta las 18:00)
    await ok(await call('PUT', `/queues/${q.id}/hours`, T.alice, { days: null }));
    const d = await mkConv({ owner: IDS.carol, queue: q.id });
    await start(d.id, IDS.carol, q.id, asLocal('2026-10-16T11:55:00'));
    expect((await timers(d.id))[0]!.due_at).toEqual(asLocal('2026-10-16T12:10:00'));
  });

  it('la base impide dos cronómetros abiertos en una conversación y mediciones incoherentes; app_rw no puede borrar cronómetros, feriados ni la política', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await mkTimer(c.id, IDS.carol, { due: new Date(Date.now() + MIN) });
    await expect(mkTimer(c.id, IDS.carol, { due: new Date(Date.now() + MIN) })).rejects.toMatchObject({ code: '23505' });
    // cerrado sin motivo, o con tiempo de respuesta sin respuesta humana
    await expect(admin.query(`UPDATE response_timers SET stopped_at = now() WHERE conversation_id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE response_timers SET stopped_at = now(), stop_reason = 'closed', response_seconds = 5 WHERE conversation_id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE response_timers SET stopped_at = now(), stop_reason = 'human_reply' WHERE conversation_id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE response_timers SET kind = 'followup', reassign_at = now() WHERE conversation_id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      for (const table of ['response_timers', 'holidays', 'sla_policies']) {
        await rw.query('BEGIN');
        await rw.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        await expect(rw.query(`DELETE FROM ${table}`), table).rejects.toMatchObject({ code: '42501' });
        await rw.query('ROLLBACK');
      }
      // el horario propio de una cola sí se puede quitar
      await rw.query('BEGIN');
      await rw.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await rw.query('DELETE FROM business_hours');
      await rw.query('ROLLBACK');
    } finally {
      await rw.end();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('reasignación por falta de respuesta', () => {
  it('pasa de persona en persona cada vez que nadie responde, sin repetir a nadie, moviendo el lead, con aviso y auditoría de acción automática; al llegar al máximo se detiene', async () => {
    const queue = await readyQueue({ reassign_minutes: 10, max_rotations: 2 });
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    const conv = await convRow(id);
    expect(conv).toMatchObject({ owner_id: IDS.alice, status: 'pending', assignment_source: 'distribution', rotations: 0 });
    expect(await contactOwner(conv.contact_id)).toBe(IDS.alice); // el primer reparto le dio dueño al contacto
    const p1 = ((await ok<{ items: Array<{ id: string }> }>(await call('GET', '/pipelines', T.alice))).items)[0]!;
    const opp = await ok<{ id: string }>(await call('POST', '/opportunities', T.alice, { contact_id: conv.contact_id, pipeline_id: p1.id, owner_id: IDS.alice }), 201);
    const oppOwner = async (): Promise<string | null> => (await admin.query(`SELECT owner_id FROM opportunities WHERE id = $1`, [opp.id])).rows[0].owner_id as string | null;
    const first = (await timers(id))[0]!;
    expect(first.reassign_at!.getTime() - first.started_at.getTime()).toBe(10 * MIN);

    // todavía no toca
    expect(await sweep(5 * MIN)).toBe(0);
    expect((await convRow(id)).owner_id).toBe(IDS.alice);

    // 1.ª reasignación: alice → carol
    expect(await sweep(11 * MIN)).toBe(1);
    let c = await convRow(id);
    expect(c).toMatchObject({ owner_id: IDS.carol, status: 'pending', assignment_source: 'distribution', rotations: 1, tried_owners: [IDS.alice] });
    expect(await contactOwner(conv.contact_id)).toBe(IDS.carol);
    expect(await oppOwner()).toBe(IDS.carol);
    let ts = await timers(id);
    expect(ts.map((t) => [t.owner_id, t.stop_reason])).toEqual([[IDS.alice, 'reassigned'], [IDS.carol, null]]);
    expect(ts[1]!.reassign_at!.getTime() - ts[1]!.started_at.getTime()).toBe(10 * MIN);
    expect(await noteTexts(id)).toEqual(['La conversación pasó de Alicia Torres a Carolina Vera: no hubo respuesta en 10 min de horario laboral.']);
    expect(fake().outbox).toEqual([]); // el aviso es interno: nada sale al cliente
    // Carolina la ve en «Pendientes» con su propio cronómetro; Alicia ya no
    expect(ids(await list(T.carol, '?tab=pending'))).toEqual([id]);
    expect((await get(T.carol, id)).sla).toMatchObject({ kind: 'first', state: 'ok' });
    expect((await call('GET', `/conversations/${id}`, T.eve)).status).toBe(404);

    // 2.ª: carol → eve (nunca vuelve a alice)
    expect(await sweep(22 * MIN)).toBe(1);
    c = await convRow(id);
    expect(c).toMatchObject({ owner_id: IDS.eve, rotations: 2, tried_owners: [IDS.alice, IDS.carol] });
    expect(await contactOwner(conv.contact_id)).toBe(IDS.eve);
    expect(await oppOwner()).toBe(IDS.eve);
    expect((await noteTexts(id)).at(-1)).toBe('La conversación pasó de Carolina Vera a Eva Mora: no hubo respuesta en 10 min de horario laboral.');

    // 3.ª: ya se reasignó el máximo (2): se deja de reasignar, queda un aviso y la conversación sigue vencida a la vista
    expect(await sweep(33 * MIN)).toBe(1);
    c = await convRow(id);
    expect(c).toMatchObject({ owner_id: IDS.eve, rotations: 2 });
    ts = await timers(id);
    expect(ts.at(-1)).toMatchObject({ owner_id: IDS.eve, stopped_at: null, reassign_at: null });
    expect((await noteTexts(id)).at(-1)).toBe('Nadie respondió en 10 min de horario laboral y ya se reasignó 2 veces, el máximo de la cola. Ya no se reasigna: Eva Mora sigue con la conversación.');
    expect(await sweep(44 * MIN)).toBe(0);
    expect(await noteTexts(id)).toHaveLength(3);

    // auditoría: dueño de la conversación, del contacto y de la oportunidad, todo como acción AUTOMÁTICA
    expect((await audits(id)).filter((a) => a.field === 'owner_id').map((a) => [a.old_value, a.new_value, a.source])).toEqual([[null, IDS.alice, 'automation'], [IDS.alice, IDS.carol, 'automation'], [IDS.carol, IDS.eve, 'automation']]);
    expect((await audits(conv.contact_id)).filter((a) => a.field === 'owner_id').map((a) => [a.old_value, a.new_value, a.source])).toEqual([[null, IDS.alice, 'automation'], [IDS.alice, IDS.carol, 'automation'], [IDS.carol, IDS.eve, 'automation']]);
    expect((await audits(opp.id)).filter((a) => a.field === 'owner_id' && a.source === 'automation').map((a) => [a.old_value, a.new_value])).toEqual([[IDS.alice, IDS.carol], [IDS.carol, IDS.eve]]);
    expect(queue).toBeTruthy();
  });

  it('si responde a tiempo no se reasigna; si no hay a quién (todas las demás personas ya la tuvieron o no están en la cola) se avisa y se deja de insistir', async () => {
    await readyQueue({ reassign_minutes: 10 }, [[IDS.alice, true, 1]]);
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(2), 'wamid.2');
    const [a, b] = (await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at, id`, [ORG_A])).rows.map((r: { id: string }) => r.id) as [string, string];
    await ok(await reply(T.alice, a, 'Hola'), 201); // a se atiende; b no
    expect(await sweep(11 * MIN)).toBe(1); // solo b estaba pendiente de reasignar
    expect(await convRow(a)).toMatchObject({ owner_id: IDS.alice, rotations: 0 });
    expect(await noteTexts(a)).toEqual([]);
    expect(await convRow(b)).toMatchObject({ owner_id: IDS.alice, rotations: 0, tried_owners: [] });
    expect(await noteTexts(b)).toEqual(['Nadie respondió en 10 min de horario laboral y no hay a quién reasignarla en la cola (todas las personas disponibles ya la tuvieron o no pueden recibir más). Alicia Torres sigue con la conversación.']);
    expect((await openTimer(b))!.reassign_at).toBeNull(); // no se vuelve a intentar
    expect(await sweep(30 * MIN)).toBe(0);
  });

  it('no reasigna lo que ya no corresponde: finalizada, que cambió de manos, con la reasignación o el reparto apagados; y no toca a quien no puede recibir trabajo', async () => {
    const queue = await readyQueue({ reassign_minutes: 10 });
    for (let i = 1; i <= 4; i++) await ingest(phone(i), `wamid.${i}`);
    const rows = (await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at, id`, [ORG_A])).rows.map((r: { id: string }) => r.id);
    const [closed, moved, off, gone] = rows as [string, string, string, string];
    await ok(await call('POST', `/conversations/${closed}/close`, T.alice));
    await admin.query(`UPDATE conversations SET owner_id = $1 WHERE id = $2`, [IDS.eve, moved]); // alguien la tomó a mano: el cronómetro era de otra persona
    const before = { closed: await convRow(closed), moved: await convRow(moved) };
    await admin.query(`UPDATE queues SET reassign_minutes = 0 WHERE id = $1`, [queue]); // apaga la reasignación
    // «off» y «gone» siguen con reassign_at puesto, pero la cola ya no lo pide
    expect((await openTimer(off))!.reassign_at).not.toBeNull();
    expect(await sweep(11 * MIN)).toBe(3); // moved, off y gone se examinan; ninguna cambia de dueño
    for (const id of [moved, off, gone]) expect((await openTimer(id))?.reassign_at ?? null, id).toBeNull();
    expect(await convRow(closed)).toEqual(before.closed);
    expect(await convRow(moved)).toEqual(before.moved);
    expect((await convRow(off)).rotations).toBe(0);
    expect((await convRow(gone)).rotations).toBe(0);
    for (const id of rows) expect(await noteTexts(id), id).toEqual([]);
  });

  it('transferir o tomar a mano reinicia el ciclo (rotaciones y personas probadas) y el cronómetro de quien la recibe vuelve a reasignar', async () => {
    const queue = await readyQueue({ reassign_minutes: 10, max_rotations: 3 });
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    expect(await sweep(11 * MIN)).toBe(1);
    expect(await convRow(id)).toMatchObject({ owner_id: IDS.carol, rotations: 1, tried_owners: [IDS.alice] });
    await ok(await transfer(T.alice, id, { to_user_id: IDS.eve }));
    expect(await convRow(id)).toMatchObject({ owner_id: IDS.eve, assignment_source: 'manual', rotations: 0, tried_owners: [] });
    const open = (await openTimer(id))!;
    expect(open).toMatchObject({ owner_id: IDS.eve, kind: 'first' });
    expect(open.reassign_at).not.toBeNull();
    // (el reloj de la reasignación está adelantado en la prueba: se compara por persona, no por orden de inicio)
    expect(Object.fromEntries((await timers(id)).map((t) => [t.owner_id, t.stop_reason]))).toEqual({ [IDS.alice]: 'reassigned', [IDS.carol]: 'transferred', [IDS.eve]: null });
    // lo tomado a mano por un administrador también arranca su propio cronómetro con reasignación
    const free = await mkConv({ queue });
    await ok(await call('POST', `/conversations/${free.id}/take`, T.alice));
    expect((await openTimer(free.id))!.reassign_at).not.toBeNull();
    expect(await convRow(free.id)).toMatchObject({ owner_id: IDS.alice, assignment_source: 'manual', rotations: 0, tried_owners: [] });
  });

  it('con «respetar el horario» la cola no reparte cerrada: la conversación espera «sin asignar» y se reparte sola al abrir; la que reparte siempre no espera', async () => {
    const queue = await readyQueue({ respect_hours: true });
    await ok(await putHours(T.alice, closedToday()));
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    expect(await convRow(id)).toMatchObject({ status: 'unassigned', owner_id: null, queue_id: queue });
    expect(await timers(id)).toEqual([]);
    expect(await sweep(0, 'pickup')).toBe(0); // sigue cerrada
    expect((await convRow(id)).status).toBe('unassigned');
    // abre: la tarea la reparte y arranca su cronómetro
    await ok(await putHours(T.alice, allDay()));
    expect(await sweep(0, 'pickup')).toBe(1);
    expect(await convRow(id)).toMatchObject({ status: 'pending', owner_id: IDS.alice });
    expect((await openTimer(id))).toMatchObject({ kind: 'first', owner_id: IDS.alice });
    // sin «respetar el horario» una conversación se reparte aunque la empresa esté cerrada
    await patchQueue(queue, { respect_hours: false });
    await ok(await putHours(T.alice, closedToday()));
    await ingest(phone(2), 'wamid.2');
    const second = (await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [ORG_A])).rows[0].id as string;
    expect(await convRow(second)).toMatchObject({ status: 'pending', owner_id: IDS.carol });
    expect(await sweep(0, 'pickup')).toBe(0);
  });

  it('el horario propio de la cola manda sobre el de la empresa al decidir si reparte', async () => {
    const queue = await readyQueue({ respect_hours: true });
    await ok(await putHours(T.alice, allDay())); // la empresa está abierta…
    await ok(await call('PUT', `/queues/${queue}/hours`, T.alice, { days: closedToday() })); // …pero la cola, no
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    expect(await convRow(id)).toMatchObject({ status: 'unassigned', owner_id: null });
    expect(await sweep(0, 'pickup')).toBe(0);
    await ok(await call('PUT', `/queues/${queue}/hours`, T.alice, { days: null })); // vuelve al de la empresa (abierta)
    expect(await sweep(0, 'pickup')).toBe(1);
    expect((await convRow(id)).owner_id).toBe(IDS.alice);
  });

  it('el tope diario cuenta solo lo que repartió la cola: una conversación asignada a mano no consume el tope de la persona', async () => {
    await readyQueue({ daily_cap: 1 }, [[IDS.alice, true, 1], [IDS.carol, true, 1]]);
    await mkConv({ owner: IDS.alice, status: 'working', source: 'manual' }); // alice recibió una a mano hoy
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(2), 'wamid.2');
    const owners = (await admin.query(`SELECT owner_id FROM conversations WHERE organization_id = $1 AND assignment_source = 'distribution' ORDER BY created_at, id`, [ORG_A])).rows.map((r: { owner_id: string }) => r.owner_id);
    expect(owners).toEqual([IDS.alice, IDS.carol]); // si la manual contara, alice estaría topada y las dos irían a carol
    await ingest(phone(3), 'wamid.3'); // las dos ya tienen su reparto de hoy: no hay a quién
    expect((await convRow((await admin.query(`SELECT id FROM conversations WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [ORG_A])).rows[0].id as string)).status).toBe('unassigned');
  });

  it('dos pasadas a la vez no reasignan dos veces la misma conversación; la tarea recorre cada empresa bajo su propio contexto', async () => {
    await readyQueue({ reassign_minutes: 10 });
    await ingest(phone(1), 'wamid.1');
    const id = await onlyConv();
    const both = await Promise.all([sweep(11 * MIN), sweep(11 * MIN)]);
    expect(both.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await convRow(id)).toMatchObject({ owner_id: IDS.carol, rotations: 1 });
    expect(await noteTexts(id)).toHaveLength(1);
    expect((await timers(id)).filter((t) => t.stopped_at === null)).toHaveLength(1);

    // la tarea: A reasigna; B (sin cola) solo se limpia, y nada de A toca a B ni al revés
    const bConv = await mkConv({ org: ORG_B, owner: IDS.bob, status: 'pending' });
    await mkTimer(bConv.id, IDS.bob, { due: ago(MIN), started: ago(20 * MIN), reassign: ago(MIN), org: ORG_B });
    const job = app.get(SlaSweepJob);
    expect(job.name).toBe('sla-sweep');
    expect(await job.run(new Date(Date.now() + 22 * MIN))).toBe(2); // 1 de A (carol → eve) + 1 de B (examinada)
    expect(await convRow(id)).toMatchObject({ owner_id: IDS.eve, rotations: 2 });
    expect(await convRow(bConv.id)).toMatchObject({ owner_id: IDS.bob, rotations: 0 });
    expect((await openTimer(bConv.id))!.reassign_at).toBeNull();
    expect(await noteTexts(bConv.id)).toEqual([]);
  });
});
