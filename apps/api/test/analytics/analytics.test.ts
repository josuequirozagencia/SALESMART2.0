// M6.5 — Tablero y analítica (ADR-51). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/analytics/summary
//   GET /v1/analytics/reports/:name
//   POST /v1/analytics/export
//   GET /v1/analytics/exports
//   GET /v1/analytics/settings
//   PUT /v1/analytics/settings
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AnalyticsModule } from '../../src/modules/analytics';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, AnalyticsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const TZ = 'America/Guayaquil'; // UTC−5
const FROM = '2026-10-01T05:00:00.000Z'; // 1 oct 00:00 en Guayaquil
const TO = '2026-11-01T05:00:00.000Z';
const q = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob', string>;
const saved = { ...process.env };
let queueA = '';
let productA = '';
let channelA = '';
let queueB = '';
let productB = '';

async function seed(): Promise<void> {
  await admin.query('TRUNCATE analytics_exports, analytics_settings, sale_payments, sales, appointment_reminders, appointments, response_timers, messages, conversations, whatsapp_accounts, channel_accounts, queue_products, queues, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, TZ]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
  const mk = async (org: string, name: string) => {
    const queue = (await admin.query(`INSERT INTO queues(organization_id, id, name) VALUES ($1, gen_random_uuid(), $2) RETURNING id`, [org, name])).rows[0].id as string;
    const product = (await admin.query(`INSERT INTO queue_products(organization_id, id, queue_id, name, price) VALUES ($1, gen_random_uuid(), $2, 'Corte', 10) RETURNING id`, [org, queue])).rows[0].id as string;
    const channel = (await admin.query(`INSERT INTO channel_accounts(organization_id, id, provider, name) VALUES ($1, gen_random_uuid(), 'meta_cloud', $2) RETURNING id`, [org, name])).rows[0].id as string;
    return { queue, product, channel };
  };
  ({ queue: queueA, product: productA, channel: channelA } = await mk(ORG_A, 'Ventas A'));
  ({ queue: queueB, product: productB } = await mk(ORG_B, 'Ventas B'));
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;

let seq = 0;
async function contact(org: string, owner: string | null, createdAt: string, name?: string): Promise<string> {
  seq += 1;
  const id = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [org, name ?? `Cliente ${seq}`, owner, createdAt])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, id, `+59397100${String(seq).padStart(4, '0')}`]);
  return id;
}
/** Una venta con su abono inicial (fila de `sale_payments`); `status` cancelled exige los datos de anulación. */
async function sale(o: { org?: string; seller: string; contact: string; at: string; amount: number; paid?: number; status?: 'active' | 'cancelled'; product?: string }): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const [queue, product] = org === ORG_A ? [queueA, productA] : [queueB, productB];
  const cancelled = o.status === 'cancelled';
  const id = (
    await admin.query(
      `INSERT INTO sales(organization_id, id, contact_id, queue_id, product_id, product_name, product_kind, quantity, amount, currency, status, seller_id, idempotency_key, created_by, created_at, cancelled_at, cancelled_by, cancel_reason)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'service', 1, $6, 'USD', $7, $8, $9, $8, $10, $11, $12, $13) RETURNING id`,
      [org, o.contact, queue, product, o.product ?? 'Corte', o.amount, o.status ?? 'active', o.seller, `key-${seq}-${Math.random()}`.padEnd(10, 'x'), o.at, cancelled ? o.at : null, cancelled ? o.seller : null, cancelled ? 'Error' : null],
    )
  ).rows[0].id as string;
  if (o.paid) await admin.query(`INSERT INTO sale_payments(organization_id, id, sale_id, kind, amount, method, created_by, created_at) VALUES ($1, gen_random_uuid(), $2, 'payment', $3, 'cash', $4, $5)`, [org, id, o.paid, o.seller, o.at]);
  return id;
}
async function appointment(o: { org?: string; owner: string; contact: string; at: string; status?: 'scheduled' | 'completed' | 'cancelled'; kind?: string }): Promise<string> {
  seq += 1;
  const cancelled = o.status === 'cancelled';
  return (
    await admin.query(
      `INSERT INTO appointments(organization_id, id, contact_id, owner_id, starts_at, kind, status, idempotency_key, created_by, completed_at, cancelled_at, cancelled_by, cancel_reason)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $3, $8, $9, $10, $11) RETURNING id`,
      [o.org ?? ORG_A, o.contact, o.owner, o.at, o.kind ?? 'Cita', o.status ?? 'scheduled', `akey-${seq}-${Math.random()}`.padEnd(10, 'x'), o.status === 'completed' ? o.at : null, cancelled ? o.at : null, cancelled ? o.owner : null, cancelled ? 'No puede' : null],
    )
  ).rows[0].id as string;
}
/** Un cronómetro de primera respuesta ya detenido por una respuesta humana. */
async function firstResponse(o: { owner: string; contactId: string; stoppedAt: string; seconds: number }): Promise<void> {
  const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), '593971000000') RETURNING id`, [ORG_A, o.contactId, channelA, o.owner])).rows[0].id as string;
  await admin.query(`INSERT INTO response_timers(id, organization_id, conversation_id, kind, owner_id, started_at, due_at, stopped_at, stop_reason, response_seconds) VALUES (gen_random_uuid(), $1, $2, 'first', $3, $4, $4, $4, 'human_reply', $5)`, [ORG_A, conv, o.owner, o.stoppedAt, o.seconds]);
}

/** Un escenario con cifras conocidas: Carolina y Eva en la empresa A, y datos de B que no deben mezclarse. */
async function scenario(): Promise<void> {
  const c1 = await contact(ORG_A, IDS.carol, '2026-10-05T15:00:00.000Z');
  const c2 = await contact(ORG_A, IDS.carol, '2026-10-06T15:00:00.000Z');
  const c3 = await contact(ORG_A, IDS.eve, '2026-10-07T15:00:00.000Z');
  await contact(ORG_A, IDS.eve, '2026-09-15T15:00:00.000Z'); // fuera del periodo
  const noOwner = await contact(ORG_A, null, '2026-10-08T15:00:00.000Z');
  // 2026-10-05T15:00Z son las 10:00 del 5 de octubre en Guayaquil; 2026-11-01T03:00Z es todavía 31 de octubre (22:00)
  await sale({ seller: IDS.carol, contact: c1, at: '2026-10-05T15:00:00.000Z', amount: 100, paid: 40 });
  await sale({ seller: IDS.carol, contact: c2, at: '2026-10-06T15:00:00.000Z', amount: 50, paid: 50 });
  await sale({ seller: IDS.carol, contact: c2, at: '2026-10-07T15:00:00.000Z', amount: 30, status: 'cancelled' });
  await sale({ seller: IDS.eve, contact: c3, at: '2026-11-01T03:00:00.000Z', amount: 200, paid: 0 });
  await sale({ seller: IDS.eve, contact: c3, at: '2026-11-01T05:00:00.000Z', amount: 999 }); // justo en el límite (exclusivo): no entra
  await appointment({ owner: IDS.carol, contact: c1, at: '2026-10-10T15:00:00.000Z', status: 'completed', kind: 'Corte' });
  await appointment({ owner: IDS.carol, contact: c2, at: '2026-10-11T15:00:00.000Z', status: 'scheduled' });
  await appointment({ owner: IDS.eve, contact: c3, at: '2026-10-12T15:00:00.000Z', status: 'cancelled' });
  await firstResponse({ owner: IDS.carol, contactId: c1, stoppedAt: '2026-10-05T16:00:00.000Z', seconds: 60 });
  await firstResponse({ owner: IDS.carol, contactId: c2, stoppedAt: '2026-10-06T16:00:00.000Z', seconds: 180 });
  await firstResponse({ owner: IDS.eve, contactId: c3, stoppedAt: '2026-10-07T16:00:00.000Z', seconds: 600 });
  // Empresa B: no debe aparecer en nada de A
  const b1 = await contact(ORG_B, IDS.bob, '2026-10-05T15:00:00.000Z', 'Cliente de B');
  await sale({ org: ORG_B, seller: IDS.bob, contact: b1, at: '2026-10-05T15:00:00.000Z', amount: 5000, paid: 5000 });
  await appointment({ org: ORG_B, owner: IDS.bob, contact: b1, at: '2026-10-10T15:00:00.000Z' });
  void noOwner;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test') };
});

interface Summary {
  scope: string; currency: string; timezone: string; leads: number;
  appointments: { total: number; scheduled: number; completed: number; cancelled: number };
  sales: { count: number; cancelled: number; revenue: string; paid: string; balance: string };
  funnel: Array<{ pipeline: string; stage: string; kind: string; count: number; amount: string }>;
  response: { count: number; avg_seconds: number; median_seconds: number };
  series: Array<{ day: string; leads: number; sales: number; revenue: string }>;
}
interface Report { report: string; title: string; columns: Array<{ key: string; label: string; type: string }>; rows: Array<Record<string, unknown>>; totals: Record<string, string | number> | null; truncated: boolean; timezone: string }
const summary = async (token: string, extra = ''): Promise<Summary> => {
  const r = await call('GET', `/analytics/summary?${q}${extra}`, token);
  expect(r.status).toBe(200);
  return json<Summary>(r);
};
const report = async (token: string, name: string): Promise<Report> => {
  const r = await call('GET', `/analytics/reports/${name}?${q}`, token);
  expect(r.status, name).toBe(200);
  return json<Report>(r);
};

describe('permisos y aislamiento A↔B', () => {
  it('sin sesión 401; el administrador y los asesores ven el tablero; los dos pueden descargar CSV (la asesora, solo lo suyo) mientras no se desactive', async () => {
    for (const [m, p, b] of [['GET', `/analytics/summary?${q}`], ['GET', `/analytics/reports/sales?${q}`], ['POST', '/analytics/export', { report: 'sales' }]] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
    }
    expect((await call('GET', `/analytics/summary?${q}`, T.carol)).status).toBe(200);
    expect((await call('GET', `/analytics/summary?${q}`, T.alice)).status).toBe(200);
    expect((await call('POST', '/analytics/export', T.carol, { report: 'sales' })).status).toBe(200);
    expect((await call('POST', '/analytics/export', T.alice, { report: 'sales' })).status).toBe(200);
  });

  it('cada empresa ve solo lo suyo: B no ve ni un dato de A, y A no ve los de B', async () => {
    await scenario();
    const b = await summary(T.bob);
    expect(b).toMatchObject({ scope: 'all', leads: 1, sales: { count: 1, revenue: '5000.00', paid: '5000.00', balance: '0.00' }, appointments: { total: 1 } });
    const a = await summary(T.alice);
    expect(a.sales.revenue).toBe('350.00'); // 100 + 50 + 200: sin la anulada y sin la de 5000 de B
    const rows = (await report(T.bob, 'sales')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contact: 'Cliente de B', amount: '5000.00' });
    expect(JSON.stringify(await report(T.alice, 'sales'))).not.toContain('Cliente de B');
    expect((await report(T.bob, 'advisors')).rows.map((r) => (r['advisor'] as { name: string }).name)).toEqual(['Beto Luna']);
  });
});

describe('tablero (resumen)', () => {
  it('el administrador ve toda la empresa: contactos nuevos, citas, ventas, cobrado, saldo y tiempos de respuesta', async () => {
    await scenario();
    const s = await summary(T.alice);
    expect(s).toMatchObject({ scope: 'all', currency: 'USD', timezone: TZ, leads: 4 }); // 3 de Carolina/Eva en octubre + 1 sin dueño (la de septiembre no)
    expect(s.appointments).toEqual({ total: 3, scheduled: 1, completed: 1, cancelled: 1 });
    expect(s.sales).toEqual({ count: 3, cancelled: 1, revenue: '350.00', paid: '90.00', balance: '260.00' });
    expect(s.response).toEqual({ count: 3, avg_seconds: 280, median_seconds: 180 });
  });

  it('la asesora ve SOLO lo suyo: sus contactos, citas, ventas y tiempos; otra asesora, lo suyo', async () => {
    await scenario();
    const c = await summary(T.carol);
    expect(c).toMatchObject({ scope: 'own', leads: 2 });
    expect(c.appointments).toEqual({ total: 2, scheduled: 1, completed: 1, cancelled: 0 });
    expect(c.sales).toEqual({ count: 2, cancelled: 1, revenue: '150.00', paid: '90.00', balance: '60.00' });
    expect(c.response).toEqual({ count: 2, avg_seconds: 120, median_seconds: 120 });
    const e = await summary(T.eve);
    expect(e).toMatchObject({ scope: 'own', leads: 1 });
    expect(e.sales).toMatchObject({ count: 1, revenue: '200.00', paid: '0.00', balance: '200.00' });
    expect(e.response).toMatchObject({ count: 1, avg_seconds: 600 });
  });

  it('el periodo es [desde, hasta): una venta justo en el límite superior no cuenta, y los días se agrupan en la hora de la empresa', async () => {
    await scenario();
    const s = await summary(T.alice);
    // la venta de Eva del 31 de octubre 22:00 (hora de Guayaquil) cae el 31 y no el 1 de noviembre (UTC)
    expect(s.series.find((d) => d.day === '2026-10-31')).toMatchObject({ sales: 1, revenue: '200.00' });
    expect(s.series.find((d) => d.day === '2026-11-01')).toBeUndefined();
    expect(s.series.find((d) => d.day === '2026-10-05')).toMatchObject({ leads: 1, sales: 1, revenue: '100.00' });
    expect(s.series.map((d) => d.day)).toEqual([...s.series.map((d) => d.day)].sort());
  });

  it('por omisión toma los últimos 30 días; valida el periodo (positivo y de un año como máximo)', async () => {
    const r = await call('GET', '/analytics/summary', T.alice);
    expect(r.status).toBe(200);
    const s = await json<Summary & { period: { from: string; to: string } }>(r);
    expect(Date.parse(s.period.to) - Date.parse(s.period.from)).toBe(30 * 24 * 3_600_000);
    for (const bad of [`from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`, `from=${encodeURIComponent('2024-01-01T00:00:00Z')}&to=${encodeURIComponent('2026-01-01T00:00:00Z')}`, 'from=ayer', 'x=1']) {
      expect((await call('GET', `/analytics/summary?${bad}`, T.alice)).status, bad).toBe(400);
    }
  });

  it('el embudo cuenta las abiertas de hoy y las ganadas o perdidas cerradas en el periodo; la asesora solo las suyas', async () => {
    await scenario();
    const pipe = (await admin.query(`INSERT INTO pipelines(organization_id, id, name, position) VALUES ($1, gen_random_uuid(), 'Ventas', 0) RETURNING id`, [ORG_A])).rows[0].id as string;
    const st = async (name: string, position: number, kind: string) => (await admin.query(`INSERT INTO pipeline_stages(organization_id, id, pipeline_id, name, position, kind) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5) RETURNING id`, [ORG_A, pipe, name, position, kind])).rows[0].id as string;
    const [nuevo, ganada, perdida] = [await st('Nuevo', 0, 'open'), await st('Ganada', 1, 'won'), await st('Perdida', 2, 'lost')];
    const opp = async (contact: string, stage: string, owner: string, amount: number, status: string, closedAt: string | null) =>
      admin.query(`INSERT INTO opportunities(organization_id, id, pipeline_id, stage_id, contact_id, amount, owner_id, status, closed_at, lost_reason) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9)`, [ORG_A, pipe, stage, contact, amount, owner, status, closedAt, status === 'lost' ? 'Caro' : null]);
    const [x, y, z, w] = [await contact(ORG_A, IDS.carol, '2026-10-01T10:00:00Z'), await contact(ORG_A, IDS.eve, '2026-10-01T10:00:00Z'), await contact(ORG_A, IDS.carol, '2026-10-01T10:00:00Z'), await contact(ORG_A, IDS.carol, '2026-10-01T10:00:00Z')];
    await opp(x, nuevo, IDS.carol, 100, 'open', null);
    await opp(y, nuevo, IDS.eve, 40, 'open', null);
    await opp(z, ganada, IDS.carol, 70, 'won', '2026-10-15T10:00:00Z');
    await opp(w, perdida, IDS.carol, 90, 'lost', '2026-09-01T10:00:00Z'); // cerrada fuera del periodo: no cuenta
    const f = (await summary(T.alice)).funnel;
    expect(f.map((r) => [r.stage, r.kind, r.count, r.amount])).toEqual([['Nuevo', 'open', 2, '140.00'], ['Ganada', 'won', 1, '70.00'], ['Perdida', 'lost', 0, '0.00']]);
    const own = (await summary(T.carol)).funnel;
    expect(own.map((r) => [r.stage, r.count])).toEqual([['Nuevo', 1], ['Ganada', 1], ['Perdida', 0]]);
    expect((await summary(T.bob)).funnel).toEqual([]);
  });
});

describe('reportes', () => {
  it('ventas: una fila por venta con su cobrado y saldo, la anulada sin saldo y fuera de los totales; el vendedor con su nombre', async () => {
    await scenario();
    const r = await report(T.alice, 'sales');
    expect(r.title).toBe('Ventas');
    expect(r.columns.map((c) => c.key)).toEqual(['created', 'contact', 'seller', 'product', 'quantity', 'amount', 'paid', 'balance', 'status']);
    expect(r.rows).toHaveLength(4);
    const byAmount = Object.fromEntries(r.rows.map((x) => [x['amount'] as string, x]));
    expect(byAmount['100.00']).toMatchObject({ paid: '40.00', balance: '60.00', status: 'Vigente', seller: { name: 'Carolina Vera' }, created: '2026-10-05 10:00' });
    expect(byAmount['30.00']).toMatchObject({ balance: '0.00', status: 'Anulada' });
    expect(r.totals).toEqual({ amount: '350.00', paid: '90.00', balance: '260.00', quantity: 3 });
    expect(r.truncated).toBe(false);
    const mine = await report(T.carol, 'sales');
    expect(mine.rows).toHaveLength(3);
    expect(mine.rows.every((x) => (x['seller'] as { name: string }).name === 'Carolina Vera')).toBe(true);
  });

  it('citas: fecha y hora de la empresa, responsable, estado y recordatorios enviados', async () => {
    await scenario();
    const r = await report(T.alice, 'appointments');
    expect(r.rows.map((x) => [x['starts'], x['status']])).toEqual([['2026-10-10 10:00', 'Completada'], ['2026-10-11 10:00', 'Agendada'], ['2026-10-12 10:00', 'Cancelada']]);
    expect(r.rows[0]).toMatchObject({ owner: { name: 'Carolina Vera' }, reminders: '0/0' });
    expect((await report(T.eve, 'appointments')).rows).toHaveLength(1);
  });

  it('asesores: una fila por persona con sus cifras; la asesora ve solo su fila; el administrador, todas', async () => {
    await scenario();
    const all = await report(T.alice, 'advisors');
    const row = (name: string) => all.rows.find((x) => (x['advisor'] as { name: string }).name === name)!;
    expect(row('Carolina Vera')).toMatchObject({ leads: 2, appointments: 2, sales: 2, revenue: '150.00', avg_response: 120 });
    expect(row('Eva Mora')).toMatchObject({ leads: 1, appointments: 0, sales: 1, revenue: '200.00', avg_response: 600 });
    expect(all.rows.map((x) => (x['advisor'] as { name: string }).name)).toEqual(['Eva Mora', 'Carolina Vera']); // por ingresos
    expect(all.totals).toMatchObject({ sales: 3, revenue: '350.00' });
    const mine = await report(T.carol, 'advisors');
    expect(mine.rows.map((x) => (x['advisor'] as { name: string }).name)).toEqual(['Carolina Vera']);
  });

  it('embudo sin pipelines: vacío; un reporte desconocido es 400', async () => {
    expect((await report(T.alice, 'funnel')).rows).toEqual([]);
    expect((await call('GET', `/analytics/reports/inventado?${q}`, T.alice)).status).toBe(400);
  });
});

describe('exportar a CSV', () => {
  const csv = async (token: string, body: Record<string, unknown>) => call('POST', '/analytics/export', token, { from: FROM, to: TO, ...body });

  it('descarga el mismo reporte con BOM, acentos y nombre de archivo, y deja rastro en la auditoría (quién, cuántas filas, qué periodo)', async () => {
    await scenario();
    const r = await csv(T.alice, { report: 'sales' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="sales-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers.get('x-export-count')).toBe('4');
    // `Response.text()` quita el BOM al decodificar: los bytes se miran crudos
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Fecha,Cliente,Vendedor,Producto,Cantidad,Total,Cobrado,Saldo,Estado');
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => l.includes('Carolina Vera') && l.includes('100.00,40.00,60.00,Vigente'))).toBe(true);
    const audit = (await admin.query(`SELECT new_value, actor_user_id FROM audit_logs WHERE entity_type = 'analytics_export'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: IDS.alice, new_value: { report: 'sales', count: 4, scope: 'all', from: FROM, to: TO } });
  });

  it('un nombre que parece fórmula no se ejecuta en la hoja de cálculo; comillas y comas se escapan', async () => {
    const evil = await contact(ORG_A, IDS.carol, '2026-10-05T15:00:00.000Z', '=HYPERLINK("http://x.test","clic"),+cmd');
    await sale({ seller: IDS.carol, contact: evil, at: '2026-10-05T15:00:00.000Z', amount: 10 });
    const text = await (await csv(T.alice, { report: 'sales' })).text();
    expect(text).toContain(`"'=HYPERLINK(""http://x.test"",""clic""),+cmd"`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('el CSV de la asesora lleva solo lo suyo y el de B jamás lleva datos de A; citas, embudo y asesores también se exportan', async () => {
    await scenario();
    const mine = await csv(T.carol, { report: 'sales' });
    expect(mine.status).toBe(200);
    const mineText = await mine.text();
    expect(mineText).toContain('Carolina Vera');
    expect(mineText).not.toContain('Eva Mora');
    expect(mineText).not.toContain('Cliente de B');
    const b = await (await csv(T.bob, { report: 'sales' })).text();
    expect(b).toContain('Cliente de B');
    expect(b).not.toContain('Carolina');
    for (const name of ['appointments', 'funnel', 'advisors']) {
      const r = await csv(T.alice, { report: name });
      expect(r.status, name).toBe(200);
      expect([...new Uint8Array(await r.arrayBuffer()).slice(0, 3)], name).toEqual([0xef, 0xbb, 0xbf]);
    }
    expect((await csv(T.alice, { report: 'otro' })).status).toBe(400);
    expect((await csv(T.alice, { report: 'sales', from: TO, to: FROM })).status).toBe(400);
    expect(await admin.query(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'analytics_export'`).then((x) => x.rows[0].n)).toBe(5); // 1 de B + 1 de la asesora + 3 de A; los rechazados no dejan rastro de descarga
  });
});

describe('descargas: registro e interruptor del asesor', () => {
  interface Log { items: Array<{ id: string; by: { id: string; name: string }; report: string; from: string; to: string; rows: number; scope: string; at: string }>; next_cursor: string | null }
  const dl = (token: string, report = 'sales') => call('POST', '/analytics/export', token, { report, from: FROM, to: TO });
  const log = async (token: string, extra = ''): Promise<Log> => {
    const r = await call('GET', `/analytics/exports${extra}`, token);
    expect(r.status).toBe(200);
    return json<Log>(r);
  };

  it('cada descarga queda registrada con quién la hizo, qué reporte, qué periodo, cuántas filas y con qué alcance; la más reciente primero', async () => {
    await scenario();
    expect((await dl(T.carol)).status).toBe(200);
    expect((await dl(T.alice, 'advisors')).status).toBe(200);
    const l = await log(T.alice);
    expect(l.items).toHaveLength(2);
    expect(l.items[0]).toMatchObject({ by: { id: IDS.alice, name: 'Alicia Torres' }, report: 'advisors', rows: 2, scope: 'all', from: FROM, to: TO });
    expect(l.items[1]).toMatchObject({ by: { id: IDS.carol, name: 'Carolina Vera' }, report: 'sales', scope: 'own' });
    expect(l.next_cursor).toBeNull();
  });

  it('una descarga rechazada (reporte inválido, periodo invertido, sin sesión) no deja registro', async () => {
    await scenario();
    expect((await call('POST', '/analytics/export', T.alice, { report: 'otro' })).status).toBe(400);
    expect((await call('POST', '/analytics/export', T.alice, { report: 'sales', from: TO, to: FROM })).status).toBe(400);
    expect((await call('POST', '/analytics/export', undefined, { report: 'sales' })).status).toBe(401);
    expect((await log(T.alice)).items).toEqual([]);
  });

  it('solo el administrador ve el registro y el interruptor; la asesora recibe 403 y B jamás ve las descargas de A', async () => {
    await scenario();
    await dl(T.alice);
    expect((await call('GET', '/analytics/exports', T.carol)).status).toBe(403);
    expect((await call('GET', '/analytics/settings', T.carol)).status).toBe(403);
    expect((await call('PUT', '/analytics/settings', T.carol, { advisor_export: false })).status).toBe(403);
    expect((await call('GET', '/analytics/exports')).status).toBe(401);
    expect((await log(T.bob)).items).toEqual([]);
    await dl(T.bob);
    const b = await log(T.bob);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.by.name).toBe('Beto Luna');
    expect((await log(T.alice)).items.map((i) => i.by.name)).toEqual(['Alicia Torres']);
  });

  it('el administrador desactiva la descarga del asesor: recibe 403 EXPORT_DISABLED sin registro, el botón desaparece, y el administrador sigue descargando; al reactivar vuelve', async () => {
    await scenario();
    expect((await json<{ advisor_export: boolean }>(await call('GET', '/analytics/settings', T.alice))).advisor_export).toBe(true); // por omisión
    const acc = async (t: string) => (await report(t, 'sales')) as unknown as { access: { export: boolean; manage: boolean } };
    expect((await acc(T.carol)).access).toEqual({ export: true, manage: false });
    expect((await acc(T.alice)).access).toEqual({ export: true, manage: true });

    const off = await call('PUT', '/analytics/settings', T.alice, { advisor_export: false });
    expect(off.status).toBe(200);
    expect((await json<{ advisor_export: boolean }>(off)).advisor_export).toBe(false);
    const denied = await dl(T.carol);
    expect(denied.status).toBe(403);
    expect((await json<{ error: { code: string } }>(denied)).error.code).toBe('EXPORT_DISABLED');
    expect((await acc(T.carol)).access).toEqual({ export: false, manage: false });
    expect((await summary(T.carol)).leads).toBe(2); // ver el tablero sigue igual
    expect((await acc(T.alice)).access.export).toBe(true);
    expect((await dl(T.alice)).status).toBe(200);
    expect((await log(T.alice)).items.map((i) => i.by.name)).toEqual(['Alicia Torres']); // la rechazada no dejó nada

    expect((await call('PUT', '/analytics/settings', T.alice, { advisor_export: true })).status).toBe(200);
    expect((await dl(T.carol)).status).toBe(200);
    expect((await log(T.alice)).items.map((i) => i.by.name)).toEqual(['Carolina Vera', 'Alicia Torres']);
  });

  it('el interruptor es por empresa y cada cambio queda en la auditoría con quién lo hizo; repetir el mismo valor no ensucia', async () => {
    await scenario();
    await call('PUT', '/analytics/settings', T.alice, { advisor_export: false });
    await call('PUT', '/analytics/settings', T.alice, { advisor_export: false });
    expect((await json<{ advisor_export: boolean }>(await call('GET', '/analytics/settings', T.bob))).advisor_export).toBe(true); // B no se enteró
    await call('PUT', '/analytics/settings', T.alice, { advisor_export: true });
    const audit = (await admin.query(`SELECT old_value, new_value, actor_user_id FROM audit_logs WHERE entity_type = 'analytics_settings' AND field = 'advisor_export' ORDER BY at`)).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ old_value: true, new_value: false, actor_user_id: IDS.alice });
    expect(audit[1]).toMatchObject({ old_value: false, new_value: true });
    expect((await admin.query(`SELECT count(*)::int n FROM analytics_settings`)).rows[0].n).toBe(1);
  });

  it('valida el cuerpo del interruptor y el cursor; el registro se pagina de más reciente a más antigua', async () => {
    await scenario();
    expect((await call('PUT', '/analytics/settings', T.alice, { advisor_export: 'si' })).status).toBe(400);
    expect((await call('PUT', '/analytics/settings', T.alice, {})).status).toBe(400);
    expect((await call('PUT', '/analytics/settings', T.alice, { advisor_export: true, otro: 1 })).status).toBe(400);
    for (const r of ['sales', 'appointments', 'funnel']) await dl(T.alice, r);
    const p1 = await log(T.alice, '?limit=2');
    expect(p1.items.map((i) => i.report)).toEqual(['funnel', 'appointments']);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await log(T.alice, `?limit=2&cursor=${p1.next_cursor}`);
    expect(p2.items.map((i) => i.report)).toEqual(['sales']);
    expect(p2.next_cursor).toBeNull();
    expect((await call('GET', '/analytics/exports?cursor=basura', T.alice)).status).toBe(400);
    expect((await call('GET', '/analytics/exports?limit=0', T.alice)).status).toBe(400);
  });
});
