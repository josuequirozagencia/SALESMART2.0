// M5.10 — Vista global de mensajes programados (ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/scheduled
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
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
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
/** Un mensaje del cliente que acaba de llegar. */
const inbound = async (conv: string) => {
  await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) SELECT gen_random_uuid(), organization_id, id, channel_account_id, 'in', 'contact', 'text', 'Hola', 'received', now() FROM conversations WHERE id = $1`, [conv]);
  await admin.query(`UPDATE conversations SET last_inbound_at = now() WHERE id = $1`, [conv]);
};

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
interface Item extends Sch { conversation: { id: string; channel_name: string; contact: { id: string; name: string } } }
interface Page { items: Item[]; next_cursor: string | null; counts: { scheduled: number; not_sent: number; sent: number } | null }
const all = (token: string | undefined, qs = ''): Promise<Response> => call('GET', `/scheduled${qs}`, token);
const page = async (token: string, qs = ''): Promise<Page> => ok<Page>(await all(token, qs));
const share = (conv: string, user: string, permission: 'reply' | 'view' = 'view') =>
  admin.query(`INSERT INTO conversation_participants(id, organization_id, conversation_id, user_id, permission) VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [ORG_A, conv, user, permission]);

describe('GET /scheduled — acceso, validación y aislamiento', () => {
  it('sin sesión 401 y la plataforma 403', async () => {
    expect((await all(undefined)).status).toBe(401);
    expect((await all(T.root)).status).toBe(403);
  });

  it('parámetros inválidos: 400 (estado, límite, cursor, filtro)', async () => {
    for (const qs of ['?status=all', '?contact_id=zzz', '?from=ayer', '?to=2026-13-01', '?limit=0', '?limit=51', '?cursor=zzz', '?mine=no', '?extra=1']) expect((await all(T.alice, qs)).status, qs).toBe(400);
  });

  it('A↔B: cada empresa ve solo lo suyo, también en la otra pestaña y con el contador', async () => {
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const a = await mk(T.carol, convA, 'Mensaje de A');
    const b = await mk(T.bob, convB, 'Mensaje de B');
    const pa = await page(T.alice);
    const pb = await page(T.bob);
    expect(pa.items.map((x) => x.id)).toEqual([a.id]);
    expect(pb.items.map((x) => x.id)).toEqual([b.id]);
    expect(pa.counts).toEqual({ scheduled: 1, not_sent: 0, sent: 0 });
    expect(pb.counts).toEqual({ scheduled: 1, not_sent: 0, sent: 0 });
    // lo cancelado de A no aparece en las «no salieron» de B
    expect((await call('DELETE', `/conversations/${convA}/scheduled/${a.id}`, T.alice)).status).toBe(200);
    expect((await page(T.bob, '?status=not_sent')).items).toEqual([]);
    expect((await page(T.alice, '?status=not_sent')).items.map((x) => x.id)).toEqual([a.id]);
    // el contacto y la conexión que se muestran son de la propia empresa
    expect(pa.items[0]!.conversation).toEqual({ id: convA, channel_name: 'Ventas', contact: { id: expect.any(String), name: expect.stringMatching(/^Cliente /) } });
  });
});

describe('alcance por persona', () => {
  it('el asesor ve solo lo de sus conversaciones; el administrador, todo; lo compartido se ve y lo revocado no', async () => {
    const convCarol = await mkConv({ owner: IDS.carol });
    const convEve = await mkConv({ owner: IDS.eve });
    const c = await mk(T.carol, convCarol, 'De Carolina');
    const e = await mk(T.eve, convEve, 'De Eva');
    expect((await page(T.carol)).items.map((x) => x.id)).toEqual([c.id]);
    expect((await page(T.eve)).items.map((x) => x.id)).toEqual([e.id]);
    expect((await page(T.alice)).items.map((x) => x.id).sort()).toEqual([c.id, e.id].sort());
    expect((await page(T.alice)).counts).toEqual({ scheduled: 2, not_sent: 0, sent: 0 });
    // Eva ve lo de Carolina si se lo comparten (solo para ver), pero no lo puede cancelar
    await share(convCarol, IDS.eve, 'view');
    const seen = (await page(T.eve)).items;
    expect(seen.map((x) => x.id).sort()).toEqual([c.id, e.id].sort());
    expect(seen.find((x) => x.id === c.id)).toMatchObject({ mine: false, can_cancel: false });
    expect(seen.find((x) => x.id === e.id)).toMatchObject({ mine: true, can_cancel: true });
    await admin.query(`UPDATE conversation_participants SET revoked_at = now(), revoked_by = $1 WHERE conversation_id = $2`, [IDS.alice, convCarol]);
    expect((await page(T.eve)).items.map((x) => x.id)).toEqual([e.id]);
  });

  it('«mías» deja solo lo que programó la persona (incluso para el administrador que lo ve todo)', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const c = await mk(T.carol, conv, 'De Carolina');
    const a = await mk(T.alice, conv, 'Del administrador', 20 * MIN);
    expect((await page(T.alice)).items.map((x) => x.id).sort()).toEqual([c.id, a.id].sort());
    expect((await page(T.alice, '?mine=1')).items.map((x) => x.id)).toEqual([a.id]);
    expect((await page(T.alice, '?mine=true')).counts).toEqual({ scheduled: 1, not_sent: 0, sent: 0 });
    expect((await page(T.carol, '?mine=1')).items.map((x) => x.id)).toEqual([c.id]);
  });

  it('un contacto borrado no deja ver sus mensajes programados', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await mk(T.carol, conv);
    await admin.query(`UPDATE contacts SET deleted_at = now() WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [conv]);
    const p = await page(T.alice);
    expect(p.items).toEqual([]);
    expect(p.counts).toEqual({ scheduled: 0, not_sent: 0, sent: 0 });
  });
});

describe('pestañas, orden y paginación', () => {
  it('«scheduled» va por hora de envío; «not_sent» trae cancelados y fallidos de 24 h, lo más reciente primero, y no los enviados ni los viejos', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const late = await mk(T.carol, conv, 'Tarde', 40 * MIN);
    const soon = await mk(T.carol, conv, 'Pronto', 10 * MIN);
    const cancelled = await mk(T.carol, conv, 'Cancelado', 20 * MIN);
    const failed = await mk(T.carol, conv, 'Fallido', 25 * MIN);
    const old = await mk(T.carol, conv, 'Viejo', 30 * MIN);
    const sent = await mk(T.carol, conv, 'Enviado', 35 * MIN);
    await admin.query(`UPDATE scheduled_messages SET status = 'cancelled', reason = 'cancelled_by_user', resolved_at = now() - interval '2 hours' WHERE id = $1`, [cancelled.id]);
    await admin.query(`UPDATE scheduled_messages SET status = 'failed', reason = 'window_closed', resolved_at = now() - interval '1 hour' WHERE id = $1`, [failed.id]);
    await admin.query(`UPDATE scheduled_messages SET status = 'cancelled', reason = 'customer_replied', resolved_at = now() - interval '25 hours' WHERE id = $1`, [old.id]);
    await inbound(conv);
    await admin.query(`UPDATE scheduled_messages SET status = 'sent', resolved_at = now(), message_id = (SELECT id FROM messages WHERE conversation_id = $2 LIMIT 1) WHERE id = $1`, [sent.id, conv]);
    const pending = await page(T.alice);
    expect(pending.items.map((x) => x.id)).toEqual([soon.id, late.id]);
    expect(pending.counts).toEqual({ scheduled: 2, not_sent: 2, sent: 1 });
    const not = await page(T.alice, '?status=not_sent');
    expect(not.items.map((x) => x.id)).toEqual([failed.id, cancelled.id]);
    expect(not.items.map((x) => x.reason)).toEqual(['window_closed', 'cancelled_by_user']);
    expect(not.counts).toEqual({ scheduled: 2, not_sent: 2, sent: 1 });
    // v13 S2.3: «sent» trae los que ya salieron en las últimas 24 h (uno más viejo no aparece)
    await admin.query(`UPDATE scheduled_messages SET status = 'sent', resolved_at = now() - interval '30 hours', message_id = (SELECT id FROM messages WHERE conversation_id = $2 LIMIT 1) WHERE id = $1`, [old.id, conv]);
    const sentTab = await page(T.alice, '?status=sent');
    expect(sentTab.items.map((x) => x.id)).toEqual([sent.id]);
    expect(sentTab.items[0]!.status).toBe('sent');
    expect(sentTab.counts).toEqual({ scheduled: 2, not_sent: 2, sent: 1 });
  });

  it('el cursor recorre ambas pestañas sin repetir ni saltarse a nadie y los conteos solo vienen en la primera página', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const made: Sch[] = [];
    for (let i = 1; i <= 5; i += 1) made.push(await mk(T.carol, conv, `Mensaje ${i}`, (10 + i) * MIN));
    const first = await page(T.alice, '?limit=2');
    expect(first.items.map((x) => x.id)).toEqual([made[0]!.id, made[1]!.id]);
    expect(first.counts).toEqual({ scheduled: 5, not_sent: 0, sent: 0 });
    expect(first.next_cursor).toBeTruthy();
    const second = await page(T.alice, `?limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((x) => x.id)).toEqual([made[2]!.id, made[3]!.id]);
    expect(second.counts).toBeNull();
    const third = await page(T.alice, `?limit=2&cursor=${second.next_cursor}`);
    expect(third.items.map((x) => x.id)).toEqual([made[4]!.id]);
    expect(third.next_cursor).toBeNull();
    // «no salieron»: lo más reciente primero
    for (let i = 0; i < 3; i += 1) await admin.query(`UPDATE scheduled_messages SET status = 'cancelled', reason = 'cancelled_by_user', resolved_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [made[i]!.id, String(10 * (i + 1))]);
    const n1 = await page(T.alice, '?status=not_sent&limit=2');
    expect(n1.items.map((x) => x.id)).toEqual([made[0]!.id, made[1]!.id]);
    const n2 = await page(T.alice, `?status=not_sent&limit=2&cursor=${n1.next_cursor}`);
    expect(n2.items.map((x) => x.id)).toEqual([made[2]!.id]);
    expect(n2.next_cursor).toBeNull();
  });

  it('v13 S2.3: filtra por contacto y por rango de fechas (y no mezcla el contacto de otra empresa)', async () => {
    const conv1 = await mkConv({ owner: IDS.carol });
    const conv2 = await mkConv({ owner: IDS.carol });
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    const m1 = await mk(T.carol, conv1, 'Uno', 10 * MIN);
    const m2 = await mk(T.carol, conv2, 'Dos', 3 * HOUR);
    const mb = await mk(T.bob, convB, 'De B', 3 * HOUR);
    const contactOf = async (conv: string): Promise<string> => (await admin.query(`SELECT contact_id FROM conversations WHERE id = $1`, [conv])).rows[0].contact_id as string;
    const c1 = await contactOf(conv1);
    expect((await page(T.alice, `?contact_id=${c1}`)).items.map((x) => x.id)).toEqual([m1.id]);
    expect((await page(T.alice, `?contact_id=${await contactOf(convB)}`)).items).toEqual([]); // el contacto de B no existe para A
    expect((await page(T.bob, `?contact_id=${c1}`)).items).toEqual([]);
    const from = encodeURIComponent(inMs(2 * HOUR));
    expect((await page(T.alice, `?from=${from}`)).items.map((x) => x.id)).toEqual([m2.id]);
    const to = encodeURIComponent(inMs(HOUR));
    expect((await page(T.alice, `?to=${to}`)).items.map((x) => x.id)).toEqual([m1.id]);
    expect((await page(T.bob, `?from=${from}`)).items.map((x) => x.id)).toEqual([mb.id]);
  });

  it('cancelar desde la vista global (la ruta de siempre) lo pasa a «no salieron»', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const s = await mk(T.carol, conv);
    const item = (await page(T.carol)).items[0]!;
    expect(item).toMatchObject({ id: s.id, can_cancel: true, conversation: { id: conv } });
    expect((await call('DELETE', `/conversations/${item.conversation.id}/scheduled/${item.id}`, T.carol)).status).toBe(200);
    expect((await page(T.carol)).counts).toEqual({ scheduled: 0, not_sent: 1, sent: 0 });
  });
});
