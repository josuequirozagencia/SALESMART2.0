// M6.2 — Ventas, abonos y saldo (ADR-08/18/32/51; F14). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/sales/options
//   GET /v1/sales/settings
//   PUT /v1/sales/settings
//   GET /v1/sales/change-requests
//   POST /v1/sales/change-requests/:id/resolve
//   POST /v1/sales
//   GET /v1/sales
//   GET /v1/sales/:id
//   POST /v1/sales/:id/payments
//   POST /v1/sales/:id/corrections
//   POST /v1/sales/:id/cancel
//   POST /v1/sales/:id/change-requests
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
  eve: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob', string>;
let queueA = '';
let productA = '';
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
  await admin.query('TRUNCATE sale_change_requests, sale_payments, sale_status_history, sales, meta_events, response_timers, messages, conversation_participants, conversations, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, contact_phones, contacts, queue_products, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
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

interface Sale { id: string; amount: string; paid: string; balance: string; collected: boolean; status: string; currency: string; seller: { id: string; name: string } | null; product: { name: string }; contact: { id: string; name: string }; purchase: string | null; open_requests: number }
interface Detail extends Sale { payments: Array<{ kind: string; amount: string; method: string | null; reason: string | null }>; history: Array<{ from: string | null; to: string; reason: string | null }>; purchase_at_cancel: string | null; can: { pay: boolean; cancel: boolean; correct: boolean; request_change: boolean }; change_requests: Array<{ id: string; status: string }> }
interface ProductDto { id: string }

let seq = 0;
/** Una conversación de la cola de A con su contacto (con clic de anuncio de Meta para que el Purchase sea atribuible). */
async function mkConv(o: { owner?: string | null; queue?: string | null; ctwa?: boolean; org?: string } = {}): Promise<{ conv: string; contact: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const queue = o.queue === undefined ? queueA : o.queue;
  const phone = `+59398900${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id, ctwa_cl_id) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [org, `Cliente ${seq}`, owner, o.ctwa === false ? null : `ctwa-${seq}`])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, queue_id, status, owner_id, assigned_at, last_message_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END, now(), 0, $7) RETURNING id`, [org, contact, channelA, queue, owner ? 'working' : 'unassigned', owner, phone.replace('+', '')])).rows[0].id as string;
  return { conv, contact };
}
const sell = (token: string, body: Record<string, unknown>, k = key()) => call('POST', '/sales', token, body, idem(k));
const mk = async (conv: string, body: Record<string, unknown> = {}, token = T.carol): Promise<Sale> => {
  const r = await sell(token, { conversation_id: conv, product_id: productA, amount: 25, ...body });
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(201);
  return json<Sale>(r);
};
const detail = async (id: string, token = T.alice): Promise<Detail> => {
  const r = await call('GET', `/sales/${id}`, token);
  expect(r.status).toBe(200);
  return json<Detail>(r);
};
const pay = (token: string, id: string, amount: number | string, k = key(), method = 'cash') => call('POST', `/sales/${id}/payments`, token, { amount, method }, idem(k));
const count = async (sql: string): Promise<number> => (await admin.query(sql)).rows[0].n as number;

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
  queueA = (await json<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas' }))).id;
  productA = (await json<ProductDto>(await call('POST', `/queues/${queueA}/products`, T.alice, { name: 'Corte de cabello', kind: 'service', price: 12.5 }))).id;
  const ch = await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN });
  expect(ch.status).toBe(201);
  channelA = (await json<{ id: string }>(ch)).id;
});

describe('registrar una venta', () => {
  it('crea la venta con su abono: total exacto, saldo derivado, etiqueta Venta, oportunidad ganada y el Purchase a Meta por el TOTAL en espera', async () => {
    const { conv, contact } = await mkConv();
    const opp = await json<{ id: string }>(await call('POST', '/opportunities', T.carol, { contact_id: contact }));
    const r = await sell(T.carol, { conversation_id: conv, product_id: productA, quantity: 2, amount: '25', down_payment: '10.1', method: 'cash', note: 'Corte y barba' });
    expect(r.status).toBe(201);
    const s = await json<Sale>(r);
    expect(s).toMatchObject({ amount: '25.00', paid: '10.10', balance: '14.90', collected: false, status: 'active', currency: 'USD', seller: { id: IDS.carol }, product: { name: 'Corte de cabello' }, purchase: 'pending' });
    // Efectos: etiqueta, oportunidad, Purchase por el total, historial y auditoría
    expect(await count(`SELECT count(*)::int n FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = '${contact}' AND t.system_key = 'sale'`)).toBe(1);
    expect((await admin.query(`SELECT status FROM opportunities WHERE id = $1`, [opp.id])).rows[0].status).toBe('won');
    expect((await admin.query(`SELECT opportunity_id FROM sales WHERE id = $1`, [s.id])).rows[0].opportunity_id).toBe(opp.id);
    const ev = (await admin.query(`SELECT event_id, type, status, payload FROM meta_events WHERE event_id = $1`, [`purchase:${s.id}`])).rows[0];
    expect(ev).toMatchObject({ type: 'Purchase', status: 'pending' });
    expect(ev.payload.custom_data).toEqual({ value: 25, currency: 'USD' });
    const d = await detail(s.id);
    expect(d.history).toEqual([{ from: null, to: 'active', reason: null, by: { id: IDS.carol, name: 'Carolina Vera' }, at: expect.any(String) }]);
    expect(d.payments).toHaveLength(1);
    expect(await count(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'sale' AND entity_id = '${s.id}'`)).toBe(1);
  });

  it('sin abono queda todo por cobrar; un abono igual al total la deja cobrada', async () => {
    const { conv } = await mkConv();
    const a = await mk(conv);
    expect(a).toMatchObject({ paid: '0.00', balance: '25.00', collected: false });
    const { conv: c2 } = await mkConv();
    const b = await mk(c2, { down_payment: 25, method: 'card' });
    expect(b).toMatchObject({ paid: '25.00', balance: '0.00', collected: true });
  });

  it('la llave de idempotencia es obligatoria; repetirla devuelve la misma venta (200) sin duplicar la venta, el abono ni el Purchase', async () => {
    const { conv } = await mkConv();
    const body = { conversation_id: conv, product_id: productA, amount: 25, down_payment: 5, method: 'cash' };
    const missing = await call('POST', '/sales', T.carol, body);
    expect(missing.status).toBe(400);
    expect((await call('POST', '/sales', T.carol, body, idem('corta'))).status).toBe(400);
    const k = key();
    const first = await sell(T.carol, body, k);
    expect(first.status).toBe(201);
    const again = await sell(T.carol, body, k);
    expect(again.status).toBe(200);
    expect((await json<Sale>(again)).id).toBe((await json<Sale>(first)).id);
    expect(await count(`SELECT count(*)::int n FROM sales`)).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM sale_payments`)).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM meta_events WHERE type = 'Purchase'`)).toBe(1);
  });

  it('una llave repetida con otros datos o de otra persona es un error; cinco peticiones simultáneas con la misma llave crean UNA venta', async () => {
    const { conv } = await mkConv();
    const k = key();
    expect((await sell(T.carol, { conversation_id: conv, product_id: productA, amount: 25 }, k)).status).toBe(201);
    const other = await sell(T.carol, { conversation_id: conv, product_id: productA, amount: 30 }, k);
    expect(other.status).toBe(409);
    expect(await code(other)).toBe('IDEMPOTENCY_MISMATCH');
    const theft = await sell(T.alice, { conversation_id: conv, product_id: productA, amount: 25 }, k);
    expect(theft.status).toBe(409);
    expect(await code(theft)).toBe('IDEMPOTENCY_CONFLICT');
    const { conv: c2 } = await mkConv();
    const k2 = key();
    const rs = await Promise.all(Array.from({ length: 5 }, () => sell(T.carol, { conversation_id: c2, product_id: productA, amount: 40 }, k2)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await count(`SELECT count(*)::int n FROM sales WHERE conversation_id = '${c2}'`)).toBe(1);
  });

  it('valida lo que el formulario ya valida: monto, abono mayor al total, abono sin método, producto y conversación', async () => {
    const { conv } = await mkConv();
    const bad = async (body: Record<string, unknown>, status = 400) => { const r = await sell(T.carol, { conversation_id: conv, product_id: productA, amount: 25, ...body }); expect(r.status, JSON.stringify(body)).toBe(status); return r; };
    await bad({ amount: 0 });
    await bad({ amount: -5 });
    await bad({ amount: '12.345' });
    await bad({ amount: 'mucho' });
    await bad({ down_payment: 30, method: 'cash' });
    await bad({ down_payment: 5 }); // sin método
    await bad({ quantity: 0 });
    await bad({ method: 'bitcoin', down_payment: 1 });
    await bad({ extra: 1 });
    expect(await count(`SELECT count(*)::int n FROM sales`)).toBe(0);
    // un producto desactivado, de otra cola o inexistente
    await call('PATCH', `/queues/${queueA}/products/${productA}`, T.alice, { active: false });
    expect(await code(await bad({}, 409))).toBe('PRODUCT_UNAVAILABLE');
    expect(await code(await bad({ product_id: randomUUID() }, 409))).toBe('PRODUCT_UNAVAILABLE');
  });

  it('sin cola o sin asesor no se vende; quien no ve la conversación recibe 404; un administrador vende por la asesora y ella es la vendedora', async () => {
    const noQueue = await mkConv({ queue: null });
    const r1 = await sell(T.carol, { conversation_id: noQueue.conv, product_id: productA, amount: 25 });
    expect(r1.status).toBe(409);
    expect(await code(r1)).toBe('SALE_NO_QUEUE');
    const unassigned = await mkConv({ owner: null });
    expect(await code(await sell(T.alice, { conversation_id: unassigned.conv, product_id: productA, amount: 25 }))).toBe('CONVERSATION_UNASSIGNED');
    const carols = await mkConv();
    expect((await sell(T.eve, { conversation_id: carols.conv, product_id: productA, amount: 25 })).status).toBe(404);
    const viaAdmin = await sell(T.alice, { conversation_id: carols.conv, product_id: productA, amount: 25 });
    expect(viaAdmin.status).toBe(201);
    expect((await json<Sale>(viaAdmin)).seller).toMatchObject({ id: IDS.carol });
  });

  it('GET /v1/sales/options trae la cola, los productos activos y la moneda; explica por qué no se puede vender', async () => {
    const ok = await mkConv();
    const o = await json<{ currency: string; queue: { id: string } | null; products: Array<{ name: string; price: string }>; blocked: string | null }>(await call('GET', `/sales/options?conversation_id=${ok.conv}`, T.carol));
    expect(o).toMatchObject({ currency: 'USD', queue: { id: queueA }, products: [{ name: 'Corte de cabello', price: '12.50' }], blocked: null });
    const noQ = await mkConv({ queue: null });
    expect((await json<{ blocked: string }>(await call('GET', `/sales/options?conversation_id=${noQ.conv}`, T.carol))).blocked).toBe('no_queue');
    const un = await mkConv({ owner: null });
    expect((await json<{ blocked: string }>(await call('GET', `/sales/options?conversation_id=${un.conv}`, T.alice))).blocked).toBe('unassigned');
    expect((await call('GET', `/sales/options?conversation_id=${ok.conv}`, T.eve)).status).toBe(404);
    expect((await call('GET', `/sales/options`, T.carol)).status).toBe(400);
  });
});

describe('abonos y saldo', () => {
  it('un abono baja el saldo; el que lo completa deja la venta cobrada; uno que se pasa del saldo se rechaza', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv, { down_payment: 10, method: 'cash' });
    const r1 = await pay(T.carol, s.id, '5.5');
    expect(r1.status).toBe(201);
    expect(await json<Detail>(r1)).toMatchObject({ paid: '15.50', balance: '9.50', collected: false });
    const over = await pay(T.carol, s.id, '9.51');
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('PAYMENT_EXCEEDS_BALANCE');
    const last = await json<Detail>(await pay(T.carol, s.id, '9.50', key(), 'transfer'));
    expect(last).toMatchObject({ paid: '25.00', balance: '0.00', collected: true });
    expect(last.can.pay).toBe(false);
    expect(await code(await pay(T.carol, s.id, 1))).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(last.payments.map((p) => [p.kind, p.amount, p.method])).toEqual([['payment', '10.00', 'cash'], ['payment', '5.50', 'cash'], ['payment', '9.50', 'transfer']]);
  });

  it('el mismo abono con la misma llave no se repite (200); con otra llave pero los mismos datos sí es otro abono', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv);
    const k = key();
    expect((await pay(T.carol, s.id, 5, k)).status).toBe(201);
    const again = await pay(T.carol, s.id, 5, k);
    expect(again.status).toBe(200);
    expect((await json<Detail>(again)).paid).toBe('5.00');
    expect(await count(`SELECT count(*)::int n FROM sale_payments`)).toBe(1);
    expect((await pay(T.carol, s.id, 5)).status).toBe(201);
    // misma llave con otro monto o en otra venta: error
    const k2 = key();
    await pay(T.carol, s.id, 2, k2);
    expect(await code(await pay(T.carol, s.id, 3, k2))).toBe('IDEMPOTENCY_MISMATCH');
    const { conv: c2 } = await mkConv();
    const other = await mk(c2);
    expect(await code(await pay(T.carol, other.id, 2, k2))).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('abonos simultáneos nunca se pasan del saldo: con 10 por cobrar, cinco abonos de 4 dejan exactamente dos', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv, { amount: 10 });
    const rs = await Promise.all(Array.from({ length: 5 }, () => pay(T.carol, s.id, 4)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await detail(s.id)).toMatchObject({ paid: '8.00', balance: '2.00' });
    expect(await count(`SELECT count(*)::int n FROM sale_payments WHERE sale_id = '${s.id}'`)).toBe(2);
  });

  it('abonos con montos inválidos, sin método o sin llave se rechazan', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv);
    for (const amount of [0, -1, '1.234', 'x']) expect((await pay(T.carol, s.id, amount)).status, String(amount)).toBe(400);
    expect((await call('POST', `/sales/${s.id}/payments`, T.carol, { amount: 5 }, idem())).status).toBe(400);
    expect((await call('POST', `/sales/${s.id}/payments`, T.carol, { amount: 5, method: 'cash' })).status).toBe(400);
  });

  it('una corrección (solo administrador, con motivo) resta de lo cobrado sin borrar el abono; no puede superar lo cobrado', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv, { down_payment: 20, method: 'cash' });
    const body = { amount: 5, reason: 'Se registró de más' };
    expect((await call('POST', `/sales/${s.id}/corrections`, T.carol, body)).status).toBe(403);
    expect((await call('POST', `/sales/${s.id}/corrections`, T.alice, { amount: 5 })).status).toBe(400);
    expect(await code(await call('POST', `/sales/${s.id}/corrections`, T.alice, { amount: 21, reason: 'x' }))).toBe('CORRECTION_EXCEEDS_PAID');
    const r = await call('POST', `/sales/${s.id}/corrections`, T.alice, body);
    expect(r.status).toBe(201);
    const d = await json<Detail>(r);
    expect(d).toMatchObject({ paid: '15.00', balance: '10.00' });
    expect(d.payments.map((p) => [p.kind, p.amount, p.reason])).toEqual([['payment', '20.00', null], ['correction', '5.00', 'Se registró de más']]);
    expect(await count(`SELECT count(*)::int n FROM sale_payments`)).toBe(2); // nada se borró ni se editó
  });
});

describe('anular', () => {
  it('solo quien tiene sales.cancel anula, con motivo: el Purchase pendiente se cancela y Meta nunca lo recibe; los abonos y el historial se conservan', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv, { down_payment: 10, method: 'cash' });
    expect((await call('POST', `/sales/${s.id}/cancel`, T.carol, { reason: 'Error' })).status).toBe(403);
    expect((await call('POST', `/sales/${s.id}/cancel`, T.alice, {})).status).toBe(400);
    const r = await call('POST', `/sales/${s.id}/cancel`, T.alice, { reason: 'El cliente se arrepintió' });
    expect(r.status).toBe(200);
    const d = await json<Detail>(r);
    expect(d).toMatchObject({ status: 'cancelled', balance: '0.00', collected: false, purchase_at_cancel: 'cancelled', purchase: 'cancelled' });
    expect(d.history.map((h) => [h.from, h.to, h.reason])).toEqual([[null, 'active', null], ['active', 'cancelled', 'El cliente se arrepintió']]);
    expect(d.payments).toHaveLength(1);
    expect((await admin.query(`SELECT status FROM meta_events WHERE event_id = $1`, [`purchase:${s.id}`])).rows[0].status).toBe('cancelled');
    expect(await code(await call('POST', `/sales/${s.id}/cancel`, T.alice, { reason: 'otra vez' }))).toBe('SALE_ALREADY_CANCELLED');
    expect(await code(await pay(T.carol, s.id, 1))).toBe('SALE_CANCELLED');
    expect(d.can).toEqual({ pay: false, cancel: false, correct: false, request_change: false });
  });

  it('si el Purchase ya salió a Meta antes de anular, queda anotado en la venta (no hay evento de cancelación en Meta)', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv);
    await admin.query(`UPDATE meta_events SET status = 'sent' WHERE event_id = $1`, [`purchase:${s.id}`]);
    const d = await json<Detail>(await call('POST', `/sales/${s.id}/cancel`, T.alice, { reason: 'Devolución' }));
    expect(d).toMatchObject({ status: 'cancelled', purchase_at_cancel: 'sent', purchase: 'sent' });
  });

  it('un contacto que no llegó por un anuncio no genera Purchase atribuible: queda omitido con su motivo', async () => {
    const { conv } = await mkConv({ ctwa: false });
    const s = await mk(conv);
    expect(s.purchase).toBe('skipped');
    const d = await json<Detail>(await call('POST', `/sales/${s.id}/cancel`, T.alice, { reason: 'Prueba' }));
    expect(d.purchase_at_cancel).toBe('skipped');
  });
});

describe('quién ve qué y aislamiento A↔B', () => {
  it('la asesora ve solo sus ventas; otra asesora, ninguna; el administrador, todas; la lista pagina por cursor', async () => {
    const [a, b, c] = [await mkConv(), await mkConv(), await mkConv()];
    const s1 = await mk(a.conv);
    const s2 = await mk(b.conv);
    const s3 = await mk(c.conv);
    const ids = (r: { items: Sale[] }) => r.items.map((x) => x.id);
    const carol = await json<{ items: Sale[]; next_cursor: string | null }>(await call('GET', '/sales', T.carol));
    expect(ids(carol).sort()).toEqual([s1.id, s2.id, s3.id].sort());
    expect(carol.items[0]!.id).toBe(s3.id); // la más reciente primero
    expect(ids(await json(await call('GET', '/sales', T.eve)))).toEqual([]);
    expect(ids(await json(await call('GET', `/sales?seller_id=${IDS.carol}`, T.eve)))).toEqual([]); // el filtro no amplía lo que ve
    const all = await json<{ items: Sale[]; next_cursor: string | null }>(await call('GET', '/sales?limit=2', T.alice));
    expect(all.items).toHaveLength(2);
    expect(all.next_cursor).not.toBeNull();
    const page2 = await json<{ items: Sale[]; next_cursor: string | null }>(await call('GET', `/sales?limit=2&cursor=${all.next_cursor}`, T.alice));
    expect(page2.items.map((x) => x.id)).toEqual([s1.id]);
    expect(page2.next_cursor).toBeNull();
    expect((await call('GET', '/sales?cursor=basura', T.alice)).status).toBe(400);
    await pay(T.carol, s1.id, 25);
    expect(ids(await json(await call('GET', '/sales?collected=yes', T.alice)))).toEqual([s1.id]);
    expect(ids(await json(await call('GET', '/sales?collected=no', T.alice))).sort()).toEqual([s2.id, s3.id].sort());
    await call('POST', `/sales/${s2.id}/cancel`, T.alice, { reason: 'x' });
    expect(ids(await json(await call('GET', '/sales?status=cancelled', T.alice)))).toEqual([s2.id]);
  });

  it('el detalle, los abonos y las anulaciones de una venta que no es tuya o es de otra empresa responden 404 uniforme', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv);
    for (const [token, who] of [[T.eve, 'eve'], [T.bob, 'bob']] as const) {
      expect((await call('GET', `/sales/${s.id}`, token)).status, who).toBe(404);
      expect((await pay(token, s.id, 1)).status, who).toBe(404);
      expect((await call('POST', `/sales/${s.id}/change-requests`, token, { reason: 'x' })).status, who).toBe(404);
    }
    expect((await call('POST', `/sales/${s.id}/cancel`, T.bob, { reason: 'x' })).status).toBe(404);
    expect((await call('POST', `/sales/${s.id}/corrections`, T.bob, { amount: 1, reason: 'x' })).status).toBe(404);
    expect((await call('GET', `/sales/${randomUUID()}`, T.alice)).status).toBe(404);
    const bobList = await json<{ items: Sale[] }>(await call('GET', '/sales', T.bob));
    expect(bobList.items).toEqual([]);
    expect((await detail(s.id)).paid).toBe('0.00');
  });

  it('no se vende desde la conversación de otra empresa, aunque se conozca su identificador', async () => {
    const { conv } = await mkConv();
    const r = await sell(T.bob, { conversation_id: conv, product_id: productA, amount: 25 });
    expect(r.status).toBe(404); // la RLS acota la consulta a SU empresa: para B esa conversación no existe
  });

  it('sin sesión, 401; un asesor no administra ajustes, anulaciones ni solicitudes ajenas', async () => {
    expect((await call('GET', '/sales')).status).toBe(401);
    expect((await call('GET', '/sales/change-requests', T.carol)).status).toBe(403);
    expect((await call('PUT', '/sales/settings', T.carol, { currency: 'EUR' })).status).toBe(403);
  });
});

describe('solicitudes de corrección', () => {
  it('el asesor la pide, el administrador la ve y la resuelve; no se resuelve dos veces; hay un tope de abiertas por venta', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv);
    expect((await call('POST', `/sales/${s.id}/change-requests`, T.carol, {})).status).toBe(400);
    const r = await call('POST', `/sales/${s.id}/change-requests`, T.carol, { reason: 'El total es 30, no 25' });
    expect(r.status).toBe(201);
    const req = await json<{ id: string; status: string; requested_by: { name: string } }>(r);
    expect(req).toMatchObject({ status: 'open', requested_by: { name: 'Carolina Vera' } });
    expect((await detail(s.id, T.carol)).open_requests).toBe(1);
    const list = await json<{ items: Array<{ id: string; sale: { id: string; contact: string; amount: string } }> }>(await call('GET', '/sales/change-requests', T.alice));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.sale).toMatchObject({ id: s.id, amount: '25.00' });
    expect((await call('POST', `/sales/change-requests/${req.id}/resolve`, T.carol, { status: 'resolved' })).status).toBe(403);
    const done = await call('POST', `/sales/change-requests/${req.id}/resolve`, T.alice, { status: 'resolved', note: 'Corregida' });
    expect(done.status).toBe(200);
    expect(await json(done)).toMatchObject({ status: 'resolved', resolved_by: { name: 'Alicia Torres' }, resolution_note: 'Corregida' });
    expect(await code(await call('POST', `/sales/change-requests/${req.id}/resolve`, T.alice, { status: 'dismissed' }))).toBe('REQUEST_RESOLVED');
    expect((await json<{ items: unknown[] }>(await call('GET', '/sales/change-requests', T.alice))).items).toEqual([]);
    for (let i = 0; i < 5; i++) expect((await call('POST', `/sales/${s.id}/change-requests`, T.carol, { reason: `pedido ${i}` })).status).toBe(201);
    expect(await code(await call('POST', `/sales/${s.id}/change-requests`, T.carol, { reason: 'uno más' }))).toBe('REQUEST_LIMIT');
  });

  it('otra empresa no resuelve ni ve las solicitudes de esta', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv);
    const req = await json<{ id: string }>(await call('POST', `/sales/${s.id}/change-requests`, T.carol, { reason: 'x' }));
    expect((await call('POST', `/sales/change-requests/${req.id}/resolve`, T.bob, { status: 'dismissed' })).status).toBe(404);
    expect((await json<{ items: unknown[] }>(await call('GET', '/sales/change-requests', T.bob))).items).toEqual([]);
  });
});

describe('moneda de la empresa', () => {
  it('se consulta, el administrador la cambia mientras no haya ventas y queda bloqueada después', async () => {
    expect(await json(await call('GET', '/sales/settings', T.carol))).toEqual({ currency: 'USD', locked: false });
    expect((await call('PUT', '/sales/settings', T.alice, { currency: 'XXXX' })).status).toBe(400);
    expect((await call('PUT', '/sales/settings', T.alice, { currency: 'ZZZ' })).status).toBe(400);
    const r = await call('PUT', '/sales/settings', T.alice, { currency: 'eur' });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ currency: 'EUR', locked: false });
    const { conv } = await mkConv();
    expect((await mk(conv)).currency).toBe('EUR');
    expect(await json(await call('GET', '/sales/settings', T.alice))).toEqual({ currency: 'EUR', locked: true });
    const locked = await call('PUT', '/sales/settings', T.alice, { currency: 'USD' });
    expect(locked.status).toBe(409);
    expect(await code(locked)).toBe('CURRENCY_LOCKED');
    expect((await call('PUT', '/sales/settings', T.alice, { currency: 'EUR' })).status).toBe(200); // lo mismo no es un cambio
    // la moneda de B no cambió
    expect(await json(await call('GET', '/sales/settings', T.bob))).toEqual({ currency: 'USD', locked: false });
  });
});

describe('base de datos', () => {
  const asApp = async <X,>(fn: (c: Client) => Promise<X>): Promise<X> => {
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  };

  it('la aplicación no puede borrar ventas, abonos ni historial, ni editar ni borrar un abono; la RLS esconde las de otra empresa', async () => {
    const { conv } = await mkConv();
    const s = await mk(conv, { down_payment: 5, method: 'cash' });
    await asApp(async (c) => {
      for (const t of ['sales', 'sale_payments', 'sale_status_history', 'sale_change_requests']) await expect(c.query(`DELETE FROM ${t}`), t).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE sale_payments SET amount = 1`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE sale_status_history SET to_status = 'active'`)).rejects.toThrow(/permission denied/);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      expect((await c.query(`SELECT count(*)::int n FROM sales`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM sale_payments`)).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    });
    expect(s.id).toBeTruthy();
  });

  it('la base rechaza lo que el servidor ya filtra: total o abono no positivos, corrección sin motivo, abono sin método, venta anulada a medias', async () => {
    const { conv, contact } = await mkConv();
    const s = await mk(conv);
    const ins = (cols: string, vals: string, args: unknown[] = []) => admin.query(`INSERT INTO sale_payments(organization_id, id, sale_id, ${cols}, created_by) VALUES ($1, gen_random_uuid(), $2, ${vals}, $3)`, [ORG_A, s.id, IDS.carol, ...args]);
    await expect(ins('kind, amount, method', `'payment', 0, 'cash'`)).rejects.toThrow(/sale_payments_amount_valid/);
    await expect(ins('kind, amount, method', `'payment', 5, NULL`)).rejects.toThrow(/sale_payments_shape/);
    await expect(ins('kind, amount', `'correction', 5`)).rejects.toThrow(/sale_payments_shape/);
    await expect(admin.query(`UPDATE sales SET status = 'cancelled' WHERE id = $1`, [s.id])).rejects.toThrow(/sales_cancel_consistent/);
    await expect(admin.query(`UPDATE sales SET amount = 0 WHERE id = $1`, [s.id])).rejects.toThrow(/sales_amount_valid/);
    expect(contact).toBeTruthy();
  });
});
