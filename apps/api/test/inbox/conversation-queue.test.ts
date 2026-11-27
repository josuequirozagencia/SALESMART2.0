// V24 — Departamento de una conversación (ADR-50/65). Ruta cubierta (el registro de endpoints exige que este archivo la escriba tal cual):
//   PUT /v1/conversations/:id/queue
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const MIGRATION = readFileSync(path.join(__dirname, '../../src/db/migrations/0158_v24_departamento_conversacion.sql'), 'utf8');

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
let sales = '';
let support = '';
let queueB = '';
let productId = '';
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
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
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
const count = async (sql: string): Promise<number> => (await admin.query(sql)).rows[0].n as number;
const queueOf = async (conv: string): Promise<string | null> => (await admin.query(`SELECT queue_id FROM conversations WHERE id = $1`, [conv])).rows[0].queue_id as string | null;
const setQueue = (token: string, conv: string, queue_id: string) => call('PUT', `/conversations/${conv}/queue`, token, { queue_id });
const sell = (token: string, conv: string) => call('POST', '/sales', token, { conversation_id: conv, product_id: productId, amount: 25 }, { 'idempotency-key': `k-${randomUUID()}` });
const notes = (conv: string) => count(`SELECT count(*)::int n FROM messages WHERE conversation_id = '${conv}' AND sender_type = 'system' AND kind = 'note'`);
const audits = (conv: string) => admin.query(`SELECT old_value, new_value, source, actor_user_id FROM audit_logs WHERE entity_type = 'conversation' AND entity_id = $1 AND field = 'queue_id' ORDER BY at`, [conv]).then((r) => r.rows);
const linkChannel = (queue: string | null) => admin.query(`UPDATE channel_accounts SET queue_id = $2 WHERE id = $1`, [channelA, queue]);

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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
  const mkQueue = async (token: string, name: string): Promise<string> => (await json<{ id: string }>(await call('POST', '/queues', token, { name }))).id;
  sales = await mkQueue(T.alice, 'Ventas');
  support = await mkQueue(T.alice, 'Soporte');
  queueB = await mkQueue(T.bob, 'Ventas B');
  productId = (await json<{ id: string }>(await call('POST', `/queues/${sales}/products`, T.alice, { name: 'Corte de cabello', kind: 'service', price: 12.5 }))).id;
  const ch = await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN });
  expect(ch.status).toBe(201);
  channelA = (await json<{ id: string }>(ch)).id;
});

describe('asignar o cambiar el departamento', () => {
  it('asigna: cambia solo el departamento, deja nota y auditoría, no reparte ni toca dueño, estado ni ventas, y no consume el tope diario', async () => {
    const conv = await mkConv({ owner: null });
    const r = await setQueue(T.alice, conv, sales);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ id: conv, queue: { id: sales, name: 'Ventas' }, owner: null, warning: null, can: { set_queue: true } });
    const row = (await admin.query(`SELECT status, owner_id, assignment_source FROM conversations WHERE id = $1`, [conv])).rows[0];
    expect(row).toEqual({ status: 'unassigned', owner_id: null, assignment_source: 'manual' });
    expect(await notes(conv)).toBe(1);
    expect((await admin.query(`SELECT body, status FROM messages WHERE conversation_id = $1`, [conv])).rows[0]).toEqual({ body: 'Departamento asignado: Ventas (antes: ninguno).', status: 'internal' });
    expect(await audits(conv)).toEqual([{ old_value: null, new_value: sales, source: 'manual', actor_user_id: IDS.alice }]);
    expect(await count(`SELECT count(*)::int n FROM response_timers WHERE conversation_id = '${conv}'`)).toBe(0);
  });

  it('repetir el mismo departamento no cambia nada; cambiarlo dice cuál era; la venta ya registrada conserva el suyo', async () => {
    const conv = await mkConv({ queue: sales });
    expect((await sell(T.carol, conv)).status).toBe(201);
    expect((await setQueue(T.alice, conv, sales)).status).toBe(200);
    expect(await notes(conv)).toBe(0);
    expect(await audits(conv)).toEqual([]);
    expect((await setQueue(T.alice, conv, support)).status).toBe(200);
    expect(await queueOf(conv)).toBe(support);
    expect((await admin.query(`SELECT body FROM messages WHERE conversation_id = $1 AND sender_type = 'system'`, [conv])).rows).toEqual([{ body: 'Departamento asignado: Soporte (antes: Ventas).' }]);
    expect((await admin.query(`SELECT queue_id FROM sales WHERE conversation_id = $1`, [conv])).rows[0].queue_id).toBe(sales);
    expect((await admin.query(`SELECT owner_id, status FROM conversations WHERE id = $1`, [conv])).rows[0]).toEqual({ owner_id: IDS.carol, status: 'working' });
  });

  it('avisa si quien la tiene no pertenece al departamento, sin impedirlo', async () => {
    const conv = await mkConv();
    expect(await json(await setQueue(T.alice, conv, sales))).toMatchObject({ warning: 'OWNER_NOT_IN_QUEUE' });
    await admin.query(`INSERT INTO queue_members(organization_id, queue_id, user_id, active) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`, [ORG_A, support, IDS.carol]);
    expect(await json(await setQueue(T.alice, conv, support))).toMatchObject({ warning: null });
  });

  it('solo el administrador: la asesora recibe 403 y no cambia nada', async () => {
    const conv = await mkConv();
    expect((await setQueue(T.carol, conv, sales)).status).toBe(403);
    expect((await call('PUT', `/conversations/${conv}/queue`, undefined, { queue_id: sales })).status).toBe(401);
    expect(await queueOf(conv)).toBeNull();
    const view = await json<{ can: { set_queue: boolean } }>(await call('GET', `/conversations/${conv}`, T.carol));
    expect(view.can.set_queue).toBe(false);
  });

  it('departamento archivado, inexistente o de otra empresa → 404 QUEUE_NOT_FOUND; cuerpo inválido → 400', async () => {
    const conv = await mkConv();
    await admin.query(`UPDATE queues SET deleted_at = now() WHERE id = $1`, [support]);
    for (const q of [support, randomUUID(), queueB]) {
      const r = await setQueue(T.alice, conv, q);
      expect(r.status).toBe(404);
      expect(await code(r)).toBe('QUEUE_NOT_FOUND');
    }
    expect((await call('PUT', `/conversations/${conv}/queue`, T.alice, {})).status).toBe(400);
    expect((await call('PUT', `/conversations/${conv}/queue`, T.alice, { queue_id: sales, owner_id: IDS.alice })).status).toBe(400);
    expect(await queueOf(conv)).toBeNull();
  });

  it('aislamiento A↔B: la conversación de otra empresa, la eliminada y la inexistente responden el mismo 404', async () => {
    const conv = await mkConv();
    const gone = await mkConv({ deleted: true });
    expect((await setQueue(T.bob, conv, queueB)).status).toBe(404);
    expect((await setQueue(T.bob, conv, sales)).status).toBe(404);
    expect((await setQueue(T.alice, gone, sales)).status).toBe(404);
    expect((await setQueue(T.alice, randomUUID(), sales)).status).toBe(404);
    expect(await queueOf(conv)).toBeNull();
    expect(await queueOf(gone)).toBeNull();
    expect(await count(`SELECT count(*)::int n FROM audit_logs WHERE field = 'queue_id'`)).toBe(0);
  });
});

describe('registrar una venta sin departamento en la conversación', () => {
  it('si la conexión tiene departamento, lo muestra, vende con su catálogo y lo guarda en la conversación (nota y auditoría automática)', async () => {
    await linkChannel(sales);
    const conv = await mkConv();
    const o = await json(await call('GET', `/sales/options?conversation_id=${conv}`, T.carol));
    expect(o).toMatchObject({ queue: { id: sales, name: 'Ventas' }, blocked: null, products: [{ id: productId }] });
    expect(await queueOf(conv)).toBeNull(); // consultar no escribe
    expect((await sell(T.carol, conv)).status).toBe(201);
    expect(await queueOf(conv)).toBe(sales);
    expect((await admin.query(`SELECT queue_id FROM sales WHERE conversation_id = $1`, [conv])).rows[0].queue_id).toBe(sales);
    expect(await notes(conv)).toBe(1);
    expect(await audits(conv)).toEqual([{ old_value: null, new_value: sales, source: 'automation', actor_user_id: IDS.carol }]);
  });

  it('si la venta se rechaza, la conversación no queda cambiada', async () => {
    await linkChannel(support); // sin el producto
    const conv = await mkConv();
    expect(await code(await sell(T.carol, conv))).toBe('PRODUCT_UNAVAILABLE');
    expect(await queueOf(conv)).toBeNull();
    expect(await notes(conv)).toBe(0);
  });

  it('sin departamento en la conexión, o con uno archivado, sigue sin poderse vender', async () => {
    const conv = await mkConv();
    expect((await json(await call('GET', `/sales/options?conversation_id=${conv}`, T.carol)))).toMatchObject({ blocked: 'no_queue', queue: null });
    expect(await code(await sell(T.carol, conv))).toBe('SALE_NO_QUEUE');
    await linkChannel(sales);
    await admin.query(`UPDATE queues SET deleted_at = now() WHERE id = $1`, [sales]);
    expect(await code(await sell(T.carol, conv))).toBe('SALE_NO_QUEUE');
  });
});

describe('migración 0158: las conversaciones abiertas toman el departamento de su conexión', () => {
  it('con RLS forzada (como app_owner) actualiza las abiertas sin departamento y no toca finalizadas, eliminadas, las que ya tienen ni las de conexiones sin departamento vigente', async () => {
    await linkChannel(sales);
    const open = await mkConv();
    const unassigned = await mkConv({ owner: null });
    const closed = await mkConv({ status: 'closed' });
    const deleted = await mkConv({ deleted: true });
    const own = await mkConv({ queue: support });
    const chB = (await json<{ id: string }>(await call('POST', '/channels', T.bob, { name: 'B', waba_id: '2234567890123', phone_number_id: '2090123456789', access_token: FAKE_WHATSAPP_TOKEN }))).id;
    const withoutQueue = await mkConv({ org: ORG_B, channel: chB, owner: null });

    const owner = new Client({ connectionString: info.ownerUrl });
    await owner.connect();
    try {
      const block = MIGRATION.split('--> statement-breakpoint').find((s) => s.includes('DO $$'))!;
      await owner.query(block);
      await owner.query(block); // repetirla no cambia nada
    } finally {
      await owner.end();
    }
    expect(await queueOf(open)).toBe(sales);
    expect(await queueOf(unassigned)).toBe(sales);
    expect(await queueOf(closed)).toBeNull();
    expect(await queueOf(deleted)).toBeNull();
    expect(await queueOf(own)).toBe(support);
    expect(await queueOf(withoutQueue)).toBeNull();
    expect((await admin.query(`SELECT assignment_source, status, owner_id FROM conversations WHERE id = $1`, [open])).rows[0]).toEqual({ assignment_source: 'manual', status: 'working', owner_id: IDS.carol });
  });
});
