// M5.5a — Transferir y compartir una conversación (ADR-14/50; F10). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/conversations/:id/transfer-options
//   POST /v1/conversations/:id/transfer
//   POST /v1/conversations/:id/share
//   DELETE /v1/conversations/:id/participants/:userId
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
import { InboxModule } from '../../src/modules/inbox';
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
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  ivan: '10000000-0000-4000-8000-0000000000a1', // asesor de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia, con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'ivan' | 'bob' | 'dave' | 'root', string>;
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
  await admin.query('TRUNCATE messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, stage_history, opportunities, pipeline_stages, pipelines, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma', 'UTC'], [ORG_A, 'client', 'Barbería Norte', 'America/Guayaquil'], [ORG_B, 'client', 'Estudio Luna', 'UTC'], [AG1, 'agency', 'Agencia Uno', 'UTC']];
  for (const [id, kind, name, tz] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, tz]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.ivan, 'ivan@a.test', 'Iván Soto'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.eve, ORG_A, 'advisor', null], [IDS.ivan, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
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

interface Participant { user: { id: string; name: string }; permission: 'reply' | 'view'; added_by: { id: string; name: string } | null; added_at: string }
interface Conv {
  id: string;
  status: string;
  unread_count: number;
  owner: { id: string; name: string } | null;
  participants: Participant[];
  my_access: string;
  can: { reply: boolean; note: boolean; accept: boolean; take: boolean; close: boolean; transfer: boolean; share: boolean };
}
interface List { items: Conv[]; counts: { working: number; pending: number; closed: number; unread: number } | null }
interface Msg { id: string; kind: string; text: string | null; status: string; sender_type: string; is_note: boolean; author: { id: string; name: string } | null }
interface MsgList { items: Msg[] }
interface Option { id: string; name: string; role: string; open_count: number; in_queue: boolean | null; is_owner: boolean; is_self: boolean; collaborator: 'reply' | 'view' | null }
interface Options { items: Option[]; queue: { id: string; name: string } | null; can: { transfer: boolean; share: boolean } }
interface TransferResult { id: string; status: string; owner: { id: string; name: string }; still_visible: boolean }
interface Revoked { id: string; user_id: string; revoked: boolean; still_visible: boolean }

let seq = 0;
interface Mk { org?: string; owner?: string | null; status?: string; name?: string; lastInbound?: Date | null; unread?: number; queue?: string | null }
async function mkConv(o: Mk = {}): Promise<{ id: string; contact: string; peer: string; phone: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const channel = org === ORG_B ? channelB : channelA;
  const owner = o.owner ?? null;
  const status = o.status ?? (owner ? 'working' : 'unassigned');
  const phone = `+59398600${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, o.name ?? `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const id = (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, queue_id, last_message_at, last_inbound_at, unread_count, peer_id, closed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [org, contact, channel, status, owner, owner ? new Date() : null, o.queue ?? null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, o.unread ?? 0, phone.slice(1), status === 'closed' ? new Date() : null],
    )
  ).rows[0].id as string;
  await admin.query(
    `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', 'text', 'Hola', 'received', $5)`,
    [org, id, channel, `wamid.SEED${seq}`, ago(40 * MIN)],
  );
  return { id, contact, peer: phone.slice(1), phone };
}
const convRow = async (id: string) => (await admin.query('SELECT * FROM conversations WHERE id = $1', [id])).rows[0] as { status: string; owner_id: string | null; unread_count: number; last_message_at: Date; assigned_at: Date | null; assignment_source: string };
const contactOwner = async (id: string): Promise<string | null> => (await admin.query('SELECT owner_id FROM contacts WHERE id = $1', [id])).rows[0].owner_id as string | null;
const msgsOf = async (conv: string) => (await admin.query(`SELECT kind, status, sender_type, direction, body, created_by FROM messages WHERE conversation_id = $1 ORDER BY sent_at, id`, [conv])).rows as Array<{ kind: string; status: string; sender_type: string; direction: string; body: string | null; created_by: string | null }>;
const noteTexts = async (conv: string): Promise<string[]> => (await msgsOf(conv)).filter((m) => m.kind === 'note').map((m) => m.body ?? '');
const parts = async (conv: string) => (await admin.query('SELECT user_id, permission, added_by, revoked_at, revoked_by FROM conversation_participants WHERE conversation_id = $1 ORDER BY added_at, id', [conv])).rows as Array<{ user_id: string; permission: string; added_by: string | null; revoked_at: Date | null; revoked_by: string | null }>;
const activeParts = async (conv: string) => (await parts(conv)).filter((p) => p.revoked_at === null);
const audits = async (entityId: string) => (await admin.query(`SELECT entity_type, field, old_value, new_value, source FROM audit_logs WHERE entity_id = $1 ORDER BY at, id`, [entityId])).rows as Array<{ entity_type: string; field: string | null; old_value: unknown; new_value: unknown; source: string }>;
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

const get = async (token: string, id: string): Promise<Conv> => ok<Conv>(await call('GET', `/conversations/${id}`, token));
const list = async (token: string, qs = ''): Promise<List> => ok<List>(await call('GET', `/conversations${qs}`, token));
const ids = (l: List): string[] => l.items.map((c) => c.id);
const transfer = (token: string, id: string, body: unknown) => call('POST', `/conversations/${id}/transfer`, token, body);
const share = (token: string, id: string, body: unknown) => call('POST', `/conversations/${id}/share`, token, body);
const revoke = (token: string, id: string, user: string) => call('DELETE', `/conversations/${id}/participants/${user}`, token);
const reply = (token: string, conv: string, text: string) => call('POST', `/conversations/${conv}/messages`, token, { text });

const phone = (n: number): string => `+59398400${String(n).padStart(4, '0')}`;
const msg = (from: string, id: string): NormalizedMessage => ({ externalId: id, from, fromRaw: from.slice(1), profileName: null, kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date() });
async function ingest(from: string, id: string): Promise<void> {
  await TenantContext.run({ organizationId: ORG_A }, async () => {
    const dir = await app.get(OrgDirectoryService).current({ fresh: true });
    const ctx = { now: new Date(), timeZone: dir.timeZone, assignable: dir.assignable };
    await app.get(Database).withTenant((tx) => app.get(ConversationsService).ingestInbound(tx, channelA, msg(from, id), ctx));
  });
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
  app.get(OrgDirectoryService).invalidate();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), ivan: await login('ivan@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte');
  fake().outbox.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('permisos y aislamiento', () => {
  it('sin sesión 401; la plataforma 403; la agencia con nivel «lectura» no transfiere ni comparte (403)', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const routes: Array<[string, string, unknown?]> = [['GET', `/conversations/${c.id}/transfer-options`], ['POST', `/conversations/${c.id}/transfer`, { to_user_id: IDS.eve }], ['POST', `/conversations/${c.id}/share`, { user_id: IDS.eve, permission: 'view' }], ['DELETE', `/conversations/${c.id}/participants/${IDS.eve}`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
    await ok(await call('POST', '/context/switch', T.dave, { target: ORG_A }));
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    for (const [m, p, b] of routes) expect((await call(m, p, T.dave, b)).status, `${m} ${p} lectura`).toBe(403);
    expect((await convRow(c.id)).owner_id).toBe(IDS.carol);
    expect(await parts(c.id)).toEqual([]);
  });

  it('A↔B: nadie ve ni toca las conversaciones de otra empresa (404), ni puede pasarlas a personas de otra empresa (400)', async () => {
    const a = await mkConv({ owner: IDS.carol });
    const b = await mkConv({ org: ORG_B, owner: null });
    const beforeA = await convRow(a.id);
    const beforeB = await convRow(b.id);
    expect((await call('GET', `/conversations/${a.id}/transfer-options`, T.bob)).status).toBe(404);
    expect((await transfer(T.bob, a.id, { to_user_id: IDS.bob })).status).toBe(404);
    expect((await share(T.bob, a.id, { user_id: IDS.bob, permission: 'view' })).status).toBe(404);
    expect((await revoke(T.bob, a.id, IDS.eve)).status).toBe(404);
    // aun con un destino que de todas formas no podría recibirla, lo que no se ve responde 404 (no 400)
    expect((await transfer(T.bob, a.id, { to_user_id: IDS.carol })).status).toBe(404);
    expect((await share(T.bob, a.id, { user_id: IDS.carol, permission: 'view' })).status).toBe(404);
    expect((await transfer(T.alice, b.id, { to_user_id: IDS.bob })).status).toBe(404);
    expect((await share(T.alice, b.id, { user_id: IDS.bob, permission: 'view' })).status).toBe(404);
    expect((await call('GET', `/conversations/${b.id}/transfer-options`, T.alice)).status).toBe(404);
    expect((await transfer(T.alice, b.id, { to_user_id: IDS.carol })).status).toBe(404);
    expect((await share(T.alice, b.id, { user_id: IDS.carol, permission: 'view' })).status).toBe(404);
    // una persona de OTRA empresa no puede recibir la conversación, ni como dueña ni como colaboradora
    const t = await transfer(T.alice, a.id, { to_user_id: IDS.bob });
    expect([t.status, await code(t)]).toEqual([400, 'TRANSFER_TARGET_NOT_ALLOWED']);
    const s = await share(T.alice, a.id, { user_id: IDS.bob, permission: 'view' });
    expect([s.status, await code(s)]).toEqual([400, 'SHARE_TARGET_NOT_ALLOWED']);
    expect(await convRow(a.id)).toEqual(beforeA);
    expect(await convRow(b.id)).toEqual(beforeB);
    expect(await parts(a.id)).toEqual([]);
  });

  it('quien no ve la conversación recibe 404 en todo; la agencia o el soporte no pueden recibirla (no son del equipo)', async () => {
    const c = await mkConv({ owner: IDS.carol });
    expect((await call('GET', `/conversations/${c.id}/transfer-options`, T.eve)).status).toBe(404);
    expect((await transfer(T.eve, c.id, { to_user_id: IDS.ivan })).status).toBe(404);
    expect((await share(T.eve, c.id, { user_id: IDS.ivan, permission: 'view' })).status).toBe(404);
    expect((await revoke(T.eve, c.id, IDS.ivan)).status).toBe(404);
    for (const target of [IDS.dave, IDS.root, NOBODY]) {
      expect((await transfer(T.alice, c.id, { to_user_id: target })).status, 'transferir').toBe(400);
      expect((await share(T.alice, c.id, { user_id: target, permission: 'view' })).status, 'compartir').toBe(400);
    }
    expect((await call('GET', `/conversations/${NOBODY}/transfer-options`, T.alice)).status).toBe(404);
    expect((await call('GET', '/conversations/no-es-un-uuid/transfer-options', T.alice)).status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('transferir', () => {
  it('el dueño la transfiere: queda a nombre de la otra persona «pendiente» (debe aceptarla), el lead se mueve con ella, queda una nota interna y todo se audita; quien la tenía ya no la ve', async () => {
    const c = await mkConv({ owner: IDS.carol, unread: 2 });
    const before = await convRow(c.id);
    // el lead: una oportunidad abierta de Carolina (se mueve), otra de Alicia en otro pipeline (no se toca)
    const p1 = ((await ok<{ items: Array<{ id: string }> }>(await call('GET', '/pipelines', T.alice))).items)[0]!;
    const p2 = await ok<{ id: string }>(await call('POST', '/pipelines', T.alice, { name: 'Cursos' }), 201);
    const mine = await ok<{ id: string }>(await call('POST', '/opportunities', T.alice, { contact_id: c.contact, pipeline_id: p1.id, owner_id: IDS.carol }), 201);
    const others = await ok<{ id: string }>(await call('POST', '/opportunities', T.alice, { contact_id: c.contact, pipeline_id: p2.id, owner_id: IDS.alice }), 201);

    const r = await ok<TransferResult>(await transfer(T.carol, c.id, { to_user_id: IDS.eve, note: '  Es cliente frecuente  ' }));
    expect(r).toEqual({ id: c.id, status: 'pending', owner: { id: IDS.eve, name: 'Eva Mora' }, still_visible: false });
    const row = await convRow(c.id);
    expect(row).toMatchObject({ owner_id: IDS.eve, status: 'pending', assignment_source: 'manual', unread_count: 2 });
    expect(row.assigned_at!.getTime()).toBeGreaterThan(before.assigned_at!.getTime() - 1);
    expect(row.last_message_at).toEqual(before.last_message_at); // la nota no mueve la conversación
    expect(await contactOwner(c.contact)).toBe(IDS.eve);
    const owners = (await admin.query(`SELECT id, owner_id FROM opportunities WHERE contact_id = $1`, [c.contact])).rows as Array<{ id: string; owner_id: string }>;
    expect(owners.find((o) => o.id === mine.id)!.owner_id).toBe(IDS.eve);
    expect(owners.find((o) => o.id === others.id)!.owner_id).toBe(IDS.alice);
    // la nota automática (interna, del sistema) y nada sale al cliente
    const notes = await noteTexts(c.id);
    expect(notes).toEqual(['Carolina Vera transfirió la conversación a Eva Mora. Nota: Es cliente frecuente']);
    expect((await msgsOf(c.id)).filter((m) => m.kind === 'note')[0]).toMatchObject({ status: 'internal', sender_type: 'system', direction: 'out', created_by: IDS.carol });
    expect(fake().outbox).toEqual([]);
    // visibilidad: Carolina ya no la ve; Eva la ve en «Pendientes» y puede aceptarla
    expect((await call('GET', `/conversations/${c.id}`, T.carol)).status).toBe(404);
    expect(ids(await list(T.carol))).toEqual([]);
    expect(ids(await list(T.eve, '?tab=pending'))).toEqual([c.id]);
    const v = await get(T.eve, c.id);
    expect(v).toMatchObject({ status: 'pending', my_access: 'owner', can: { accept: true, reply: true, transfer: true } });
    // auditoría: dueño y estado (sin el texto de la nota), el contacto y la oportunidad movida
    const a = await audits(c.id);
    expect(a.map((x) => [x.field, x.old_value, x.new_value])).toEqual([['owner_id', IDS.carol, IDS.eve], ['status', 'working', 'pending']]);
    expect(JSON.stringify(a)).not.toContain('frecuente');
    expect((await audits(c.contact)).map((x) => [x.field, x.old_value, x.new_value, x.source])).toEqual([['owner_id', IDS.carol, IDS.eve, 'manual']]);
    expect((await audits(mine.id)).filter((x) => x.field === 'owner_id').map((x) => [x.old_value, x.new_value])).toEqual([[IDS.carol, IDS.eve]]);
    expect((await audits(others.id)).filter((x) => x.field === 'owner_id' && x.entity_type === 'opportunity' && x.source === 'manual' && x.new_value === IDS.eve)).toEqual([]);
  });

  it('puede dejar a quien la tenía como colaborador (con permiso de responder o solo ver); sigue viéndola y queda en la nota', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'working' });
    const r = await ok<TransferResult>(await transfer(T.carol, c.id, { to_user_id: IDS.eve, keep_as: 'view' }));
    expect(r.still_visible).toBe(true);
    expect(await noteTexts(c.id)).toEqual(['Carolina Vera transfirió la conversación a Eva Mora. Carolina Vera sigue como colaborador (solo ver y dejar notas).']);
    const v = await get(T.carol, c.id);
    expect(v).toMatchObject({ owner: { id: IDS.eve }, my_access: 'collaborator_view', can: { reply: false, note: true, transfer: false, share: false, close: false } });
    expect(v.participants.map((p) => [p.user.name, p.permission, p.added_by?.name])).toEqual([['Carolina Vera', 'view', 'Carolina Vera']]);
    expect(ids(await list(T.carol, '?tab=pending'))).toEqual([c.id]);
    expect((await audits(c.id)).map((x) => x.field)).toEqual(['owner_id', 'status', 'participant']);
  });

  it('el administrador asigna una conversación sin asignar y transfiere la de otra persona; en ambos casos sigue viéndolas, y las notas dicen quién hizo qué', async () => {
    const free = await mkConv({});
    const r1 = await ok<TransferResult>(await transfer(T.alice, free.id, { to_user_id: IDS.carol, keep_as: 'reply' })); // sin dueño anterior: keep_as no aplica
    expect(r1).toMatchObject({ status: 'pending', owner: { id: IDS.carol }, still_visible: true });
    expect(await activeParts(free.id)).toEqual([]);
    expect(await noteTexts(free.id)).toEqual(['Alicia Torres asignó la conversación a Carolina Vera.']);
    expect(await contactOwner(free.contact)).toBe(IDS.carol); // el contacto no tenía dueño: lo toma la nueva dueña
    const c = await mkConv({ owner: IDS.carol });
    await ok(await transfer(T.alice, c.id, { to_user_id: IDS.eve, keep_as: 'reply' }));
    expect(await noteTexts(c.id)).toEqual(['Alicia Torres transfirió la conversación de Carolina Vera a Eva Mora. Carolina Vera sigue como colaborador (puede responder).']);
    expect((await activeParts(c.id)).map((p) => [p.user_id, p.permission])).toEqual([[IDS.carol, 'reply']]); // el anterior dueño queda, no el administrador
    expect(ids(await list(T.alice, '?tab=pending'))).toContain(c.id);
    expect((await convRow(c.id)).assignment_source).toBe('manual');
  });

  it('si la persona a quien se le pasa ya era colaboradora, pasa a ser la dueña y deja de ser colaboradora', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'reply' }));
    expect((await activeParts(c.id)).map((p) => p.user_id)).toEqual([IDS.eve]);
    await ok(await transfer(T.carol, c.id, { to_user_id: IDS.eve }));
    expect(await activeParts(c.id)).toEqual([]);
    const all = await parts(c.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ user_id: IDS.eve, revoked_by: IDS.carol });
    expect(all[0]!.revoked_at).not.toBeNull();
    expect((await get(T.eve, c.id)).participants).toEqual([]);
  });

  it('no se puede a quien ya la tiene, ni a quien no es del equipo, ni una finalizada, ni sin ser su dueño o administrador; y valida los datos', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const own = await transfer(T.carol, c.id, { to_user_id: IDS.carol });
    expect([own.status, await code(own)]).toEqual([409, 'ALREADY_OWNER']);
    const done = await mkConv({ owner: IDS.carol, status: 'closed' });
    const closed = await transfer(T.carol, done.id, { to_user_id: IDS.eve });
    expect([closed.status, await code(closed)]).toEqual([409, 'CONVERSATION_CLOSED']);
    // un colaborador (con o sin permiso de responder) no la transfiere
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'reply' }));
    const collab = await transfer(T.eve, c.id, { to_user_id: IDS.ivan });
    expect([collab.status, await code(collab)]).toEqual([403, 'NOT_OWNER']);
    const bad = async (body: unknown, label: string) => expect((await transfer(T.carol, c.id, body)).status, label).toBe(400);
    await bad({}, 'sin destino');
    await bad({ to_user_id: 'no-uuid' }, 'destino inválido');
    await bad({ to_user_id: IDS.eve, otro: 1 }, 'campo desconocido');
    await bad({ to_user_id: IDS.eve, keep_as: 'todo' }, 'permiso inválido');
    await bad({ to_user_id: IDS.eve, note: 'x'.repeat(501) }, 'nota larga');
    await bad({ to_user_id: IDS.eve, note: 'a\u0007b' }, 'nota con carácter de control');
    expect((await convRow(c.id)).owner_id).toBe(IDS.carol);
    // una nota vacía es sin nota
    await ok(await transfer(T.carol, c.id, { to_user_id: IDS.ivan, note: '   ' }));
    expect(await noteTexts(c.id)).toEqual(['Carolina Vera compartió la conversación con Eva Mora (puede responder).', 'Carolina Vera transfirió la conversación a Iván Soto.']);
  });

  it('dos transferencias a la vez de la misma conversación: gana una y la otra ya no la ve (404); nunca quedan dos dueños ni dos notas de traspaso', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const rs = await Promise.all([transfer(T.carol, c.id, { to_user_id: IDS.eve }), transfer(T.carol, c.id, { to_user_id: IDS.ivan })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 404]);
    const row = await convRow(c.id);
    expect([IDS.eve, IDS.ivan]).toContain(row.owner_id);
    expect((await noteTexts(c.id)).length).toBe(1);
  });

  it('transferir o tomar a mano NO consume el tope diario de la cola: el reparto automático sigue pudiendo asignarle', async () => {
    const q = await ok<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
    await ok(await call('PATCH', `/queues/${q.id}`, T.alice, { distribution_on: true, daily_cap: 1 }));
    await ok(await call('PUT', `/queues/${q.id}/members`, T.alice, { members: [{ user_id: IDS.eve, active: true, weight: 1 }] }));
    await ok(await call('PATCH', `/channels/${channelA}`, T.alice, { queue_id: q.id }));
    const manual = await mkConv({ owner: IDS.carol, queue: q.id });
    await ok(await transfer(T.carol, manual.id, { to_user_id: IDS.eve })); // hoy a Eva ya le tocó una, pero a mano
    await ingest(phone(1), 'wamid.CAP1');
    const rows = (await admin.query(`SELECT owner_id, assignment_source FROM conversations WHERE organization_id = $1 AND id <> $2`, [ORG_A, manual.id])).rows as Array<{ owner_id: string | null; assignment_source: string }>;
    expect(rows).toEqual([{ owner_id: IDS.eve, assignment_source: 'distribution' }]);
    await ingest(phone(2), 'wamid.CAP2'); // y ahora sí: la segunda automática de hoy rebasa el tope de 1
    const second = (await admin.query(`SELECT owner_id FROM conversations WHERE organization_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1`, [ORG_A, manual.id])).rows[0] as { owner_id: string | null };
    expect(second.owner_id).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('compartir', () => {
  it('el dueño comparte «solo ver y notas»: la otra persona la ve en su bandeja y deja notas, pero no escribe al cliente, no la acepta, finaliza, transfiere ni comparte; el dueño sigue siendo el mismo', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'working', unread: 3 });
    const v = await ok<Conv>(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view', note: 'Ayúdame a revisar el precio' }));
    expect(v.owner).toMatchObject({ id: IDS.carol });
    expect(v.participants.map((p) => [p.user.id, p.permission, p.added_by?.id])).toEqual([[IDS.eve, 'view', IDS.carol]]);
    expect(await noteTexts(c.id)).toEqual(['Carolina Vera compartió la conversación con Eva Mora (solo ver y dejar notas). Nota: Ayúdame a revisar el precio']);
    expect(await contactOwner(c.contact)).toBe(IDS.carol);
    expect((await convRow(c.id)).owner_id).toBe(IDS.carol);
    // lo que ve Eva
    const l = await list(T.eve);
    expect(ids(l)).toEqual([c.id]);
    expect(l.counts).toEqual({ working: 1, pending: 0, closed: 0, unread: 1 });
    expect(l.items[0]).toMatchObject({ my_access: 'collaborator_view', can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } });
    expect((await ok<MsgList>(await call('GET', `/conversations/${c.id}/messages`, T.eve))).items.length).toBeGreaterThan(0);
    const note = await ok<Msg>(await call('POST', `/conversations/${c.id}/notes`, T.eve, { text: 'Yo lo bajaría un 10 %' }), 201);
    expect(note).toMatchObject({ is_note: true, author: { id: IDS.eve } });
    for (const [m, p, b] of [['POST', 'messages', { text: 'hola' }], ['POST', 'accept'], ['POST', 'close'], ['POST', 'transfer', { to_user_id: IDS.ivan }], ['POST', 'share', { user_id: IDS.ivan, permission: 'view' }]] as Array<[string, string, unknown?]>) {
      const r = await call(m, `/conversations/${c.id}/${p}`, T.eve, b);
      expect(r.status, p).toBe(403);
    }
    expect((await call('GET', `/conversations/${c.id}/transfer-options`, T.eve)).status).toBe(403);
    expect((await call('POST', `/conversations/${c.id}/read`, T.eve)).status).toBe(200);
    expect((await convRow(c.id)).unread_count).toBe(3); // los no leídos son del dueño
    expect(fake().outbox).toEqual([]);
    expect((await audits(c.id)).map((x) => [x.field, x.new_value])).toEqual([['participant', { user_id: IDS.eve, permission: 'view' }]]);
  });

  it('con permiso de responder, la persona escribe al cliente cuando el dueño ya aceptó (antes, 409); lo que escribe sale con su nombre', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'pending' });
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'reply' }));
    const early = await reply(T.eve, c.id, 'Hola');
    expect([early.status, await code(early)]).toEqual([409, 'CONVERSATION_NOT_ACCEPTED']);
    await ok(await call('POST', `/conversations/${c.id}/accept`, T.carol));
    const m = await ok<Msg>(await reply(T.eve, c.id, 'Hola, soy Eva'), 201);
    expect(m).toMatchObject({ status: 'sent', author: { id: IDS.eve, name: 'Eva Mora' } });
    expect(fake().outbox).toEqual([expect.objectContaining({ to: c.peer, text: 'Hola, soy Eva' })]);
    expect((await convRow(c.id)).status).toBe('waiting');
    expect((await get(T.eve, c.id)).can.reply).toBe(true);
    // un colaborador que solo ve no puede reintentar lo que falló, uno que responde sí (lo escribió él o no)
    const failed = await ok<Msg>(await reply(T.eve, c.id, '[fallar:rechazo] otra'), 201);
    expect(failed.status).toBe('failed');
    expect((await call('POST', `/messages/${failed.id}/retry`, T.carol)).status).toBe(200);
  });

  it('compartir de nuevo con otro permiso lo cambia (con nota); con el mismo, no cambia nada ni deja nota', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view' }));
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view' }));
    expect(await noteTexts(c.id)).toHaveLength(1);
    const v = await ok<Conv>(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'reply' }));
    expect(v.participants.map((p) => p.permission)).toEqual(['reply']);
    expect((await noteTexts(c.id)).at(-1)).toBe('Carolina Vera cambió el acceso de Eva Mora: puede responder.');
    expect((await audits(c.id)).map((x) => [x.old_value, x.new_value])).toEqual([[null, { user_id: IDS.eve, permission: 'view' }], [{ user_id: IDS.eve, permission: 'view' }, { user_id: IDS.eve, permission: 'reply' }]]);
    expect(await parts(c.id)).toHaveLength(1);
  });

  it('el administrador comparte la conversación de otra persona; quien la comparte no puede compartirla con su dueño, una sin asignar o una finalizada', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await ok(await share(T.alice, c.id, { user_id: IDS.eve, permission: 'view' }));
    expect((await activeParts(c.id)).map((p) => p.added_by)).toEqual([IDS.alice]);
    const owner = await share(T.carol, c.id, { user_id: IDS.carol, permission: 'view' });
    expect([owner.status, await code(owner)]).toEqual([409, 'ALREADY_OWNER']);
    const free = await mkConv({});
    const unassigned = await share(T.alice, free.id, { user_id: IDS.eve, permission: 'view' });
    expect([unassigned.status, await code(unassigned)]).toEqual([409, 'CONVERSATION_UNASSIGNED']);
    const done = await mkConv({ owner: IDS.carol, status: 'closed' });
    const closed = await share(T.carol, done.id, { user_id: IDS.eve, permission: 'view' });
    expect([closed.status, await code(closed)]).toEqual([409, 'CONVERSATION_CLOSED']);
    const bad = async (body: unknown, label: string) => expect((await share(T.carol, c.id, body)).status, label).toBe(400);
    await bad({ user_id: IDS.ivan }, 'sin permiso');
    await bad({ user_id: IDS.ivan, permission: 'owner' }, 'permiso inválido');
    await bad({ permission: 'view' }, 'sin persona');
    await bad({ user_id: IDS.ivan, permission: 'view', otro: 1 }, 'campo desconocido');
    await bad({ user_id: IDS.ivan, permission: 'view', note: 'x'.repeat(501) }, 'nota larga');
  });

  it('hay un tope de colaboradores por conversación; quitar a uno deja sitio', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const extra: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `20000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
      extra.push(id);
      await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, `extra${i}@a.test`, hash, `Extra ${i}`]);
      await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'advisor')`, [id, ORG_A]);
    }
    app.get(OrgDirectoryService).invalidate();
    for (const id of extra) await ok(await share(T.carol, c.id, { user_id: id, permission: 'view' }));
    const over = await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view' });
    expect([over.status, await code(over)]).toEqual([409, 'PARTICIPANT_LIMIT']);
    await ok(await revoke(T.carol, c.id, extra[0]!));
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view' }));
    expect(await activeParts(c.id)).toHaveLength(10);
    // cambiarle el permiso a uno que ya está no cuenta contra el tope
    await ok(await share(T.carol, c.id, { user_id: extra[1]!, permission: 'reply' }));
  });

  it('una conversación finalizada sigue visible para sus colaboradores (pestaña «Finalizadas»)', async () => {
    const c = await mkConv({ owner: IDS.carol, status: 'working' });
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view' }));
    await ok(await call('POST', `/conversations/${c.id}/close`, T.carol));
    expect(ids(await list(T.eve, '?tab=closed'))).toEqual([c.id]);
    expect((await get(T.eve, c.id)).status).toBe('closed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('quitar el acceso', () => {
  it('el dueño lo quita: la persona deja de verla (404) y queda una nota; el acceso queda con su hora y quién lo quitó; se le puede volver a dar', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'reply' }));
    expect(ids(await list(T.eve))).toEqual([c.id]);
    const r = await ok<Revoked>(await revoke(T.carol, c.id, IDS.eve));
    expect(r).toEqual({ id: c.id, user_id: IDS.eve, revoked: true, still_visible: true });
    expect((await call('GET', `/conversations/${c.id}`, T.eve)).status).toBe(404);
    expect(ids(await list(T.eve))).toEqual([]);
    expect((await noteTexts(c.id)).at(-1)).toBe('Carolina Vera quitó el acceso de Eva Mora.');
    const all = await parts(c.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ user_id: IDS.eve, revoked_by: IDS.carol });
    expect((await audits(c.id)).at(-1)).toMatchObject({ field: 'participant', old_value: { user_id: IDS.eve, permission: 'reply' }, new_value: null });
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view' })); // se le puede volver a dar
    expect((await parts(c.id)).length).toBe(2);
    expect((await activeParts(c.id)).map((p) => p.permission)).toEqual(['view']);
  });

  it('la propia persona puede dejar de participar; un colaborador no puede quitar a otro; el administrador sí; quitar a quien no participa es 404', async () => {
    const c = await mkConv({ owner: IDS.carol });
    await ok(await share(T.carol, c.id, { user_id: IDS.eve, permission: 'view' }));
    await ok(await share(T.carol, c.id, { user_id: IDS.ivan, permission: 'view' }));
    const other = await revoke(T.eve, c.id, IDS.ivan);
    expect([other.status, await code(other)]).toEqual([403, 'NOT_OWNER']);
    expect((await revoke(T.carol, c.id, IDS.alice)).status).toBe(404); // el administrador no es colaborador
    const leave = await ok<Revoked>(await revoke(T.eve, c.id, IDS.eve));
    expect(leave).toMatchObject({ revoked: true, still_visible: false });
    expect((await noteTexts(c.id)).at(-1)).toBe('Eva Mora dejó de participar en la conversación.');
    expect((await call('GET', `/conversations/${c.id}`, T.eve)).status).toBe(404);
    const byAdmin = await ok<Revoked>(await revoke(T.alice, c.id, IDS.ivan));
    expect(byAdmin.still_visible).toBe(true);
    expect(await activeParts(c.id)).toEqual([]);
    expect((await call('DELETE', `/conversations/${c.id}/participants/${IDS.eve}`, T.carol)).status).toBe(404); // ya no participa
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('opciones del selector', () => {
  it('lista al equipo con su carga, si está en la cola, quién es el dueño y quién ya colabora', async () => {
    const q = await ok<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas' }), 201);
    await ok(await call('PUT', `/queues/${q.id}/members`, T.alice, { members: [{ user_id: IDS.carol, active: true, weight: 1 }, { user_id: IDS.eve, active: true, weight: 1 }, { user_id: IDS.ivan, active: false, weight: 1 }] }));
    const c = await mkConv({ owner: IDS.carol, queue: q.id });
    await mkConv({ owner: IDS.eve, status: 'pending' });
    await mkConv({ owner: IDS.eve, status: 'working' });
    await mkConv({ owner: IDS.eve, status: 'closed' }); // no cuenta como abierta
    await ok(await share(T.carol, c.id, { user_id: IDS.ivan, permission: 'view' }));
    const o = await ok<Options>(await call('GET', `/conversations/${c.id}/transfer-options`, T.carol));
    expect(o.queue).toEqual({ id: q.id, name: 'Ventas' });
    expect(o.can).toEqual({ transfer: true, share: true });
    const by = Object.fromEntries(o.items.map((p) => [p.name, p]));
    expect(Object.keys(by).sort()).toEqual(['Alicia Torres', 'Carolina Vera', 'Eva Mora', 'Iván Soto']); // la agencia y la plataforma no reciben conversaciones
    expect(by['Carolina Vera']).toMatchObject({ is_owner: true, is_self: true, open_count: 1, in_queue: true, collaborator: null });
    expect(by['Eva Mora']).toMatchObject({ is_owner: false, is_self: false, open_count: 2, in_queue: true, collaborator: null });
    expect(by['Iván Soto']).toMatchObject({ in_queue: false, collaborator: 'view', open_count: 0 });
    expect(by['Alicia Torres']).toMatchObject({ role: 'client_admin', in_queue: false });
    // sin cola, no hay advertencia posible
    const noQueue = await mkConv({ owner: IDS.carol });
    const o2 = await ok<Options>(await call('GET', `/conversations/${noQueue.id}/transfer-options`, T.carol));
    expect(o2.queue).toBeNull();
    expect(o2.items.every((p) => p.in_queue === null)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('base de datos', () => {
  it('un acceso vigente por persona y conversación; permisos válidos; revocar deja quién y cuándo; sin referencias a conversaciones de otra empresa', async () => {
    const c = await mkConv({ owner: IDS.carol });
    const b = await mkConv({ org: ORG_B });
    const ins = (conv: string, user: string, permission: string, org = ORG_A, extra = '') =>
      admin.query(`INSERT INTO conversation_participants(id, organization_id, conversation_id, user_id, permission${extra ? ', revoked_at, revoked_by' : ''}) VALUES (gen_random_uuid(), $1, $2, $3, $4${extra ? ', now(), NULL' : ''})`, [org, conv, user, permission]);
    await ins(c.id, IDS.eve, 'view');
    await expect(ins(c.id, IDS.eve, 'reply')).rejects.toMatchObject({ code: '23505' });
    await expect(ins(c.id, IDS.ivan, 'owner')).rejects.toMatchObject({ code: '23514' });
    await expect(ins(c.id, IDS.ivan, 'view', ORG_A, 'revocado sin quién')).rejects.toMatchObject({ code: '23514' });
    await expect(ins(b.id, IDS.ivan, 'view', ORG_A)).rejects.toMatchObject({ code: '23503' }); // la FK compuesta impide colgarse de una conversación de otra empresa
    await admin.query(`UPDATE conversation_participants SET revoked_at = now(), revoked_by = $1 WHERE conversation_id = $2`, [IDS.carol, c.id]);
    await ins(c.id, IDS.eve, 'reply'); // revocado: puede volver a tener uno vigente
    await expect(admin.query(`UPDATE conversations SET assignment_source = 'otro' WHERE id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });
  });
});
