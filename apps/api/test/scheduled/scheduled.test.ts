// M5.6c — Mensajes programados (ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/conversations/:id/scheduled
//   POST /v1/conversations/:id/scheduled
//   DELETE /v1/conversations/:id/scheduled/:scheduledId
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
import { InboxModule, ScheduledMessagesJob, ScheduledMessagesService, MAX_PENDING_PER_CONVERSATION } from '../../src/modules/inbox';
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
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);
const inMs = (ms: number): string => new Date(Date.now() + ms).toISOString();

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob' | 'root', string>;
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
  await admin.query('TRUNCATE scheduled_messages, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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

interface Sch { id: string; text: string; send_at: string; status: 'scheduled' | 'sent' | 'cancelled' | 'failed'; reason: string | null; created_at: string; resolved_at: string | null; author: { id: string; name: string }; mine: boolean; can_cancel: boolean }

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
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;
const schedule = (token: string, conv: string, body: unknown) => call('POST', `/conversations/${conv}/scheduled`, token, body);
const mk = async (token: string, conv: string, text = 'Te escribo más tarde', afterMs = 10 * MIN): Promise<Sch> => ok<Sch>(await schedule(token, conv, { text, send_at: inMs(afterMs) }), 201);
const list = async (token: string, conv: string): Promise<Sch[]> => (await ok<{ items: Sch[] }>(await call('GET', `/conversations/${conv}/scheduled`, token))).items;
/** Hace que un pendiente ya haya llegado a su hora (la API no deja programar en el pasado). */
const makeDue = (id: string) => admin.query(`UPDATE scheduled_messages SET send_at = now() - interval '5 seconds', created_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
const runDue = async (org = ORG_A, now = new Date()): Promise<number> =>
  TenantContext.run({ organizationId: org }, async () => app.get(ScheduledMessagesService).runDue(now, await app.get(OrgDirectoryService).current({ fresh: true })));
/** Un mensaje del cliente que acaba de llegar. */
const inbound = async (conv: string) => {
  await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) SELECT gen_random_uuid(), organization_id, id, channel_account_id, 'in', 'contact', 'text', 'Hola', 'received', now() FROM conversations WHERE id = $1`, [conv]);
  await admin.query(`UPDATE conversations SET last_inbound_at = now() WHERE id = $1`, [conv]);
};
const row = async (id: string) => (await admin.query(`SELECT status, reason, message_id FROM scheduled_messages WHERE id = $1`, [id])).rows[0] as { status: string; reason: string | null; message_id: string | null };
const msgs = async (conv: string) => (await admin.query(`SELECT kind, sender_type, body, status, created_by FROM messages WHERE conversation_id = $1 AND kind <> 'note' ORDER BY sent_at, id`, [conv])).rows as Array<{ kind: string; sender_type: string; body: string; status: string; created_by: string | null }>;
const convStatus = async (id: string) => (await admin.query('SELECT status FROM conversations WHERE id = $1', [id])).rows[0].status as string;
const audit = async (entity: string, id: string) => (await admin.query(`SELECT field, new_value FROM audit_logs WHERE entity_type = $1 AND entity_id = $2 ORDER BY at, id`, [entity, id])).rows as Array<{ field: string | null; new_value: unknown }>;

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
});

// ═════════════════════════════════════════════════════════════════════════════
describe('permisos y aislamiento', () => {
  it('sin sesión 401; la plataforma 403', async () => {
    const conv = await mkConv();
    const routes: Array<[string, string, unknown?]> = [['GET', `/conversations/${conv}/scheduled`], ['POST', `/conversations/${conv}/scheduled`, { text: 'x', send_at: inMs(HOUR) }], ['DELETE', `/conversations/${conv}/scheduled/${NOBODY}`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('A↔B: nadie programa, ve ni cancela en conversaciones de otra empresa (404) y cada empresa ve solo lo suyo', async () => {
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const a = await mk(T.carol, convA);
    expect((await schedule(T.bob, convA, { text: 'hola', send_at: inMs(HOUR) })).status).toBe(404);
    expect((await call('GET', `/conversations/${convA}/scheduled`, T.bob)).status).toBe(404);
    expect((await call('DELETE', `/conversations/${convA}/scheduled/${a.id}`, T.bob)).status).toBe(404);
    expect((await schedule(T.alice, convB, { text: 'hola', send_at: inMs(HOUR) })).status).toBe(404);
    // el id de A no sirve en una conversación de B, ni a su dueño
    expect((await call('DELETE', `/conversations/${convB}/scheduled/${a.id}`, T.bob)).status).toBe(404);
    const b = await mk(T.bob, convB, 'Mensaje de B');
    expect((await list(T.bob, convB)).map((x) => x.id)).toEqual([b.id]);
    expect((await list(T.carol, convA)).map((x) => x.id)).toEqual([a.id]);
    expect((await row(a.id)).status).toBe('scheduled');
  });

  it('quien no ve la conversación recibe 404; el administrador (ve todo) la ve pero no puede programar en una ajena (409/403 con motivo)', async () => {
    const conv = await mkConv(); // de Carolina
    expect((await call('GET', `/conversations/${conv}/scheduled`, T.eve)).status).toBe(404);
    expect((await schedule(T.eve, conv, { text: 'hola', send_at: inMs(HOUR) })).status).toBe(404);
    await mk(T.carol, conv);
    expect((await list(T.alice, conv)).length).toBe(1); // ve todas las conversaciones
    const r = await schedule(T.alice, conv, { text: 'hola', send_at: inMs(HOUR) });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('NOT_OWNER');
  });

  it('un colaborador que solo ve y deja notas ve los pendientes pero no programa (403) ni cancela; con permiso de responder programa y ve los de los demás', async () => {
    const conv = await mkConv();
    const mine = await mk(T.carol, conv);
    await ok(await call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.eve, permission: 'view' }));
    expect((await list(T.eve, conv)).map((x) => ({ id: x.id, mine: x.mine, can_cancel: x.can_cancel }))).toEqual([{ id: mine.id, mine: false, can_cancel: false }]);
    expect(await code(await schedule(T.eve, conv, { text: 'hola', send_at: inMs(HOUR) }))).toBe('NOT_OWNER');
    expect((await call('DELETE', `/conversations/${conv}/scheduled/${mine.id}`, T.eve)).status).toBe(403);
    await ok(await call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.eve, permission: 'reply' }));
    const evas = await mk(T.eve, conv, 'De Eva');
    expect(evas.author.name).toBe('Eva Mora');
    expect((await list(T.carol, conv)).map((x) => x.mine)).toEqual([true, false]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('programar', () => {
  it('guarda el mensaje con su hora y quién lo dejó, y lo audita sin guardar el texto', async () => {
    const conv = await mkConv();
    const at = inMs(30 * MIN);
    const s = await ok<Sch>(await schedule(T.carol, conv, { text: '  Hola, ¿sigues interesada?  ', send_at: at }), 201);
    expect(s).toMatchObject({ text: 'Hola, ¿sigues interesada?', status: 'scheduled', reason: null, resolved_at: null, mine: true, can_cancel: true, author: { id: IDS.carol, name: 'Carolina Vera' } });
    expect(new Date(s.send_at).getTime()).toBe(new Date(at).getTime());
    const rows = await audit('scheduled_message', s.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('sigues interesada');
    expect((await msgs(conv)).length).toBe(0); // todavía no sale nada
  });

  it('valida: hora futura (≥1 min), dentro de la ventana de 24 h (con 1 min de margen), texto y campos', async () => {
    const conv = await mkConv({ lastInbound: ago(23 * HOUR) }); // la ventana cierra en 1 h
    for (const send_at of [inMs(-HOUR), inMs(20_000), new Date(Date.now() - 1).toISOString()]) {
      const r = await schedule(T.carol, conv, { text: 'hola', send_at });
      expect(r.status, send_at).toBe(400);
      expect((await json<{ error: { details: Array<{ path: string; code: string }> } }>(r)).error.details[0]).toMatchObject({ path: 'send_at', code: 'too_soon' });
    }
    const late = await schedule(T.carol, conv, { text: 'hola', send_at: inMs(2 * HOUR) });
    expect(late.status).toBe(409);
    expect(await code(late)).toBe('SCHEDULE_OUTSIDE_WINDOW');
    expect((await schedule(T.carol, conv, { text: 'hola', send_at: inMs(HOUR - 2 * MIN) })).status).toBe(201); // justo antes del cierre menos el margen
    expect((await schedule(T.carol, conv, { text: 'hola', send_at: inMs(HOUR - 30_000) })).status).toBe(409); // dentro del margen
    for (const body of [{ text: '', send_at: inMs(10 * MIN) }, { text: '   ', send_at: inMs(10 * MIN) }, { text: 'x'.repeat(4097), send_at: inMs(10 * MIN) }, { text: 'hola', send_at: 'mañana' }, { text: 'hola', send_at: '2030-01-01T10:00:00' }, { text: 'hola' }, { send_at: inMs(10 * MIN) }, { text: 'hola', send_at: inMs(10 * MIN), user: 'x' }]) {
      expect((await schedule(T.carol, conv, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('con la ventana cerrada no se programa texto (409 WINDOW_CLOSED); tampoco en una conversación sin asesor, finalizada o con la conexión desactivada', async () => {
    const closedWindow = await mkConv({ lastInbound: ago(25 * HOUR) });
    const never = await mkConv({ lastInbound: null });
    expect(await code(await schedule(T.carol, closedWindow, { text: 'hola', send_at: inMs(HOUR) }))).toBe('WINDOW_CLOSED');
    expect(await code(await schedule(T.carol, never, { text: 'hola', send_at: inMs(HOUR) }))).toBe('WINDOW_CLOSED');
    const unassigned = await mkConv({ owner: null });
    expect(await code(await schedule(T.alice, unassigned, { text: 'hola', send_at: inMs(HOUR) }))).toBe('CONVERSATION_UNASSIGNED');
    const finished = await mkConv({ status: 'closed' });
    expect(await code(await schedule(T.carol, finished, { text: 'hola', send_at: inMs(HOUR) }))).toBe('CONVERSATION_CLOSED');
    const live = await mkConv();
    await admin.query(`UPDATE channel_accounts SET status = 'disabled' WHERE id = $1`, [channelA]);
    expect(await code(await schedule(T.carol, live, { text: 'hola', send_at: inMs(HOUR) }))).toBe('CHANNEL_DISABLED');
  });

  it(`hay un máximo de ${MAX_PENDING_PER_CONVERSATION} pendientes por conversación (409 SCHEDULE_LIMIT); cancelar uno deja programar otro`, async () => {
    const conv = await mkConv();
    const made: Sch[] = [];
    for (let i = 0; i < MAX_PENDING_PER_CONVERSATION; i++) made.push(await mk(T.carol, conv, `Mensaje ${i}`, (10 + i) * MIN));
    expect(await code(await schedule(T.carol, conv, { text: 'uno más', send_at: inMs(HOUR) }))).toBe('SCHEDULE_LIMIT');
    expect((await mk(T.carol, await mkConv())).status).toBe('scheduled'); // otra conversación no cuenta
    await ok(await call('DELETE', `/conversations/${conv}/scheduled/${made[0]!.id}`, T.carol));
    expect((await schedule(T.carol, conv, { text: 'uno más', send_at: inMs(HOUR) })).status).toBe(201);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('listar y cancelar', () => {
  it('lista los pendientes por hora; los cancelados y fallidos se ven 24 h con su motivo; los enviados ya son mensajes del hilo', async () => {
    const conv = await mkConv();
    const later = await mk(T.carol, conv, 'Después', 90 * MIN);
    const soon = await mk(T.carol, conv, 'Pronto', 10 * MIN);
    const cancelled = await mk(T.carol, conv, 'Cancelado', 20 * MIN);
    await ok(await call('DELETE', `/conversations/${conv}/scheduled/${cancelled.id}`, T.carol));
    const old = await mk(T.carol, conv, 'Viejo', 30 * MIN);
    await admin.query(`UPDATE scheduled_messages SET status = 'failed', reason = 'window_closed', resolved_at = now() - interval '25 hours' WHERE id = $1`, [old.id]);
    const sentOne = await mk(T.carol, conv, 'Salió', 40 * MIN);
    await makeDue(sentOne.id);
    await runDue();
    const items = await list(T.carol, conv);
    expect(items.map((x) => [x.text, x.status, x.reason])).toEqual([['Pronto', 'scheduled', null], ['Cancelado', 'cancelled', 'cancelled_by_user'], ['Después', 'scheduled', null]]);
    expect(items.find((x) => x.id === soon.id)!.can_cancel).toBe(true);
    expect(items.find((x) => x.id === cancelled.id)!.can_cancel).toBe(false);
    expect(items.find((x) => x.id === later.id)).toBeDefined();
  });

  it('cancela quien lo programó o quien ve todas las conversaciones; otro asesor con permiso de responder no (403 SCHEDULE_NOT_YOURS); repetir o cancelar uno enviado da 409', async () => {
    const conv = await mkConv();
    await ok(await call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.eve, permission: 'reply' }));
    const a = await mk(T.carol, conv, 'A');
    const b = await mk(T.carol, conv, 'B');
    const forbidden = await call('DELETE', `/conversations/${conv}/scheduled/${a.id}`, T.eve);
    expect(forbidden.status).toBe(403);
    expect(await code(forbidden)).toBe('SCHEDULE_NOT_YOURS');
    const done = await ok<Sch>(await call('DELETE', `/conversations/${conv}/scheduled/${a.id}`, T.carol));
    expect(done).toMatchObject({ status: 'cancelled', reason: 'cancelled_by_user', can_cancel: false });
    expect(await code(await call('DELETE', `/conversations/${conv}/scheduled/${a.id}`, T.carol))).toBe('SCHEDULE_NOT_PENDING');
    const byAdmin = await call('DELETE', `/conversations/${conv}/scheduled/${b.id}`, T.alice);
    expect(byAdmin.status).toBe(200); // ve todo: puede cancelar el de Carolina
    expect((await audit('scheduled_message', a.id)).map((r) => r.field)).toEqual([null, 'status']);
    const sent = await mk(T.carol, conv, 'C');
    await makeDue(sent.id);
    await runDue();
    expect(await code(await call('DELETE', `/conversations/${conv}/scheduled/${sent.id}`, T.carol))).toBe('SCHEDULE_NOT_PENDING');
    expect((await call('DELETE', `/conversations/${conv}/scheduled/${NOBODY}`, T.carol)).status).toBe(404);
  });

  it('un mensaje cancelado nunca sale', async () => {
    const conv = await mkConv();
    const s = await mk(T.carol, conv);
    await ok(await call('DELETE', `/conversations/${conv}/scheduled/${s.id}`, T.carol));
    await admin.query(`UPDATE scheduled_messages SET send_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
    expect(await runDue()).toBe(0);
    expect(await msgs(conv)).toEqual([]);
    expect(fake().outbox).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('envío a su hora', () => {
  it('a la hora sale como un mensaje normal de quien lo programó, por el proveedor; la conversación pasa a «esperando al cliente»', async () => {
    const conv = await mkConv({ status: 'pending' });
    const s = await mk(T.carol, conv, 'Hola, te recuerdo tu cita de mañana');
    expect(await runDue()).toBe(0); // todavía no llega su hora
    expect(await msgs(conv)).toEqual([]);
    await makeDue(s.id);
    expect(await runDue()).toBe(1);
    const sent = await row(s.id);
    expect(sent.status).toBe('sent');
    expect(sent.message_id).not.toBeNull();
    expect(await msgs(conv)).toEqual([{ kind: 'text', sender_type: 'human', body: 'Hola, te recuerdo tu cita de mañana', status: 'sent', created_by: IDS.carol }]);
    expect(fake().outbox.map((o) => JSON.stringify(o))).toHaveLength(1);
    expect(await convStatus(conv)).toBe('waiting');
    expect(await list(T.carol, conv)).toEqual([]); // ya es un mensaje del hilo
    expect(await runDue()).toBe(0); // repetir no lo manda otra vez
    expect((await msgs(conv)).length).toBe(1);
  });

  it('dos pasadas a la vez no lo envían dos veces', async () => {
    const conv = await mkConv();
    const s = await mk(T.carol, conv);
    await makeDue(s.id);
    await Promise.all([runDue(), runDue(), runDue()]);
    expect((await msgs(conv)).length).toBe(1);
    expect((await row(s.id)).status).toBe('sent');
  });

  it('la tarea recorre las empresas con número conectado y envía los de cada una', async () => {
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const a = await mk(T.carol, convA, 'De A');
    const b = await mk(T.bob, convB, 'De B');
    await makeDue(a.id);
    await makeDue(b.id);
    expect(await app.get(ScheduledMessagesJob).run(new Date())).toBe(2);
    expect((await msgs(convA)).map((m) => m.body)).toEqual(['De A']);
    expect((await msgs(convB)).map((m) => m.body)).toEqual(['De B']);
  });

  it('si el cliente contesta antes, se cancela solo (customer_replied) y no sale', async () => {
    const conv = await mkConv();
    const s = await mk(T.carol, conv);
    await makeDue(s.id);
    await inbound(conv);
    expect(await runDue()).toBe(1);
    expect(await row(s.id)).toMatchObject({ status: 'cancelled', reason: 'customer_replied', message_id: null });
    expect((await msgs(conv)).filter((m) => m.sender_type !== 'contact')).toEqual([]); // solo está lo que escribió el cliente
    const shown = (await list(T.carol, conv))[0]!;
    expect(shown).toMatchObject({ status: 'cancelled', reason: 'customer_replied' });
  });

  it('si el cliente contesta antes de la hora, se cancela en la pasada siguiente aunque todavía no toque enviarlo', async () => {
    const conv = await mkConv();
    const s = await mk(T.carol, conv, 'Aún falta', 30 * MIN);
    await admin.query(`UPDATE scheduled_messages SET created_at = now() - interval '2 minutes' WHERE id = $1`, [s.id]);
    await inbound(conv);
    await runDue();
    expect((await row(s.id)).reason).toBe('customer_replied');
  });

  it('si la conversación se finalizó, se cancela (conversation_closed)', async () => {
    const conv = await mkConv();
    const s = await mk(T.carol, conv);
    await makeDue(s.id);
    await admin.query(`UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [conv]);
    await runDue();
    expect(await row(s.id)).toMatchObject({ status: 'cancelled', reason: 'conversation_closed' });
    expect(await msgs(conv)).toEqual([]);
  });

  it('si la ventana de 24 h se cerró, queda fallido (window_closed); si la conexión se desactivó, también (channel_unavailable)', async () => {
    const conv = await mkConv({ lastInbound: ago(23 * HOUR + 50 * MIN) });
    const s = await mk(T.carol, conv, 'Justo', 5 * MIN);
    await makeDue(s.id);
    await admin.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [conv]);
    await runDue();
    expect(await row(s.id)).toMatchObject({ status: 'failed', reason: 'window_closed' });
    const conv2 = await mkConv();
    const s2 = await mk(T.carol, conv2);
    await makeDue(s2.id);
    await admin.query(`UPDATE channel_accounts SET status = 'disabled' WHERE id = $1`, [channelA]);
    await runDue();
    expect(await row(s2.id)).toMatchObject({ status: 'failed', reason: 'channel_unavailable' });
    expect(fake().outbox).toEqual([]);
  });

  it('si la conversación pasó a otra persona o quien lo programó ya no es del equipo, se cancela (conversation_changed / not_allowed)', async () => {
    const conv = await mkConv();
    const s = await mk(T.carol, conv);
    await makeDue(s.id);
    await admin.query(`UPDATE conversations SET owner_id = $2 WHERE id = $1`, [conv, IDS.eve]);
    await runDue();
    expect(await row(s.id)).toMatchObject({ status: 'cancelled', reason: 'conversation_changed' });
    const conv2 = await mkConv({ owner: IDS.carol });
    const s2 = await mk(T.carol, conv2);
    await makeDue(s2.id);
    await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1`, [IDS.carol]);
    await runDue();
    expect(await row(s2.id)).toMatchObject({ status: 'cancelled', reason: 'not_allowed' });
    expect(await msgs(conv2)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('base de datos', () => {
  it('RLS forzada y la aplicación no puede borrar filas (solo resolverlas)', async () => {
    const t = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'scheduled_messages'`)).rows[0];
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const privs = (await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'scheduled_messages' AND grantee = 'app_rw' ORDER BY 1`)).rows.map((r) => r.privilege_type as string);
    expect(privs).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    const conv = await mkConv();
    const s = await mk(T.carol, conv);
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      expect((await c.query('SELECT id FROM scheduled_messages WHERE id = $1', [s.id])).rowCount).toBe(0);
      await c.query('ROLLBACK');
      await expect(c.query('DELETE FROM scheduled_messages')).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it('restricciones: estado válido, texto, y coherencia entre estado, fecha de resolución y mensaje', async () => {
    const conv = await mkConv();
    const s = await mk(T.carol, conv);
    const bad = (sql: string) => expect(admin.query(sql, [s.id]), sql).rejects.toThrow();
    await bad(`UPDATE scheduled_messages SET status = 'raro', resolved_at = now() WHERE id = $1`);
    await bad(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1`); // resuelto sin fecha
    await bad(`UPDATE scheduled_messages SET resolved_at = now() WHERE id = $1`); // pendiente con fecha
    await bad(`UPDATE scheduled_messages SET status = 'sent', resolved_at = now() WHERE id = $1`); // enviado sin mensaje
    await bad(`UPDATE scheduled_messages SET body = '   ' WHERE id = $1`);
  });
});
