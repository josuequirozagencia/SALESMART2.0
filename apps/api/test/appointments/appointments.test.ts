// M6.3 — Citas y recordatorios (ADR-13/18/51; F13). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/appointments/options
//   POST /v1/appointments
//   GET /v1/appointments
//   GET /v1/appointments/:id
//   PATCH /v1/appointments/:id
//   POST /v1/appointments/:id/cancel
//   POST /v1/appointments/:id/complete
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AppointmentsModule, AppointmentsService, formatWhen, REMINDER_LIMIT, REMINDER_LIMIT_EXTENDED, REMINDER_MAX_LATE_MS } from '../../src/modules/appointments';
import { AttributionModule } from '../../src/modules/attribution';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_TEMPLATES, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule, OutboundDispatcher } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { TemplatesModule } from '../../src/modules/templates';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, OpportunitiesModule, AttributionModule.register(), TemplatesModule, InboxModule, AppointmentsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A, dueña de las conversaciones
  eve: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'America/Guayaquil';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob', string>;
let channelA = '';
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY, WHATSAPP_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE appointment_reminders, appointments, message_templates, meta_events, response_timers, messages, conversation_participants, conversations, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, contact_phones, contacts, queue_products, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, TZ]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const key = (): string => `k-${randomUUID()}`;
const idem = (k = key()) => ({ 'idempotency-key': k });
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

interface Reminder { id: string; offset_minutes: number; send_at: string; status: string; via: string | null; reason: string | null; delivery: string | null }
interface Appt {
  id: string; status: string; starts_at: string; ends_at: string; kind: string; notes: string | null; owner: { id: string; name: string } | null; contact: { id: string; name: string };
  reminders: Reminder[]; reminder_offsets: number[]; reminder_template: { id: string; name: string } | null; cancel_reason: string | null; can: { edit: boolean; cancel: boolean; complete: boolean };
}
interface Options { timezone: string; max_reminders: number; window: { open: boolean; expires_at: string | null }; templates: Array<{ id: string; name: string }>; blocked: string | null }

let seq = 0;
/** Una conversación de A con su contacto (con clic de anuncio de Meta para que el Schedule sea atribuible). */
async function mkConv(o: { owner?: string | null; lastInbound?: Date | null; ctwa?: boolean; source?: string; org?: string } = {}): Promise<{ conv: string; contact: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id, ctwa_cl_id, source) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`, [org, `Cliente ${seq}`, owner, o.ctwa === false ? null : `ctwa-${seq}`, o.source ?? 'manual'])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const last = o.lastInbound === undefined ? new Date() : o.lastInbound;
  const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END, now(), $6, 0, $7) RETURNING id`, [org, contact, channelA, owner ? 'working' : 'unassigned', owner, last, phone.replace('+', '')])).rows[0].id as string;
  return { conv, contact };
}
const inH = (h: number): string => new Date(Date.now() + h * HOUR).toISOString();
const mk = async (conv: string, body: Record<string, unknown> = {}, token = T.carol): Promise<Appt> => {
  const r = await call('POST', '/appointments', token, { conversation_id: conv, starts_at: inH(3), ...body }, idem());
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(201);
  return json<Appt>(r);
};
const get = async (id: string, token = T.alice): Promise<Appt> => {
  const r = await call('GET', `/appointments/${id}`, token);
  expect(r.status).toBe(200);
  return json<Appt>(r);
};
const count = async (sql: string): Promise<number> => (await admin.query(sql)).rows[0].n as number;
/** La tarea de recordatorios corriendo «ahora» (o en el instante que se indique). */
const runReminders = (at: Date, org = ORG_A): Promise<number> => TenantContext.run({ organizationId: org }, () => app.get(AppointmentsService).runDue(at, TZ));
const dispatch = (at = new Date(Date.now() + 5_000), org = ORG_A) => TenantContext.run({ organizationId: org }, () => app.get(OutboundDispatcher).runDue(at));
const reminderRows = async (appt: string) => (await admin.query(`SELECT offset_minutes, status, via, reason, message_id FROM appointment_reminders WHERE appointment_id = $1 ORDER BY send_at, offset_minutes`, [appt])).rows as Array<{ offset_minutes: number; status: string; via: string | null; reason: string | null; message_id: string | null }>;

/** Sincroniza las plantillas del catálogo de ejemplo y devuelve la de recordatorio con valores para todas sus variables. */
async function reminderTemplate(): Promise<{ id: string; params: Record<string, string> }> {
  expect((await call('POST', `/channels/${channelA}/templates/sync`, T.alice)).status).toBeLessThan(300);
  const list = await json<{ items: Array<{ id: string; name: string; language: string; variables: Array<{ id: string }> }> }>(await call('GET', `/channels/${channelA}/templates`, T.alice));
  const t = list.items.find((x) => x.name === 'recordatorio_cita' && x.language === 'es')!;
  return { id: t.id, params: Object.fromEntries(t.variables.map((v) => [v.id, 'valor'])) };
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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test') };
  const ch = await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN });
  expect(ch.status).toBe(201);
  channelA = (await json<{ id: string }>(ch)).id;
  const f = fake();
  Reflect.deleteProperty(f, 'listTemplates');
  f.templates = [...FAKE_TEMPLATES];
  f.outbox.length = 0;
});

describe('agendar una cita', () => {
  it('crea la cita con sus recordatorios: etiqueta Cita agendada, Schedule a Meta por la cita y la oportunidad pasa a la etapa de cita', async () => {
    const { conv, contact } = await mkConv();
    const opp = await json<{ id: string }>(await call('POST', '/opportunities', T.carol, { contact_id: contact }));
    const stages = (await admin.query(`SELECT s.id, s.pipeline_id FROM pipeline_stages s WHERE s.kind = 'open' AND s.deleted_at IS NULL ORDER BY s.position`)).rows as Array<{ id: string; pipeline_id: string }>;
    expect(stages.length).toBeGreaterThan(2);
    await admin.query(`UPDATE pipelines SET appointment_stage_id = $1 WHERE id = $2`, [stages[2]!.id, stages[2]!.pipeline_id]);
    const startsAt = inH(3);
    const a = await mk(conv, { starts_at: startsAt, duration_minutes: 45, kind: 'Corte y barba', notes: 'Trae foto', reminders: [60, 10] });
    expect(a).toMatchObject({ status: 'scheduled', kind: 'Corte y barba', notes: 'Trae foto', owner: { id: IDS.carol, name: 'Carolina Vera' }, contact: { id: contact }, reminder_offsets: [60, 10], can: { edit: true, cancel: true, complete: true } });
    expect(new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()).toBe(45 * MIN);
    expect(a.reminders.map((r) => [r.offset_minutes, r.status])).toEqual([[60, 'scheduled'], [10, 'scheduled']]);
    expect(new Date(a.reminders[0]!.send_at).getTime()).toBe(new Date(startsAt).getTime() - 60 * MIN);
    expect(await count(`SELECT count(*)::int n FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = '${contact}' AND t.system_key = 'appointment'`)).toBe(1);
    const ev = (await admin.query(`SELECT type, status FROM meta_events WHERE event_id = $1`, [`schedule:${a.id}`])).rows[0];
    expect(ev).toMatchObject({ type: 'Schedule', status: 'pending' });
    expect((await admin.query(`SELECT stage_id FROM opportunities WHERE id = $1`, [opp.id])).rows[0].stage_id).toBe(stages[2]!.id);
    expect((await admin.query(`SELECT opportunity_id FROM appointments WHERE id = $1`, [a.id])).rows[0].opportunity_id).toBe(opp.id);
    expect(await count(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'appointment' AND entity_id = '${a.id}'`)).toBe(1);
  });

  it('el Schedule sale por la CITA aunque el pipeline no tenga etapa de cita; sin clic de anuncio queda omitido con su motivo', async () => {
    const withAd = await mkConv();
    const a1 = await mk(withAd.conv);
    expect((await admin.query(`SELECT status FROM meta_events WHERE event_id = $1`, [`schedule:${a1.id}`])).rows[0].status).toBe('pending');
    const noAd = await mkConv({ ctwa: false });
    const a2 = await mk(noAd.conv);
    expect((await admin.query(`SELECT status, last_error FROM meta_events WHERE event_id = $1`, [`schedule:${a2.id}`])).rows[0]).toMatchObject({ status: 'skipped' });
  });

  it('la llave de idempotencia es obligatoria; repetirla devuelve la misma cita (200) sin duplicar nada; con otros datos o de otra persona, error; cinco simultáneas crean una', async () => {
    const { conv } = await mkConv();
    const body = { conversation_id: conv, starts_at: inH(3), reminders: [30] };
    expect((await call('POST', '/appointments', T.carol, body)).status).toBe(400);
    expect((await call('POST', '/appointments', T.carol, body, idem('corta'))).status).toBe(400);
    const k = key();
    const first = await call('POST', '/appointments', T.carol, body, idem(k));
    expect(first.status).toBe(201);
    const again = await call('POST', '/appointments', T.carol, body, idem(k));
    expect(again.status).toBe(200);
    expect((await json<Appt>(again)).id).toBe((await json<Appt>(first)).id);
    expect(await count(`SELECT count(*)::int n FROM appointments`)).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM appointment_reminders`)).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM meta_events WHERE type = 'Schedule'`)).toBe(1);
    expect(await code(await call('POST', '/appointments', T.carol, { ...body, starts_at: inH(5) }, idem(k)))).toBe('IDEMPOTENCY_MISMATCH');
    expect(await code(await call('POST', '/appointments', T.alice, body, idem(k)))).toBe('IDEMPOTENCY_CONFLICT');
    const { conv: c2 } = await mkConv();
    const k2 = key();
    const b2 = { conversation_id: c2, starts_at: inH(4) };
    const rs = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/appointments', T.carol, b2, idem(k2))));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await count(`SELECT count(*)::int n FROM appointments WHERE conversation_id = '${c2}'`)).toBe(1);
  });

  it(`el tope es de ${REMINDER_LIMIT} recordatorios (${REMINDER_LIMIT_EXTENDED} si la fuente es QR, Messenger o Instagram); no se repiten ni caen en el pasado`, async () => {
    const { conv } = await mkConv();
    const post = (body: Record<string, unknown>) => call('POST', '/appointments', T.carol, { conversation_id: conv, starts_at: inH(5), ...body }, idem());
    const four = await post({ reminders: [10, 20, 30, 40] });
    expect(four.status).toBe(400);
    expect(JSON.stringify(await four.json())).toContain('Máximo 3 recordatorios');
    expect((await post({ reminders: [10, 20, 30] })).status).toBe(201);
    expect((await post({ reminders: [10, 10] })).status).toBe(400);
    expect((await post({ reminders: [0] })).status).toBe(400);
    expect((await post({ reminders: [50_000] })).status).toBe(400);
    const past = await post({ starts_at: inH(0.5), reminders: [60] }); // el recordatorio de 1 h antes ya habría pasado
    expect(past.status).toBe(400);
    expect(JSON.stringify(await past.json())).toContain('ya habría pasado');
    const qr = await mkConv({ source: 'whatsapp_qr' });
    const r5 = await call('POST', '/appointments', T.carol, { conversation_id: qr.conv, starts_at: inH(5), reminders: [10, 20, 30, 40, 50] }, idem());
    expect(r5.status).toBe(201);
    expect((await call('POST', '/appointments', T.carol, { conversation_id: qr.conv, starts_at: inH(5), reminders: [1, 2, 3, 4, 5, 6] }, idem())).status).toBe(400);
  });

  it('valida la hora y los datos: no en el pasado, formato ISO con zona, duración y tipo acotados', async () => {
    const { conv } = await mkConv();
    const bad = async (body: Record<string, unknown>) => expect((await call('POST', '/appointments', T.carol, { conversation_id: conv, starts_at: inH(3), ...body }, idem())).status, JSON.stringify(body)).toBe(400);
    await bad({ starts_at: inH(-2) });
    await bad({ starts_at: '2030-01-01 10:00' });
    await bad({ starts_at: 'mañana' });
    await bad({ duration_minutes: 1 });
    await bad({ duration_minutes: 5000 });
    await bad({ kind: '' });
    await bad({ kind: 'x'.repeat(61) });
    await bad({ notes: 'n'.repeat(1001) });
    await bad({ extra: 1 });
    expect(await count(`SELECT count(*)::int n FROM appointments`)).toBe(0);
  });

  it('sin asesor no se agenda; quien no ve la conversación recibe 404; un administrador agenda por la asesora y ella es la responsable', async () => {
    const un = await mkConv({ owner: null });
    const r = await call('POST', '/appointments', T.alice, { conversation_id: un.conv, starts_at: inH(3) }, idem());
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('CONVERSATION_UNASSIGNED');
    const carols = await mkConv();
    expect((await call('POST', '/appointments', T.eve, { conversation_id: carols.conv, starts_at: inH(3) }, idem())).status).toBe(404);
    const viaAdmin = await call('POST', '/appointments', T.alice, { conversation_id: carols.conv, starts_at: inH(3) }, idem());
    expect(viaAdmin.status).toBe(201);
    expect((await json<Appt>(viaAdmin)).owner).toMatchObject({ id: IDS.carol });
    expect((await call('POST', '/appointments', T.bob, { conversation_id: carols.conv, starts_at: inH(3) }, idem())).status).toBe(404);
  });

  it('con la conexión desactivada no se agenda (no habría por dónde recordar)', async () => {
    const { conv } = await mkConv();
    await admin.query(`UPDATE channel_accounts SET status = 'disabled' WHERE id = $1`, [channelA]);
    const r = await call('POST', '/appointments', T.carol, { conversation_id: conv, starts_at: inH(3) }, idem());
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('CHANNEL_DISABLED');
  });
});

describe('ventana de 24 h de WhatsApp y plantilla', () => {
  it('un recordatorio que saldría con la ventana cerrada exige elegir una plantilla aprobada; con una válida se guarda', async () => {
    const { conv } = await mkConv({ lastInbound: new Date(Date.now() - 30 * HOUR) });
    const body = { conversation_id: conv, starts_at: inH(5), reminders: [60] };
    const without = await call('POST', '/appointments', T.carol, body, idem());
    expect(without.status).toBe(400);
    expect(JSON.stringify(await without.json())).toContain('plantilla');
    const tpl = await reminderTemplate();
    const bad = await call('POST', '/appointments', T.carol, { ...body, reminder_template_id: tpl.id, reminder_params: {} }, idem());
    expect(bad.status).toBe(400); // faltan los valores de las variables
    expect((await call('POST', '/appointments', T.carol, { ...body, reminder_template_id: randomUUID(), reminder_params: tpl.params }, idem())).status).toBe(404);
    const ok = await call('POST', '/appointments', T.carol, { ...body, reminder_template_id: tpl.id, reminder_params: tpl.params }, idem());
    expect(ok.status).toBe(201);
    expect((await json<Appt>(ok)).reminder_template).toMatchObject({ id: tpl.id, name: 'recordatorio_cita' });
  });

  it('con la ventana abierta y recordatorios dentro de ella no hace falta plantilla; una cita sin recordatorios tampoco la necesita', async () => {
    const open = await mkConv();
    expect((await call('POST', '/appointments', T.carol, { conversation_id: open.conv, starts_at: inH(5), reminders: [180] }, idem())).status).toBe(201); // sale en ~2 h: dentro de las 24 h
    const closed = await mkConv({ lastInbound: null });
    expect((await call('POST', '/appointments', T.carol, { conversation_id: closed.conv, starts_at: inH(5) }, idem())).status).toBe(201);
    const late = await mkConv();
    const r = await call('POST', '/appointments', T.carol, { conversation_id: late.conv, starts_at: inH(40), reminders: [60] }, idem()); // saldría a las 39 h: fuera de la ventana
    expect(r.status).toBe(400);
  });

  it('GET /v1/appointments/options trae zona horaria, tope, ventana y solo las plantillas enviables; explica los bloqueos', async () => {
    const ok = await mkConv();
    await reminderTemplate();
    const o = await json<Options>(await call('GET', `/appointments/options?conversation_id=${ok.conv}`, T.carol));
    expect(o).toMatchObject({ timezone: TZ, max_reminders: REMINDER_LIMIT, blocked: null, window: { open: true } });
    expect(o.templates.map((t) => t.name)).toContain('recordatorio_cita');
    expect(o.templates.map((t) => t.name)).not.toContain('rechazada_ejemplo');
    const closed = await mkConv({ lastInbound: new Date(Date.now() - 30 * HOUR) });
    expect((await json<Options>(await call('GET', `/appointments/options?conversation_id=${closed.conv}`, T.carol))).window.open).toBe(false);
    const un = await mkConv({ owner: null });
    expect((await json<Options>(await call('GET', `/appointments/options?conversation_id=${un.conv}`, T.alice))).blocked).toBe('unassigned');
    const qr = await mkConv({ source: 'whatsapp_qr' });
    expect((await json<Options>(await call('GET', `/appointments/options?conversation_id=${qr.conv}`, T.carol))).max_reminders).toBe(REMINDER_LIMIT_EXTENDED);
    expect((await call('GET', `/appointments/options?conversation_id=${ok.conv}`, T.eve)).status).toBe(404);
    expect((await call('GET', `/appointments/options`, T.carol)).status).toBe(400);
  });
});

describe('envío de los recordatorios', () => {
  it('a su hora sale como mensaje AUTOMÁTICO en cola (texto con la hora de la empresa); una segunda pasada no lo repite; el estado de entrega se ve en la cita', async () => {
    const { conv } = await mkConv();
    const startsAt = new Date(Date.now() + 90 * MIN);
    const a = await mk(conv, { starts_at: startsAt.toISOString(), kind: 'Corte', reminders: [60] });
    expect(await runReminders(new Date())).toBe(0); // todavía no es la hora
    const due = new Date(startsAt.getTime() - 60 * MIN + MIN);
    expect(await runReminders(due)).toBe(1);
    expect(await runReminders(due)).toBe(0);
    const msg = (await admin.query(`SELECT sender_type, kind, body, status, direction FROM messages WHERE conversation_id = $1`, [conv])).rows;
    expect(msg).toHaveLength(1);
    expect(msg[0]).toMatchObject({ sender_type: 'automation', kind: 'text', status: 'queued', direction: 'out' });
    expect(msg[0].body).toContain('Recordatorio: tienes una cita (Corte)');
    expect(msg[0].body).toContain(formatWhen(startsAt, TZ));
    const d1 = await get(a.id);
    expect(d1.reminders[0]).toMatchObject({ status: 'sent', via: 'text', delivery: 'queued' });
    await dispatch(new Date(due.getTime() + 5_000)); // el mensaje se creó «a la hora del recordatorio»: se despacha desde ahí
    expect(fake().outbox).toHaveLength(1);
    expect((await get(a.id)).reminders[0]!.delivery).toBe('sent');
    // No es una respuesta humana: no cambia el estado de la conversación
    expect((await admin.query(`SELECT status FROM conversations WHERE id = $1`, [conv])).rows[0].status).toBe('working');
  });

  it('con la ventana cerrada a la hora del envío sale la plantilla de la cita; sin plantilla queda omitido con su motivo', async () => {
    const tpl = await reminderTemplate();
    const withTpl = await mkConv({ lastInbound: new Date(Date.now() - 30 * HOUR) });
    const startsAt = new Date(Date.now() + 2 * HOUR);
    const a = await mk(withTpl.conv, { starts_at: startsAt.toISOString(), reminders: [60], reminder_template_id: tpl.id, reminder_params: tpl.params });
    const due = new Date(startsAt.getTime() - 59 * MIN);
    expect(await runReminders(due)).toBe(1);
    expect(await reminderRows(a.id)).toMatchObject([{ status: 'sent', via: 'template' }]);
    expect((await admin.query(`SELECT kind, sender_type FROM messages WHERE conversation_id = $1`, [withTpl.conv])).rows).toEqual([{ kind: 'template', sender_type: 'automation' }]);
    await dispatch(new Date(due.getTime() + 5_000));
    expect(fake().outbox.map((o) => o.template?.name)).toEqual(['recordatorio_cita']);

    const noTpl = await mkConv();
    const b = await mk(noTpl.conv, { starts_at: startsAt.toISOString(), reminders: [60] });
    await admin.query(`UPDATE conversations SET last_inbound_at = now() - interval '40 hours' WHERE id = $1`, [noTpl.conv]); // el cliente dejó de escribir: la ventana se cerró
    expect(await runReminders(due)).toBe(1);
    expect(await reminderRows(b.id)).toMatchObject([{ status: 'skipped', reason: 'window_closed' }]);
    expect(await count(`SELECT count(*)::int n FROM messages WHERE conversation_id = '${noTpl.conv}'`)).toBe(0);
  });

  it('no se envía uno atrasado (más de 30 min), ni de una cita que ya empezó, ni de una conexión apagada; una cita cancelada o completada no recuerda', async () => {
    const startsAt = new Date(Date.now() + 3 * HOUR);
    const sendAt = new Date(startsAt.getTime() - 60 * MIN);
    const late = await mk((await mkConv()).conv, { starts_at: startsAt.toISOString(), reminders: [60] });
    expect(await runReminders(new Date(sendAt.getTime() + REMINDER_MAX_LATE_MS + MIN))).toBe(1);
    expect(await reminderRows(late.id)).toMatchObject([{ status: 'skipped', reason: 'late' }]);
    const started = await mk((await mkConv()).conv, { starts_at: startsAt.toISOString(), reminders: [60] });
    await admin.query(`UPDATE appointments SET starts_at = now() - interval '1 minute' WHERE id = $1`, [started.id]);
    await admin.query(`UPDATE appointment_reminders SET send_at = now() - interval '5 minutes' WHERE appointment_id = $1`, [started.id]);
    expect(await runReminders(new Date())).toBe(1);
    expect(await reminderRows(started.id)).toMatchObject([{ status: 'skipped', reason: 'expired' }]);
    const off = await mk((await mkConv()).conv, { starts_at: startsAt.toISOString(), reminders: [60] });
    await admin.query(`UPDATE channel_accounts SET status = 'disabled' WHERE id = $1`, [channelA]);
    expect(await runReminders(new Date(sendAt.getTime() + MIN))).toBe(1);
    expect(await reminderRows(off.id)).toMatchObject([{ status: 'skipped', reason: 'channel_off' }]);
    expect(await count(`SELECT count(*)::int n FROM messages WHERE sender_type = 'automation'`)).toBe(0);
  });

  it('un fallo de una empresa no se mezcla con otra: la tarea de A no toca los recordatorios de B', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv, { starts_at: inH(2), reminders: [60] });
    expect(await runReminders(new Date(Date.now() + 2 * HOUR), ORG_B)).toBe(0);
    expect(await reminderRows(a.id)).toMatchObject([{ status: 'scheduled' }]);
  });
});

describe('reprogramar, cancelar y completar', () => {
  it('reprogramar rehace los recordatorios con la hora nueva y cancela los viejos; cambiar solo el tipo o la nota no los toca', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv, { starts_at: inH(3), reminders: [60, 10] });
    const note = await call('PATCH', `/appointments/${a.id}`, T.carol, { kind: 'Tinte', notes: 'Con barba' });
    expect(note.status).toBe(200);
    expect(await json<Appt>(note)).toMatchObject({ kind: 'Tinte', notes: 'Con barba' });
    expect((await reminderRows(a.id)).map((r) => r.status)).toEqual(['scheduled', 'scheduled']);
    const later = inH(6);
    const r = await call('PATCH', `/appointments/${a.id}`, T.carol, { starts_at: later });
    expect(r.status).toBe(200);
    const d = await json<Appt>(r);
    expect(d.starts_at).toBe(later);
    expect(d.reminders.filter((x) => x.status === 'scheduled').map((x) => new Date(x.send_at).getTime()).sort()).toEqual([new Date(later).getTime() - 60 * MIN, new Date(later).getTime() - 10 * MIN].sort());
    const rows = await reminderRows(a.id);
    expect(rows.filter((x) => x.status === 'cancelled').map((x) => x.reason)).toEqual(['rescheduled', 'rescheduled']);
    expect(rows.filter((x) => x.status === 'scheduled')).toHaveLength(2);
    const fields = (await admin.query(`SELECT field FROM audit_logs WHERE entity_type = 'appointment' AND entity_id = $1 AND field IS NOT NULL ORDER BY field`, [a.id])).rows.map((x) => x.field);
    expect(fields).toEqual(['kind', 'notes', 'starts_at']);
    expect((await call('PATCH', `/appointments/${a.id}`, T.carol, { starts_at: inH(-1) })).status).toBe(400);
    expect((await call('PATCH', `/appointments/${a.id}`, T.carol, {})).status).toBe(400);
    expect((await call('PATCH', `/appointments/${a.id}`, T.carol, { reminders: [1, 2, 3, 4] })).status).toBe(400);
  });

  it('cambiar los recordatorios exige que sigan cumpliendo el tope y la ventana', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv, { starts_at: inH(3), reminders: [60] });
    const r = await call('PATCH', `/appointments/${a.id}`, T.carol, { reminders: [90, 30] });
    expect(r.status).toBe(200);
    expect((await json<Appt>(r)).reminder_offsets).toEqual([90, 30]);
    const closed = await mkConv({ lastInbound: new Date(Date.now() - 30 * HOUR) });
    const b = await mk(closed.conv, { starts_at: inH(5) });
    expect((await call('PATCH', `/appointments/${b.id}`, T.carol, { reminders: [60] })).status).toBe(400); // sin plantilla y fuera de la ventana
  });

  it('cancelar exige un motivo, cancela los recordatorios y la cita ya no se cambia; completar también cierra', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv, { reminders: [60, 10] });
    expect((await call('POST', `/appointments/${a.id}/cancel`, T.carol, {})).status).toBe(400);
    const r = await call('POST', `/appointments/${a.id}/cancel`, T.carol, { reason: 'El cliente no puede' });
    expect(r.status).toBe(200);
    expect(await json<Appt>(r)).toMatchObject({ status: 'cancelled', cancel_reason: 'El cliente no puede', can: { edit: false, cancel: false, complete: false } });
    expect((await reminderRows(a.id)).map((x) => [x.status, x.reason])).toEqual([['cancelled', 'appointment_cancelled'], ['cancelled', 'appointment_cancelled']]);
    expect(await code(await call('POST', `/appointments/${a.id}/cancel`, T.carol, { reason: 'otra vez' }))).toBe('APPOINTMENT_ALREADY_CANCELLED');
    expect(await code(await call('PATCH', `/appointments/${a.id}`, T.carol, { kind: 'x' }))).toBe('APPOINTMENT_CLOSED');
    expect(await code(await call('POST', `/appointments/${a.id}/complete`, T.carol))).toBe('APPOINTMENT_CLOSED');
    expect(await runReminders(new Date(Date.now() + 3 * HOUR))).toBe(0);

    const b = await mk((await mkConv()).conv, { reminders: [30] });
    const done = await call('POST', `/appointments/${b.id}/complete`, T.carol);
    expect(done.status).toBe(200);
    expect((await json<Appt>(done)).status).toBe('completed');
    expect((await reminderRows(b.id)).map((x) => x.status)).toEqual(['cancelled']);
    expect(await code(await call('POST', `/appointments/${b.id}/cancel`, T.carol, { reason: 'x' }))).toBe('APPOINTMENT_CLOSED');
  });
});

describe('agenda: quién ve qué y aislamiento A↔B', () => {
  it('la asesora ve las suyas; otra asesora, ninguna; el administrador, todas; el rango y los filtros funcionan', async () => {
    const [c1, c2] = [await mkConv(), await mkConv()];
    const a1 = await mk(c1.conv, { starts_at: inH(2) });
    const a2 = await mk(c2.conv, { starts_at: inH(30) });
    const ids = (r: { items: Appt[] }) => r.items.map((x) => x.id);
    const list = (q: string, token: string) => call('GET', `/appointments${q}`, token).then((r) => json<{ items: Appt[] }>(r));
    expect(ids(await list('', T.carol))).toEqual([a1.id, a2.id]);
    expect(ids(await list('', T.eve))).toEqual([]);
    expect(ids(await list(`?owner_id=${IDS.carol}`, T.eve))).toEqual([]); // el filtro no amplía lo que ve
    expect(ids(await list('', T.alice))).toEqual([a1.id, a2.id]);
    expect(ids(await list(`?to=${encodeURIComponent(inH(10))}`, T.alice))).toEqual([a1.id]);
    expect(ids(await list(`?owner_id=${IDS.eve}`, T.alice))).toEqual([]);
    expect(ids(await list(`?contact_id=${c2.contact}`, T.alice))).toEqual([a2.id]);
    await call('POST', `/appointments/${a1.id}/cancel`, T.carol, { reason: 'x' });
    expect(ids(await list('?status=cancelled', T.alice))).toEqual([a1.id]);
    expect(ids(await list('?status=scheduled', T.alice))).toEqual([a2.id]);
    expect((await call('GET', `/appointments?from=${encodeURIComponent(inH(5))}&to=${encodeURIComponent(inH(1))}`, T.alice)).status).toBe(400);
    expect((await call('GET', `/appointments?from=${encodeURIComponent(inH(0))}&to=${encodeURIComponent(inH(24 * 90))}`, T.alice)).status).toBe(400);
    expect((await call('GET', '/appointments?status=otro', T.alice)).status).toBe(400);
  });

  it('el detalle, la edición, la cancelación y completar una cita ajena o de otra empresa responden 404 uniforme', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv);
    for (const [token, who] of [[T.eve, 'eve'], [T.bob, 'bob']] as const) {
      expect((await call('GET', `/appointments/${a.id}`, token)).status, who).toBe(404);
      expect((await call('PATCH', `/appointments/${a.id}`, token, { kind: 'x' })).status, who).toBe(404);
      expect((await call('POST', `/appointments/${a.id}/cancel`, token, { reason: 'x' })).status, who).toBe(404);
      expect((await call('POST', `/appointments/${a.id}/complete`, token)).status, who).toBe(404);
    }
    expect((await call('GET', `/appointments/${randomUUID()}`, T.alice)).status).toBe(404);
    expect((await json<{ items: Appt[] }>(await call('GET', '/appointments', T.bob))).items).toEqual([]);
    expect((await get(a.id)).status).toBe('scheduled');
  });

  it('un administrador puede reprogramar y cancelar las de la asesora', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv);
    expect((await call('PATCH', `/appointments/${a.id}`, T.alice, { kind: 'Revisión' })).status).toBe(200);
    expect((await call('POST', `/appointments/${a.id}/cancel`, T.alice, { reason: 'Por el negocio' })).status).toBe(200);
  });

  it('sin sesión, 401', async () => {
    expect((await call('GET', '/appointments')).status).toBe(401);
    expect((await call('POST', '/appointments', undefined, {}, idem())).status).toBe(401);
  });
});

describe('base de datos', () => {
  const asApp = async <X,>(fn: (c: Client) => Promise<X>): Promise<X> => {
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  };

  it('la aplicación no puede borrar citas ni recordatorios; la RLS esconde los de otra empresa', async () => {
    const { conv } = await mkConv();
    await mk(conv, { reminders: [30] });
    await asApp(async (c) => {
      for (const t of ['appointments', 'appointment_reminders']) await expect(c.query(`DELETE FROM ${t}`), t).rejects.toThrow(/permission denied/);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      expect((await c.query(`SELECT count(*)::int n FROM appointments`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM appointment_reminders`)).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    });
  });

  it('la base rechaza lo que el servidor ya filtra: cancelada a medias, duración fuera de rango, recordatorio enviado sin mensaje, mismo «minutos antes» dos veces', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv, { reminders: [30] });
    await expect(admin.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [a.id])).rejects.toThrow(/appointments_cancel_consistent/);
    await expect(admin.query(`UPDATE appointments SET duration_minutes = 2 WHERE id = $1`, [a.id])).rejects.toThrow(/appointments_duration_valid/);
    await expect(admin.query(`UPDATE appointment_reminders SET status = 'sent', resolved_at = now() WHERE appointment_id = $1`, [a.id])).rejects.toThrow(/appointment_reminders_sent_complete/);
    await expect(admin.query(`INSERT INTO appointment_reminders(organization_id, id, appointment_id, offset_minutes, send_at) VALUES ($1, gen_random_uuid(), $2, 30, now())`, [ORG_A, a.id])).rejects.toThrow(/appointment_reminders_pending_uq/);
  });
});
