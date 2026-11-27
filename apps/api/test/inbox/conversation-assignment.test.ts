// V24 — «Asignación» de una conversación. Ruta cubierta (el registro de endpoints exige que este archivo la escriba tal cual):
//   GET /v1/conversations/:id/assignment
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AttributionModule } from '../../src/modules/attribution';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { SalesModule } from '../../src/modules/sales';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, OpportunitiesModule, AttributionModule.register(), InboxModule, SalesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A, dueña de las conversaciones
  eve: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A, sin nombre cargado
  root: 'f0000000-0000-4000-8000-0000000000f1', // soporte de la plataforma
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob', string>;
let sales = '';
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
  await admin.query('TRUNCATE notifications, sale_change_requests, sale_payments, sale_status_history, sales, meta_events, response_timers, messages, conversation_participants, conversations, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, contact_phones, contacts, queue_products, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.eve, 'eve@a.test', null], [IDS.root, 'root@p.test', 'Rita Root']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.eve, ORG_A, 'advisor']] as const) {
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

let seq = 0;
async function mkConv(o: { owner?: string | null; queue?: string | null; status?: string; deleted?: boolean; org?: string; channel?: string } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const status = o.deleted ? 'closed' : (o.status ?? (owner ? 'working' : 'unassigned'));
  const phone = `+59398901${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return (await admin.query(
    `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, queue_id, status, owner_id, assigned_at, last_message_at, unread_count, peer_id, deleted_at, closed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END, now(), 0, $7, CASE WHEN $8 THEN now() END, CASE WHEN $5 = 'closed' THEN now() END) RETURNING id`,
    [org, contact, o.channel ?? channelA, o.queue ?? null, status, owner, phone.replace('+', ''), o.deleted === true],
  )).rows[0].id as string;
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
  const mkQueue = async (token: string, name: string): Promise<string> => (await json<{ id: string }>(await call('POST', '/queues', token, { name }))).id;
  sales = await mkQueue(T.alice, 'Ventas');
  const ch = await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN });
  expect(ch.status).toBe(201);
  channelA = (await json<{ id: string }>(ch)).id;
});

interface Person { id: string; name: string }
interface View {
  owner: Person | null; assigned_at: string | null; how: string | null; how_by: Person | null; queue: { name: string } | null; time_zone: string; history_scope: string;
  shared: Array<{ user: Person; permission: string; added_by: Person | null; added_at: string | null }>;
  history: Array<{ kind: string; from: Person | null; to: Person | null; by: Person | null; at: string }>;
}
const view = async (conv: string, token: string): Promise<View> => {
  const r = await call('GET', `/conversations/${conv}/assignment`, token);
  expect(r.status).toBe(200);
  return json<View>(r);
};
const ok = async (r: Promise<Response>): Promise<void> => {
  const res = await r;
  expect(res.status, await res.clone().text()).toBeLessThan(300);
};
/** La administradora toma una conversación sin asignar, la pasa a Carolina y la comparte con Eva (todo por la API, como en la pantalla). */
async function journey(): Promise<string> {
  const conv = await mkConv({ owner: null, queue: sales });
  await ok(call('POST', `/conversations/${conv}/take`, T.alice));
  await ok(call('POST', `/conversations/${conv}/transfer`, T.alice, { to_user_id: IDS.carol }));
  await ok(call('POST', `/conversations/${conv}/share`, T.alice, { user_id: IDS.eve, permission: 'view' }));
  return conv;
}

describe('asignación de la conversación', () => {
  it('quien ve todo: dueño, cómo y cuándo, departamento, con quién está compartida y el historial del más reciente al más antiguo, sin correos', async () => {
    const conv = await journey();
    const v = await view(conv, T.alice);
    expect(v).toMatchObject({ owner: { id: IDS.carol, name: 'Carolina Vera' }, how: 'transferred', how_by: { name: 'Alicia Torres' }, queue: { name: 'Ventas' }, time_zone: 'America/Guayaquil', history_scope: 'all' });
    expect(v.assigned_at).toEqual(expect.any(String));
    expect(v.shared).toEqual([{ user: { id: IDS.eve, name: 'Asesor' }, permission: 'view', added_by: { id: IDS.alice, name: 'Alicia Torres' }, added_at: expect.any(String) }]);
    expect(v.history.map((s) => [s.kind, s.from?.name ?? null, s.to?.name ?? null, s.by?.name ?? null])).toEqual([
      ['transferred', 'Alicia Torres', 'Carolina Vera', 'Alicia Torres'],
      ['taken', null, 'Alicia Torres', 'Alicia Torres'],
    ]);
    expect(JSON.stringify(v)).not.toContain('@');
  });

  it('la asesora dueña ve solo sus pasos; la colaboradora ve el dueño y desde cuándo le compartieron, sin detalle ajeno', async () => {
    const conv = await journey();
    await ok(call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.alice, permission: 'view' }));
    const mine = await view(conv, T.carol);
    expect(mine).toMatchObject({ history_scope: 'own', how: 'transferred', how_by: { name: 'Alicia Torres' } });
    expect(mine.history.map((s) => s.kind)).toEqual(['transferred']);
    const other = await view(conv, T.eve);
    expect(other).toMatchObject({ owner: { name: 'Carolina Vera' }, how_by: null, history: [], history_scope: 'own' });
    expect(other.shared).toHaveLength(2);
    expect(other.shared.find((s) => s.user.id === IDS.eve)).toMatchObject({ added_by: { name: 'Alicia Torres' }, added_at: expect.any(String) });
    expect(other.shared.find((s) => s.user.id === IDS.alice)).toMatchObject({ user: { name: 'Alicia Torres' }, permission: 'view', added_by: null, added_at: null });
  });

  it('lo automático no tiene autor y quien actúa desde fuera sale como «Soporte» o «Agencia»', async () => {
    const conv = await mkConv({ queue: sales });
    const row = (from: string | null, to: string | null, actor: string | null, actingAs: string | null, source: string, minutes: number) =>
      admin.query(
        `INSERT INTO audit_logs(id, organization_id, entity_type, entity_id, field, old_value, new_value, actor_user_id, acting_as, source, at) VALUES (gen_random_uuid(), $1, 'conversation', $2, 'owner_id', $3, $4, $5, $6, $7, now() - make_interval(mins => $8::int))`,
        [ORG_A, conv, from === null ? null : JSON.stringify(from), to === null ? null : JSON.stringify(to), actor, actingAs, source, minutes],
      );
    await row(null, IDS.eve, IDS.alice, null, 'automation', 30);
    await row(IDS.eve, IDS.alice, null, null, 'automation', 20);
    await row(IDS.alice, IDS.carol, IDS.root, 'super_admin', 'manual', 10);
    const v = await view(conv, T.alice);
    expect(v.history.map((s) => [s.kind, s.by?.name ?? null])).toEqual([['transferred', 'Soporte'], ['reassigned', null], ['distribution', null]]);
    expect(v.how_by?.name).toBe('Soporte');
    await admin.query(`DELETE FROM audit_logs WHERE entity_id = $1`, [conv]);
    await row(IDS.alice, IDS.carol, IDS.root, 'agency', 'manual', 5);
    expect((await view(conv, T.alice)).how_by?.name).toBe('Agencia');
  });

  it('sin dueño: «sin asignar» y sin cómo', async () => {
    const conv = await mkConv({ owner: null });
    expect(await view(conv, T.alice)).toMatchObject({ owner: null, assigned_at: null, how: null, how_by: null, queue: null, shared: [], history: [] });
  });

  it('aislamiento A↔B y visibilidad: otra empresa, una asesora ajena y lo inexistente reciben el mismo 404; sin sesión 401', async () => {
    const conv = await mkConv();
    for (const [token, id] of [[T.bob, conv], [T.eve, conv], [T.alice, randomUUID()]] as const) expect((await call('GET', `/conversations/${id}/assignment`, token)).status).toBe(404);
    expect((await call('GET', `/conversations/${conv}/assignment`)).status).toBe(401);
  });
});
