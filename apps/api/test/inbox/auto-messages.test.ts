// M5.5c — Mensajes automáticos de la cola: saludo, fuera de horario y finalizar por inactividad (ADR-07/50; F08). No agrega rutas: configura `PATCH /v1/queues/:id` (su
// aislamiento A↔B y permisos están en queues.test.ts; aquí se prueban los campos nuevos) y lo demás ocurre al llegar un mensaje y en la tarea periódica.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { ConversationsService, type NormalizedMessage } from '../../src/modules/conversations';
import { AutoCloseService, InboxModule, OutboundDispatcher, SlaSweepJob } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, OpportunitiesModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  frank: 'f1000000-0000-4000-8000-0000000000f2', // asesor de B
};
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);
const TZ = 'America/Guayaquil';
const GREETING = 'Hola, gracias por escribir a Barbería Norte.\n¿En qué podemos ayudarte?';
const OOH = 'Estamos fuera de horario. Te respondemos mañana desde las 08:30.';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
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
  const orgs: Array<[string, string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma', 'UTC'], [ORG_A, 'client', 'Barbería Norte', TZ], [ORG_B, 'client', 'Estudio Luna', 'UTC']];
  for (const [id, kind, name, tz] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, tz]);
  const users: Array<[string, string, string]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.frank, 'frank@b.test', 'Franco Díaz']];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.frank, ORG_B, 'advisor']];
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
async function connect(token: string, phoneId: string, name: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: '1234567890123', phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

type Week = Record<string, Array<[string, string]>>;
interface Queue { id: string; greeting: string | null; out_of_hours_message: string | null; auto_close_hours: number }
interface Conv { id: string; status: string; sla: { state: string } | null; last_message: { direction: string; preview: string } | null }
interface Msg { id: string; sender_type: string; direction: string; text: string | null; is_note: boolean; author: unknown; status: string }
interface List { items: Conv[] }

// ── horarios ─────────────────────────────────────────────────────────────────
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const FULL: Array<[string, string]> = [['00:00', '24:00']];
/** Guayaquil no tiene horario de verano: UTC−5 todo el año. */
const localDow = (): number => new Date(Date.now() - 5 * HOUR).getUTCDay();
const allDay = (): Week => Object.fromEntries(DAYS.map((d) => [d, FULL]));
/** Abierta todos los días MENOS hoy: «ahora» está cerrada. */
const closedToday = (): Week => Object.fromEntries(DAYS.filter((_, i) => i !== localDow()).map((d) => [d, FULL]));
const putHours = async (days: Week | null) => ok(await call('PUT', '/sla/hours', T.alice, { days }));

// ── colas ────────────────────────────────────────────────────────────────────
const patchQueue = async (id: string, body: Record<string, unknown>, token = T.alice): Promise<Queue> => ok<Queue>(await call('PATCH', `/queues/${id}`, token, body));
/** Una cola de A con reparto encendido, los tres asesores y la conexión de A apuntando a ella; con los mensajes indicados. */
async function readyQueue(over: Record<string, unknown> = {}): Promise<string> {
  const q = await ok<Queue>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
  await patchQueue(q.id, { distribution_on: true, ...over });
  await ok(await call('PUT', `/queues/${q.id}/members`, T.alice, { members: [IDS.alice, IDS.carol, IDS.eve].map((user_id) => ({ user_id, active: true, weight: 1 })) }));
  await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: q.id }));
  return q.id;
}

// ── mensajes que entran ──────────────────────────────────────────────────────
const phone = (n: number): string => `+59398400${String(n).padStart(4, '0')}`;
const msg = (from: string, id: string, sentAt: Date = new Date()): NormalizedMessage => ({ externalId: id, from, fromRaw: from.slice(1), profileName: null, kind: 'text', text: 'Hola, ¿tienen cita?', media: null, extra: {}, sentAt });
/** Entra un mensaje del cliente por la conexión de la empresa indicada: lo que hace la tarea que procesa los avisos de Meta. */
async function ingest(from: string, id: string, o: { org?: string; sentAt?: Date } = {}): Promise<void> {
  const org = o.org ?? ORG_A;
  const channel = org === ORG_B ? channelB : channelA;
  await TenantContext.run({ organizationId: org }, async () => {
    const dir = await app.get(OrgDirectoryService).current({ fresh: true });
    const ctx = { now: new Date(), timeZone: dir.timeZone, assignable: dir.assignable };
    await app.get(Database).withTenant((tx) => app.get(ConversationsService).ingestInbound(tx, channel, msg(from, id, o.sentAt), ctx));
  });
}
/** El despachador envía lo que está en cola de la empresa (lo que hace la tarea de envío). */
const dispatch = (org = ORG_A): Promise<number> => TenantContext.run({ organizationId: org }, () => app.get(OutboundDispatcher).runDue(new Date(Date.now() + 5_000)));
const autoClose = (org = ORG_A, ahead = 0): Promise<number> => TenantContext.run({ organizationId: org }, () => app.get(AutoCloseService).runDue(new Date(Date.now() + ahead)));

interface MsgRow { kind: string; sender_type: string; direction: string; body: string | null; status: string; meta: Record<string, unknown>; created_by: string | null; sent_at: Date; error: string | null }
const msgsOf = async (conv: string): Promise<MsgRow[]> => (await admin.query(`SELECT kind, sender_type, direction, body, status, meta, created_by, sent_at, error FROM messages WHERE conversation_id = $1 ORDER BY sent_at, id`, [conv])).rows as MsgRow[];
const autoMsgs = async (conv: string): Promise<MsgRow[]> => (await msgsOf(conv)).filter((m) => m.sender_type === 'automation');
const noteTexts = async (conv: string): Promise<string[]> => (await msgsOf(conv)).filter((m) => m.kind === 'note').map((m) => m.body ?? '');
interface ConvRow { id: string; status: string; owner_id: string | null; queue_id: string | null; unread_count: number; last_message_at: Date | null; last_inbound_at: Date | null; out_of_hours_notice_at: Date | null; closed_at: Date | null }
const convs = async (org = ORG_A): Promise<ConvRow[]> => (await admin.query(`SELECT * FROM conversations WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as ConvRow[];
const onlyConv = async (): Promise<ConvRow> => (await convs())[0]!;
const audits = async (entityId: string) => (await admin.query(`SELECT field, old_value, new_value, source FROM audit_logs WHERE entity_id = $1 ORDER BY at, id`, [entityId])).rows as Array<{ field: string | null; old_value: unknown; new_value: unknown; source: string }>;
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;
const thread = async (token: string, id: string): Promise<Msg[]> => (await ok<{ items: Msg[] }>(await call('GET', `/conversations/${id}/messages`, token))).items;

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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte');
  fake().outbox.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('configuración de la cola', () => {
  it('guarda los textos limpios (recorta, normaliza saltos de línea; vacío = apagado), los devuelve en la cola y los audita', async () => {
    const q = await ok<Queue>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
    expect(q).toMatchObject({ greeting: null, out_of_hours_message: null, auto_close_hours: 0 });
    const r = await patchQueue(q.id, { greeting: '  Hola, gracias por escribir a Barbería Norte.\r\n¿En qué podemos ayudarte?  ', out_of_hours_message: OOH, auto_close_hours: 24 });
    expect(r).toMatchObject({ greeting: GREETING, out_of_hours_message: OOH, auto_close_hours: 24 });
    expect((await patchQueue(q.id, { greeting: '   ' })).greeting).toBeNull(); // solo espacios = apagado
    expect((await patchQueue(q.id, { out_of_hours_message: null })).out_of_hours_message).toBeNull();
    expect((await patchQueue(q.id, { greeting: GREETING })).greeting).toBe(GREETING);
    await patchQueue(q.id, { greeting: GREETING }); // igual: sin rastro
    const changes = (await audits(q.id)).filter((a) => a.field !== null).map((a) => [a.field, a.old_value, a.new_value, a.source]);
    expect(changes).toEqual([
      ['greeting', null, GREETING, 'manual'],
      ['out_of_hours_message', null, OOH, 'manual'],
      ['auto_close_hours', 0, 24, 'manual'],
      ['greeting', GREETING, null, 'manual'],
      ['out_of_hours_message', OOH, null, 'manual'],
      ['greeting', null, GREETING, 'manual'],
    ]);
    expect((await ok<{ items: Queue[] }>(await call('GET', '/queues', T.alice))).items[0]).toMatchObject({ greeting: GREETING, out_of_hours_message: null, auto_close_hours: 24 });
  });

  it('valida: hasta 1000 caracteres, sin caracteres de control, horas enteras de 0 a 720, sin campos de más; los límites exactos sí valen', async () => {
    const q = await ok<Queue>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
    const bad = async (b: Record<string, unknown>, label: string) => expect((await call('PATCH', `/queues/${q.id}`, T.alice, b)).status, label).toBe(400);
    await bad({ greeting: 'x'.repeat(1001) }, 'saludo de 1001');
    await bad({ out_of_hours_message: 'x'.repeat(1001) }, 'fuera de horario de 1001');
    await bad({ greeting: 'a\u0007b' }, 'carácter de control');
    await bad({ greeting: 123 }, 'número');
    await bad({ auto_close_hours: 721 }, '721 h');
    await bad({ auto_close_hours: -1 }, 'negativo');
    await bad({ auto_close_hours: 1.5 }, 'decimal');
    await bad({ auto_close_hours: '24' }, 'texto');
    await bad({ saludo: 'x' }, 'campo desconocido');
    expect(await patchQueue(q.id, { greeting: 'x'.repeat(1000), out_of_hours_message: 'y'.repeat(1000), auto_close_hours: 720 })).toMatchObject({ auto_close_hours: 720 });
    expect((await patchQueue(q.id, { greeting: 'Línea 1\nLínea 2\tcon tabulación' })).greeting).toBe('Línea 1\nLínea 2\tcon tabulación');
    expect((await admin.query(`SELECT greeting_text FROM queues WHERE id = $1`, [q.id])).rows[0].greeting_text).toBe('Línea 1\nLínea 2\tcon tabulación');
  });

  it('solo quien administra colas los cambia (el asesor 403) y otra empresa no puede tocar la cola (404, nada cambia)', async () => {
    const q = await ok<Queue>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
    await patchQueue(q.id, { greeting: GREETING });
    expect((await call('PATCH', `/queues/${q.id}`, T.carol, { greeting: 'otro' })).status).toBe(403);
    expect((await call('PATCH', `/queues/${q.id}`, undefined, { greeting: 'otro' })).status).toBe(401);
    expect((await call('PATCH', `/queues/${q.id}`, T.bob, { greeting: 'robado', auto_close_hours: 1 })).status).toBe(404);
    expect((await admin.query(`SELECT greeting_text, auto_close_hours FROM queues WHERE id = $1`, [q.id])).rows[0]).toEqual({ greeting_text: GREETING, auto_close_hours: 0 });
  });

  it('la base impide textos vacíos o demasiado largos y horas fuera de rango', async () => {
    const q = await ok<Queue>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
    await expect(admin.query(`UPDATE queues SET greeting_text = '   ' WHERE id = $1`, [q.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE queues SET out_of_hours_text = repeat('x', 1001) WHERE id = $1`, [q.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE queues SET auto_close_hours = 721 WHERE id = $1`, [q.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE queues SET auto_close_hours = -1 WHERE id = $1`, [q.id])).rejects.toMatchObject({ code: '23514' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('saludo', () => {
  it('al abrir una conversación nueva sale el saludo de la cola como mensaje automático: queda después del mensaje del cliente, el despachador lo envía y NO cuenta como respuesta humana', async () => {
    await readyQueue({ greeting: GREETING });
    await ingest(phone(1), 'wamid.1');
    const c = await onlyConv();
    const before = await msgsOf(c.id);
    expect(before.map((m) => [m.direction, m.sender_type, m.status])).toEqual([['in', 'contact', 'received'], ['out', 'automation', 'queued']]);
    expect(before[1]).toMatchObject({ kind: 'text', body: GREETING, created_by: null, meta: { auto: 'greeting' } });
    expect(before[1]!.sent_at.getTime()).toBeGreaterThan(before[0]!.sent_at.getTime());
    // lo envía el mismo despachador que los mensajes de las personas
    expect(await dispatch()).toBe(1);
    expect(fake().outbox.map((o) => [o.to, o.text])).toEqual([[phone(1).slice(1), GREETING]]);
    expect((await autoMsgs(c.id))[0]).toMatchObject({ status: 'sent' });
    // no es una respuesta humana: la conversación sigue pendiente, sin leer, con su cronómetro de primera respuesta corriendo
    const after = await onlyConv();
    expect(after).toMatchObject({ status: 'pending', unread_count: 1 });
    expect(after.last_message_at).toEqual(c.last_message_at);
    expect(await admin.query(`SELECT stopped_at, stop_reason FROM response_timers WHERE conversation_id = $1`, [c.id]).then((r) => r.rows)).toEqual([{ stopped_at: null, stop_reason: null }]);
    const view = await ok<Conv>(await call('GET', `/conversations/${c.id}`, T.alice));
    expect(view.sla).toMatchObject({ kind: 'first', state: 'ok' });
    // el listado muestra el último mensaje REAL (el del cliente), no el automático
    const list = await ok<List>(await call('GET', '/conversations?tab=pending', T.alice));
    expect(list.items[0]!.last_message).toMatchObject({ direction: 'in', preview: 'Hola, ¿tienen cita?' });
    // en el hilo se reconoce como automático
    const t = await thread(T.alice, c.id);
    expect(t.at(-1)).toMatchObject({ sender_type: 'automation', direction: 'out', text: GREETING, is_note: false, author: null });
  });

  it('se saluda UNA vez: los mensajes siguientes de la misma conversación no repiten el saludo; tras finalizarla, la conversación nueva sí', async () => {
    await readyQueue({ greeting: GREETING });
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(1), 'wamid.2');
    await ingest(phone(1), 'wamid.3');
    const c = await onlyConv();
    expect(await autoMsgs(c.id)).toHaveLength(1);
    await ok(await call('POST', `/conversations/${c.id}/close`, T.alice));
    await ingest(phone(1), 'wamid.4');
    const all = await convs();
    expect(all).toHaveLength(2);
    expect(await autoMsgs(all[1]!.id)).toHaveLength(1);
    expect(await autoMsgs(all[0]!.id)).toHaveLength(1);
  });

  it('un aviso repetido del proveedor no repite el saludo', async () => {
    await readyQueue({ greeting: GREETING });
    await ingest(phone(1), 'wamid.1');
    await ingest(phone(1), 'wamid.1');
    expect(await autoMsgs((await onlyConv()).id)).toHaveLength(1);
  });

  it('no sale nada si la cola no tiene saludo, si la conversación no tiene cola, si la cola es de otra empresa o si la conexión está desactivada', async () => {
    // sin saludo configurado
    const q = await readyQueue();
    await ingest(phone(1), 'wamid.1');
    expect(await autoMsgs((await onlyConv()).id)).toEqual([]);
    // conexión desactivada: ni siquiera se encola (no quedaría un mensaje «fallido» por nada)
    await patchQueue(q, { greeting: GREETING });
    await admin.query(`UPDATE channel_accounts SET status = 'disabled' WHERE id = $1`, [channelA]);
    await ingest(phone(2), 'wamid.2');
    expect(await autoMsgs((await convs())[1]!.id)).toEqual([]);
    await admin.query(`UPDATE channel_accounts SET status = 'active' WHERE id = $1`, [channelA]);
    // sin cola: la conexión no apunta a ninguna
    await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: null }));
    await ingest(phone(3), 'wamid.3');
    const third = (await convs())[2]!;
    expect(third.queue_id).toBeNull();
    expect(await autoMsgs(third.id)).toEqual([]);
    // el saludo de la cola de A no sale por la conexión de B
    await ingest(phone(4), 'wamid.4', { org: ORG_B });
    const b = (await convs(ORG_B))[0]!;
    expect(await autoMsgs(b.id)).toEqual([]);
    expect(await dispatch(ORG_B)).toBe(0);
  });

  it('no saluda a quien escribió hace más de una hora (un aviso que llegó con mucho retraso)', async () => {
    await readyQueue({ greeting: GREETING });
    await ingest(phone(1), 'wamid.1', { sentAt: ago(2 * HOUR) });
    expect(await autoMsgs((await onlyConv()).id)).toEqual([]);
    await ingest(phone(2), 'wamid.2', { sentAt: ago(30 * MIN) }); // media hora de retraso todavía se saluda
    expect(await autoMsgs((await convs())[1]!.id)).toHaveLength(1);
  });

  it('si el proveedor lo rechaza, el mensaje queda «fallido» a la vista y la conversación no cambia', async () => {
    await readyQueue({ greeting: '[fallar:rechazo] Hola' });
    await ingest(phone(1), 'wamid.1');
    const c = await onlyConv();
    expect(await dispatch()).toBe(1);
    const [m] = await autoMsgs(c.id);
    expect(m).toMatchObject({ status: 'failed' });
    expect(m!.error).toBeTruthy();
    expect(await onlyConv()).toMatchObject({ status: 'pending', unread_count: 1 });
    expect(fake().outbox).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('fuera de horario', () => {
  it('con la cola cerrada sale el aviso (y no el saludo); no se repite mientras siga cerrada; si la cola abrió entre un mensaje y otro, vuelve a avisar', async () => {
    await readyQueue({ greeting: GREETING, out_of_hours_message: OOH });
    await putHours(closedToday());
    await ingest(phone(1), 'wamid.1');
    const c = await onlyConv();
    expect((await autoMsgs(c.id)).map((m) => [m.body, m.meta['auto']])).toEqual([[OOH, 'out_of_hours']]);
    expect((await onlyConv()).out_of_hours_notice_at).not.toBeNull();
    expect(await dispatch()).toBe(1);
    expect(fake().outbox.map((o) => o.text)).toEqual([OOH]);
    await ingest(phone(1), 'wamid.2'); // sigue cerrada: no hay otro aviso
    expect(await autoMsgs(c.id)).toHaveLength(1);
    // «ayer» la cola estuvo abierta: se avisó hace 36 h, así que desde entonces hubo horario abierto
    await admin.query(`UPDATE conversations SET out_of_hours_notice_at = now() - interval '36 hours' WHERE id = $1`, [c.id]);
    await ingest(phone(1), 'wamid.3');
    expect((await autoMsgs(c.id)).map((m) => m.meta['auto'])).toEqual(['out_of_hours', 'out_of_hours']);
  });

  it('con la cola abierta, el fuera de horario no sale (tampoco en una conversación que ya existía); con ella cerrada también sale en una conversación existente', async () => {
    await readyQueue({ out_of_hours_message: OOH });
    await ingest(phone(1), 'wamid.1');
    const c = await onlyConv();
    await ingest(phone(1), 'wamid.2');
    expect(await autoMsgs(c.id)).toEqual([]);
    await putHours(closedToday()); // la cola cierra
    await ingest(phone(1), 'wamid.3');
    expect((await autoMsgs(c.id)).map((m) => m.body)).toEqual([OOH]);
  });

  it('sin aviso configurado, la cola cerrada saluda igual a quien abre una conversación (el saludo es el mensaje por omisión); sin ninguno de los dos no sale nada', async () => {
    const q = await readyQueue({ greeting: GREETING });
    await putHours(closedToday());
    await ingest(phone(1), 'wamid.1');
    expect((await autoMsgs((await onlyConv()).id)).map((m) => m.meta['auto'])).toEqual(['greeting']);
    await patchQueue(q, { greeting: null });
    await ingest(phone(2), 'wamid.2');
    expect(await autoMsgs((await convs())[1]!.id)).toEqual([]);
  });

  it('manda el horario propio de la cola, y también un feriado de hoy', async () => {
    const q = await readyQueue({ out_of_hours_message: OOH });
    await putHours(allDay()); // la empresa abre siempre…
    await ok(await call('PUT', `/queues/${q}/hours`, T.alice, { days: closedToday() })); // …pero la cola cierra hoy
    await ingest(phone(1), 'wamid.1');
    expect((await autoMsgs((await onlyConv()).id)).map((m) => m.body)).toEqual([OOH]);
    await ok(await call('PUT', `/queues/${q}/hours`, T.alice, { days: null })); // vuelve al de la empresa: abierta
    await ingest(phone(2), 'wamid.2');
    expect(await autoMsgs((await convs())[1]!.id)).toEqual([]);
    // feriado de hoy (fecha local de la empresa)
    const today = new Date(Date.now() - 5 * HOUR).toISOString().slice(0, 10);
    await ok(await call('POST', '/sla/holidays', T.alice, { date: today, name: 'Hoy no atendemos' }), 201);
    await ingest(phone(3), 'wamid.3');
    expect((await autoMsgs((await convs())[2]!.id)).map((m) => m.body)).toEqual([OOH]);
  });

  it('con «respetar el horario» y la cola cerrada, la conversación espera sin asignar y el cliente recibe el aviso', async () => {
    await readyQueue({ respect_hours: true, out_of_hours_message: OOH });
    await putHours(closedToday());
    await ingest(phone(1), 'wamid.1');
    const c = await onlyConv();
    expect(c).toMatchObject({ status: 'unassigned', owner_id: null });
    expect((await autoMsgs(c.id)).map((m) => m.body)).toEqual([OOH]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('finalizar por inactividad', () => {
  const waiting = async (hoursAgo: number, over: { status?: string; org?: string; queue: string | null }): Promise<string> => {
    const org = over.org ?? ORG_A;
    const channel = org === ORG_B ? channelB : channelA;
    const owner = org === ORG_B ? IDS.frank : IDS.carol;
    const status = over.status ?? 'waiting';
    const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente', $2) RETURNING id`, [org, status === 'unassigned' ? null : owner])).rows[0].id as string;
    const id = (
      await admin.query(
        `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, queue_id, last_message_at, last_inbound_at, unread_count, peer_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $8, 1, $9) RETURNING id`,
        [org, contact, channel, status, status === 'unassigned' ? null : owner, status === 'unassigned' ? null : new Date(), over.queue, ago(hoursAgo * HOUR), `5939849${Math.floor(Math.random() * 1e5)}`],
      )
    ).rows[0].id as string;
    await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'out', 'human', 'text', 'Te escribo luego', 'sent', $5)`, [org, id, channel, `wamid.W${randomBytes(4).toString('hex')}`, ago(hoursAgo * HOUR)]);
    return id;
  };
  const row = async (id: string) => (await admin.query(`SELECT status, closed_at, unread_count FROM conversations WHERE id = $1`, [id])).rows[0] as { status: string; closed_at: Date | null; unread_count: number };

  it('finaliza la conversación «esperando al cliente» que pasó las horas de su cola: nota interna, auditoría automática, cronómetros detenidos y nada sale al cliente', async () => {
    const q = await readyQueue({ auto_close_hours: 24 });
    const id = await waiting(25, { queue: q });
    await admin.query(`INSERT INTO response_timers(id, organization_id, conversation_id, kind, owner_id, started_at, due_at) VALUES (gen_random_uuid(), $1, $2, 'followup', $3, now() - interval '25 hours', now() - interval '24 hours')`, [ORG_A, id, IDS.carol]);
    expect(await autoClose()).toBe(1);
    expect(await row(id)).toMatchObject({ status: 'closed', unread_count: 0 });
    expect((await row(id)).closed_at).not.toBeNull();
    expect(await noteTexts(id)).toEqual(['Finalizada automáticamente: pasaron 24 h sin mensajes del cliente después de la última respuesta.']);
    expect((await audits(id)).filter((a) => a.field === 'status').map((a) => [a.old_value, a.new_value, a.source])).toEqual([['waiting', 'closed', 'automation']]);
    expect((await admin.query(`SELECT stop_reason FROM response_timers WHERE conversation_id = $1`, [id])).rows).toEqual([{ stop_reason: 'closed' }]);
    expect(await dispatch()).toBe(0);
    expect(fake().outbox).toEqual([]);
    expect(await autoClose()).toBe(0); // ya no hay nada más
    // aparece en «Finalizadas»
    const closed = await ok<{ items: Conv[] }>(await call('GET', '/conversations?tab=closed', T.alice));
    expect(closed.items.map((c) => c.id)).toEqual([id]);
  });

  it('solo las «esperando al cliente»: las que el cliente espera que la empresa conteste (pendientes, trabajando, sin asignar) no se finalizan por mucho que pase', async () => {
    const q = await readyQueue({ auto_close_hours: 24 });
    const ids = {
      pending: await waiting(100, { queue: q, status: 'pending' }),
      working: await waiting(100, { queue: q, status: 'working' }),
      unassigned: await waiting(100, { queue: q, status: 'unassigned' }),
      recent: await waiting(23, { queue: q }),
    };
    expect(await autoClose()).toBe(0);
    for (const [k, id] of Object.entries(ids)) expect((await row(id)).status, k).not.toBe('closed');
    // cumplidas las horas, la «reciente» sí
    expect(await autoClose(ORG_A, 2 * HOUR)).toBe(1);
    expect((await row(ids.recent)).status).toBe('closed');
    expect((await row(ids.pending)).status).toBe('pending');
  });

  it('sin horas configuradas (0), sin cola o con la cola archivada no se finaliza nada', async () => {
    const q = await readyQueue({ auto_close_hours: 0 });
    const off = await waiting(500, { queue: q });
    const noQueue = await waiting(500, { queue: null });
    expect(await autoClose()).toBe(0);
    expect((await row(off)).status).toBe('waiting');
    expect((await row(noQueue)).status).toBe('waiting');
    await patchQueue(q, { auto_close_hours: 24 });
    await admin.query(`UPDATE queues SET deleted_at = now() WHERE id = $1`, [q]);
    expect(await autoClose()).toBe(0);
    expect((await row(off)).status).toBe('waiting');
  });

  it('los mensajes automáticos y las notas NO posponen el cierre: la última actividad es la última respuesta real', async () => {
    const q = await readyQueue({ auto_close_hours: 24, greeting: GREETING });
    const id = await waiting(25, { queue: q });
    await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'automation', 'text', 'Hola', 'sent', now())`, [ORG_A, id, channelA]);
    await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at, created_by) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', 'note', 'Nota', 'internal', now(), $4)`, [ORG_A, id, channelA, IDS.carol]);
    expect(await autoClose()).toBe(1);
    expect((await row(id)).status).toBe('closed');
  });

  it('cuando el cliente vuelve a escribir tras el cierre se abre otra conversación (y se le saluda)', async () => {
    const q = await readyQueue({ auto_close_hours: 24, greeting: GREETING });
    await ingest(phone(1), 'wamid.1');
    const first = await onlyConv();
    await admin.query(`UPDATE conversations SET status = 'waiting', last_message_at = now() - interval '30 hours', owner_id = $2, assigned_at = now() WHERE id = $1`, [first.id, IDS.alice]);
    expect(await autoClose()).toBe(1);
    await ingest(phone(1), 'wamid.2');
    const all = await convs();
    expect(all.map((c) => c.status)).toEqual(['closed', 'pending']);
    expect(await autoMsgs(all[1]!.id)).toHaveLength(1);
    expect(q).toBeTruthy();
  });

  it('cada empresa finaliza lo suyo: una pasada de A no toca las conversaciones de B (y B sí las suyas)', async () => {
    const qa = await readyQueue({ auto_close_hours: 24 });
    const qb = (await ok<Queue>(await call('POST', '/queues', T.bob, { name: 'Soporte' }), 201)).id;
    await patchQueue(qb, { auto_close_hours: 24 }, T.bob);
    const a = await waiting(30, { queue: qa });
    const b = await waiting(30, { queue: qb, org: ORG_B });
    expect(await autoClose(ORG_A)).toBe(1);
    expect(await row(a)).toMatchObject({ status: 'closed' });
    expect(await row(b)).toMatchObject({ status: 'waiting' });
    expect(await autoClose(ORG_B)).toBe(1);
    expect(await row(b)).toMatchObject({ status: 'closed' });
    expect(await noteTexts(b)).toHaveLength(1);
  });

  it('dos pasadas a la vez finalizan una sola vez; y la tarea periódica del SLA también finaliza (cuenta lo que tocó)', async () => {
    const q = await readyQueue({ auto_close_hours: 24 });
    const id = await waiting(30, { queue: q });
    const both = await Promise.all([autoClose(), autoClose()]);
    expect(both.reduce((x, y) => x + y, 0)).toBe(1);
    expect(await noteTexts(id)).toHaveLength(1);
    const again = await waiting(30, { queue: q });
    expect(await app.get(SlaSweepJob).run(new Date())).toBeGreaterThanOrEqual(1);
    expect((await row(again)).status).toBe('closed');
  });
});
