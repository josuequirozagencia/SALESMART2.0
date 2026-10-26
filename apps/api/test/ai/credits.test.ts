// M8.1 — Créditos IA (ADR-19, ADR-53). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/ai/credits
//   GET /v1/platform/ai/pricing
//   PUT /v1/platform/ai/pricing
//   GET /v1/platform/ai/organizations
//   PUT /v1/platform/ai/organizations/:id/margin
//   POST /v1/platform/ai/organizations/:id/grants
//   GET /v1/platform/ai/organizations/:id/ledger
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AiCreditsService, AiModule, creditsFor } from '../../src/modules/ai';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { AiPricingService, PlatformCredentialsReader } from '../../src/modules/platform';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, AiModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const WELCOME = 1000;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ai_holds, ai_ledger, ai_wallets, ai_org_pricing, platform_audit, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
  await admin.query(`UPDATE ai_pricing SET usd_per_credit = 0.01, global_margin_pct = 100`);
  await admin.query(`UPDATE trial_config SET welcome_credits = ${WELCOME}`);
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@ag.test', 'Dave Agencia'], [IDS.root, 'root@plat.test', 'Raíz']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, AG1, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

type Row = Record<string, unknown>;
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
interface View { balance: number; held: number; available: number; items: Array<Row>; next_cursor: string | null }
const view = (token: string, qs = '') => call('GET', `/ai/credits${qs}`, token).then((r) => json<View>(r));
const grant = (token: string, org: string, credits: number, key = `key-${Math.random().toString(36).slice(2)}-grant`, note = 'Regalo de prueba') => call('POST', `/platform/ai/organizations/${org}/grants`, token, { credits, note }, { 'idempotency-key': key });
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);
const credits = () => app.get(AiCreditsService);
const walletRow = async (org = ORG_A) => (await admin.query(`SELECT * FROM ai_wallets WHERE organization_id = $1`, [org])).rows[0] as Row | undefined;
const ledgerRows = async (org = ORG_A) => (await admin.query(`SELECT * FROM ai_ledger WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Row[];
/** El libro y el saldo cuadran: el saldo es la suma del libro y cada saldo posterior es el anterior más el movimiento. */
async function expectConsistent(org = ORG_A): Promise<void> {
  const w = await walletRow(org);
  const rows = await ledgerRows(org);
  const sum = rows.reduce((n, r) => n + (r['credits'] as number), 0);
  expect(w?.['balance_cache'] ?? 0, 'saldo = suma del libro').toBe(sum);
  let run = 0;
  for (const r of rows) {
    run += r['credits'] as number;
    expect(r['balance_after']).toBe(run);
  }
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
afterAll(async () => { await admin.query(`UPDATE trial_config SET welcome_credits = ${WELCOME}`); await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  app.get(AiPricingService).invalidate();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
});

describe('cuánto se cobra (función pura)', () => {
  it('⌈costo × (1 + margen) ÷ valor del crédito⌉, con un mínimo de 1 crédito si hubo costo', () => {
    expect(creditsFor(0.07, 100, 0.01)).toBe(14);
    expect(creditsFor(0.0001, 100, 0.01)).toBe(1); // el costo más pequeño cobra 1
    expect(creditsFor(0, 100, 0.01)).toBe(0); // sin costo, nada
    expect(creditsFor(0.015, 0, 0.01)).toBe(2); // 1,5 se redondea hacia arriba
    expect(creditsFor(0.01, 50, 0.01)).toBe(2); // 1,5
    expect(creditsFor(1, 100, 0.01)).toBe(200);
    // la coma flotante no cobra un crédito de más: 0,07 ÷ 0,01 = 7,000000000000001
    expect(creditsFor(0.07, 0, 0.01)).toBe(7);
    expect(() => creditsFor(1, 0, 0)).toThrow();
  });
});

describe('lo que ve el cliente', () => {
  it('GET /ai/credits: el administrador ve su saldo con la bienvenida; sin sesión 401; el asesor no tiene el permiso (403)', async () => {
    expect((await call('GET', '/ai/credits')).status).toBe(401);
    expect((await call('GET', '/ai/credits', T.carol)).status).toBe(403);
    const r = await call('GET', '/ai/credits', T.alice);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const v = await json<View>(r);
    expect(v).toMatchObject({ balance: WELCOME, held: 0, available: WELCOME, next_cursor: null });
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ kind: 'welcome', credits: WELCOME, balance_after: WELCOME, ref: 'Créditos de bienvenida' });
    expect(Object.keys(v.items[0]!).sort()).toEqual(['balance_after', 'created_at', 'credits', 'id', 'kind', 'ref']); // lista blanca: nada más
    expect(await walletRow()).toMatchObject({ balance_cache: WELCOME });
    await expectConsistent();
  });

  it('pedir el saldo varias veces (o a la vez) no repite la bienvenida', async () => {
    await Promise.all([view(T.alice), view(T.alice), view(T.alice), view(T.alice)]);
    await view(T.alice);
    expect((await ledgerRows()).filter((r) => r['kind'] === 'welcome')).toHaveLength(1);
    expect((await walletRow())!['balance_cache']).toBe(WELCOME);
  });

  it('la agencia y la plataforma no reciben bienvenida: solo las empresas cliente', async () => {
    const sum = await inOrg(AG1, () => credits().summary());
    expect(sum.balance).toBe(0);
    await inOrg(AG1, () => credits().ensureWelcome());
    expect(await walletRow(AG1)).toMatchObject({ balance_cache: 0 });
    expect(await ledgerRows(AG1)).toHaveLength(0);
  });

  it('el costo y el margen NUNCA salen en lo que ve el cliente, ni en el JSON ni como texto', async () => {
    await view(T.alice);
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 50, kind: 'use', ref: 'Agente de ventas' }));
    await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.07 }));
    const body = await call('GET', '/ai/credits', T.alice).then((r) => r.text());
    expect(body).not.toMatch(/cost|margin|costo|margen|usd|openai/i);
    const v = JSON.parse(body) as View;
    expect(v.items[0]).toMatchObject({ kind: 'use', credits: -14, ref: 'Agente de ventas' });
    // en la base sí queda (solo para el servidor)
    expect((await ledgerRows()).find((r) => r['kind'] === 'use')).toMatchObject({ cost_usd: '0.070000', margin_pct: '100.00' });
  });

  it('paginación por cursor, del más reciente al más antiguo', async () => {
    await view(T.alice);
    for (let i = 1; i <= 5; i++) expect((await grant(T.root, ORG_A, i * 10)).status).toBe(201);
    const first = await view(T.alice, '?limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.items.map((i) => i['credits'])).toEqual([50, 40, 30]);
    const second = await view(T.alice, `?limit=3&cursor=${first.next_cursor}`);
    expect(second.items.map((i) => i['credits'])).toEqual([20, 10, WELCOME]);
    expect(second.next_cursor).toBeNull();
    expect((await call('GET', '/ai/credits?cursor=mal', T.alice)).status).toBe(400);
    expect((await call('GET', '/ai/credits?limit=0', T.alice)).status).toBe(400);
  });
});

describe('cobrar: reservar y liquidar', () => {
  it('reservar aparta el saldo; liquidar cobra lo usado y libera el resto; el libro cuadra', async () => {
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 300, kind: 'use' }));
    expect(await view(T.alice)).toMatchObject({ balance: WELCOME, held: 300, available: 700 });
    const done = await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.07 }));
    expect(done).toEqual({ credits: 14, balance: WELCOME - 14 });
    expect(await view(T.alice)).toMatchObject({ balance: 986, held: 0, available: 986 });
    await expectConsistent();
  });

  it('nunca se cobra más de lo apartado, aunque el costo real fuera mayor', async () => {
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 300, kind: 'use' }));
    const done = await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 10 })); // 10 USD serían 2000 créditos
    expect(done.credits).toBe(300);
    expect((await walletRow())!['balance_cache']).toBe(WELCOME - 300);
    await expectConsistent();
  });

  it('liquidar dos veces la misma reserva no cobra dos veces; liberar una no usada no cobra nada', async () => {
    const a = await inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'use' }));
    await inOrg(ORG_A, () => credits().settle(a.holdId, { costUsd: 0.05 }));
    const again = await inOrg(ORG_A, () => credits().settle(a.holdId, { costUsd: 0.05 }));
    expect(again.credits).toBe(0);
    expect((await ledgerRows()).filter((r) => r['kind'] === 'use')).toHaveLength(1);
    const b = await inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'test' }));
    await inOrg(ORG_A, () => credits().release(b.holdId));
    expect(await view(T.alice)).toMatchObject({ held: 0, balance: WELCOME - 10 });
    await expectConsistent();
  });

  it('un costo cero no escribe movimiento; la prueba se cobra como «test»', async () => {
    const a = await inOrg(ORG_A, () => credits().reserve({ credits: 10, kind: 'use' }));
    expect((await inOrg(ORG_A, () => credits().settle(a.holdId, { costUsd: 0 }))).credits).toBe(0);
    const t = await inOrg(ORG_A, () => credits().reserve({ credits: 50, kind: 'test', ref: 'Prueba del agente' }));
    await inOrg(ORG_A, () => credits().settle(t.holdId, { costUsd: 0.02 }));
    const rows = await ledgerRows();
    expect(rows.filter((r) => r['kind'] === 'use')).toHaveLength(0);
    expect(rows.find((r) => r['kind'] === 'test')).toMatchObject({ credits: -4, ref: 'Prueba del agente' });
    await expectConsistent();
  });

  it('sin saldo suficiente no se reserva: 409 AI_NO_CREDITS, y lo apartado por otras llamadas cuenta', async () => {
    await inOrg(ORG_A, () => credits().reserve({ credits: 900, kind: 'use' }));
    const err = await inOrg(ORG_A, () => credits().reserve({ credits: 101, kind: 'use' })).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'AI_NO_CREDITS' });
    await expect(inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'use' }))).resolves.toHaveProperty('holdId');
    for (const bad of [0, -5, 1.5]) await expect(inOrg(ORG_A, () => credits().reserve({ credits: bad, kind: 'use' }))).rejects.toMatchObject({ status: 400 });
  });

  it('CONCURRENCIA: 30 reservas a la vez contra un saldo de 100 apartan exactamente 100 y el resto falla; al liquidarlas nunca hay saldo negativo', async () => {
    await admin.query(`UPDATE trial_config SET welcome_credits = 100`);
    app.get(OrgDirectoryService).invalidate();
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => inOrg(ORG_A, () => credits().reserve({ credits: 10, kind: 'use' }))));
    const ok = results.filter((r): r is PromiseFulfilledResult<{ holdId: string }> => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(bad).toHaveLength(20);
    for (const b of bad) expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'AI_NO_CREDITS' });
    expect(await view(T.alice)).toMatchObject({ balance: 100, held: 100, available: 0 });
    // se liquidan todas a la vez con un costo mayor que lo apartado: se cobra lo apartado, el saldo llega a 0 y no baja de ahí
    await Promise.all(ok.map((r) => inOrg(ORG_A, () => credits().settle(r.value.holdId, { costUsd: 1 }))));
    expect((await walletRow())!['balance_cache']).toBe(0);
    await expectConsistent();
    await admin.query(`SELECT 1 FROM ai_wallets WHERE balance_cache < 0`).then((r) => expect(r.rowCount).toBe(0));
  });

  it('CONCURRENCIA: liquidar la misma reserva varias veces a la vez cobra una sola', async () => {
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'use' }));
    const out = await Promise.all(Array.from({ length: 6 }, () => inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.1 }))));
    expect(out.filter((o) => o.credits > 0)).toHaveLength(1);
    expect((await ledgerRows()).filter((r) => r['kind'] === 'use')).toHaveLength(1);
    await expectConsistent();
  });

  it('CONCURRENCIA: reservas y liquidaciones mezcladas dejan el libro cuadrado', async () => {
    await admin.query(`UPDATE trial_config SET welcome_credits = 200`);
    app.get(OrgDirectoryService).invalidate();
    const runOne = async (i: number) => {
      const r = await inOrg(ORG_A, () => credits().reserve({ credits: 15, kind: i % 2 ? 'use' : 'test' })).catch(() => null);
      if (r) await inOrg(ORG_A, () => credits().settle(r.holdId, { costUsd: 0.02 }));
    };
    await Promise.all(Array.from({ length: 40 }, (_, i) => runOne(i)));
    await expectConsistent();
    expect((await walletRow())!['balance_cache']).toBeGreaterThanOrEqual(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ai_holds WHERE status = 'active'`)).rows[0].n).toBe(0);
  });

  it('una reserva abandonada (más de 15 min) deja de apartar créditos', async () => {
    await inOrg(ORG_A, () => credits().reserve({ credits: 1000, kind: 'use' }));
    await expect(inOrg(ORG_A, () => credits().reserve({ credits: 1, kind: 'use' }))).rejects.toMatchObject({ code: 'AI_NO_CREDITS' });
    await admin.query(`UPDATE ai_holds SET created_at = now() - interval '20 minutes'`);
    await expect(inOrg(ORG_A, () => credits().reserve({ credits: 1000, kind: 'use' }))).resolves.toHaveProperty('holdId');
    expect((await admin.query(`SELECT status FROM ai_holds ORDER BY created_at`)).rows.map((r) => r.status)).toEqual(['expired', 'active']);
  });

  it('si la llamada terminó DESPUÉS de vencer la reserva, se cobra lo que alcance sin pasar de cero', async () => {
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 900, kind: 'use' }));
    await admin.query(`UPDATE ai_holds SET created_at = now() - interval '20 minutes'`);
    await inOrg(ORG_A, () => credits().reserve({ credits: 1000, kind: 'use' })); // la vieja pasa a «expired» y esta aparta todo
    const late = await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 100 }));
    expect(late.credits).toBeLessThanOrEqual(WELCOME);
    expect((await walletRow())!['balance_cache']).toBeGreaterThanOrEqual(0);
    await expectConsistent();
  });

  it('el precio y el margen de la empresa mandan: con margen propio del 0 % el mismo costo cobra la mitad', async () => {
    expect((await call('PUT', `/platform/ai/organizations/${ORG_A}/margin`, T.root, { margin_pct: '0' })).status).toBe(200);
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'use' }));
    expect((await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.07 }))).credits).toBe(7);
    expect((await ledgerRows()).find((r) => r['kind'] === 'use')).toMatchObject({ margin_pct: '0.00' });
    // la otra empresa sigue con el global
    const b = await inOrg(ORG_B, () => credits().reserve({ credits: 100, kind: 'use' }));
    expect((await inOrg(ORG_B, () => credits().settle(b.holdId, { costUsd: 0.07 }))).credits).toBe(14);
  });
});

describe('leer la plataforma desde una petición de empresa', () => {
  it('las credenciales de plataforma y el precio se leen dentro del contexto de una empresa (los contextos no se anidan)', async () => {
    // Antes del arreglo, PlatformContext.run dentro de un TenantContext lanzaba «contextos excluyentes» y el almacenamiento real de adjuntos nunca se alcanzaba
    await expect(inOrg(ORG_A, () => app.get(PlatformCredentialsReader).active('text_ai'))).resolves.toBeNull();
    await expect(inOrg(ORG_A, () => app.get(AiPricingService).resolve(ORG_A))).resolves.toMatchObject({ usdPerCredit: 0.01, marginPct: 100, orgOverride: false });
    // y fuera de toda empresa (tarea del sistema) también
    await expect(app.get(AiPricingService).resolve(ORG_B, Date.now() + 120_000)).resolves.toMatchObject({ marginPct: 100 });
  });
});

describe('Súper Admin: precio, margen, regalos y saldos', () => {
  it('solo el Súper Admin entra a /platform/ai: sin sesión 401; administrador de empresa, asesor y agencia 403', async () => {
    for (const [m, p] of [['GET', '/platform/ai/pricing'], ['GET', '/platform/ai/organizations'], ['GET', `/platform/ai/organizations/${ORG_A}/ledger`]] as const) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(401);
      for (const t of [T.alice, T.carol]) expect((await call(m, p, t)).status, `${m} ${p}`).toBe(403);
    }
    const dave = await login('dave@ag.test');
    expect((await call('GET', '/platform/ai/pricing', dave)).status).toBe(403);
    expect((await call('POST', `/platform/ai/organizations/${ORG_A}/grants`, T.alice, { credits: 5, note: 'Me lo regalo yo' }, { 'idempotency-key': 'key-alice-0001' })).status).toBe(403);
    expect((await call('PUT', '/platform/ai/pricing', T.alice, { usd_per_credit: '0.001', global_margin_pct: '0' })).status).toBe(403);
    expect((await call('PUT', `/platform/ai/organizations/${ORG_A}/margin`, T.alice, { margin_pct: '0' })).status).toBe(403);
    expect((await walletRow())).toBeUndefined();
  });

  it('GET y PUT /platform/ai/pricing: valores de ejemplo, validación y auditoría de plataforma', async () => {
    expect(await call('GET', '/platform/ai/pricing', T.root).then((r) => json(r))).toMatchObject({ usd_per_credit: '0.010000', global_margin_pct: '100.00' });
    const ok = await call('PUT', '/platform/ai/pricing', T.root, { usd_per_credit: '0.02', global_margin_pct: '150.5' });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ usd_per_credit: '0.020000', global_margin_pct: '150.50' });
    for (const bad of [{ usd_per_credit: '0', global_margin_pct: '10' }, { usd_per_credit: '101', global_margin_pct: '10' }, { usd_per_credit: '0.01', global_margin_pct: '1001' }, { usd_per_credit: '-1', global_margin_pct: '10' }, { usd_per_credit: 'x', global_margin_pct: '10' }, { usd_per_credit: '0.01' }, { usd_per_credit: '0.01', global_margin_pct: '10', otro: 1 }]) {
      expect((await call('PUT', '/platform/ai/pricing', T.root, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const audit = (await admin.query(`SELECT action, details FROM platform_audit WHERE action = 'ai.pricing.update'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ before: { usd_per_credit: '0.010000', global_margin_pct: '100.00' }, after: { usd_per_credit: '0.02', global_margin_pct: '150.5' } });
    // el cambio vale para lo que se cobre después: 0,07 × 2,505 ÷ 0,02 = 8,7675 → 9
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'use' }));
    expect((await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.07 }))).credits).toBe(9);
  });

  it('POST /platform/ai/organizations/:id/grants: regala con llave de idempotencia, lo ve el cliente (sin costo) y queda auditado en las dos auditorías', async () => {
    const r = await grant(T.root, ORG_A, 500, 'key-regalo-0001', 'Regalo por la prueba del piloto');
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const out = await json<{ item: Row; balance: number; replayed: boolean }>(r);
    expect(out).toMatchObject({ balance: WELCOME + 500, replayed: false, item: { kind: 'grant', credits: 500, balance_after: WELCOME + 500, ref: 'Regalo por la prueba del piloto' } });
    expect(await view(T.alice)).toMatchObject({ balance: WELCOME + 500 });
    expect((await view(T.alice)).items[0]).toMatchObject({ kind: 'grant', credits: 500 });
    expect((await ledgerRows()).find((x) => x['kind'] === 'grant')).toMatchObject({ created_by: IDS.root, idempotency_key: 'key-regalo-0001' });
    const plat = (await admin.query(`SELECT target_org_id, details FROM platform_audit WHERE action = 'ai.credits.grant'`)).rows;
    expect(plat).toHaveLength(1);
    expect(plat[0]).toMatchObject({ target_org_id: ORG_A, details: { credits: 500, balance: WELCOME + 500 } });
    const tenant = (await admin.query(`SELECT acting_as, old_value, new_value, actor_user_id FROM audit_logs WHERE entity_type = 'ai_wallet' AND organization_id = $1`, [ORG_A])).rows;
    expect(tenant).toHaveLength(1);
    expect(tenant[0]).toMatchObject({ acting_as: 'super_admin', actor_user_id: IDS.root });
    await expectConsistent();
  });

  it('el mismo regalo repetido (reintento de red) no se hace dos veces; la misma llave con otros datos es 409; sin llave o mal formada, 400', async () => {
    expect((await grant(T.root, ORG_A, 100, 'key-reintento-01', 'Regalo')).status).toBe(201);
    const again = await grant(T.root, ORG_A, 100, 'key-reintento-01', 'Regalo');
    expect(again.status).toBe(201);
    expect(await json(again)).toMatchObject({ replayed: true, balance: WELCOME + 100 });
    expect((await ledgerRows()).filter((r) => r['kind'] === 'grant')).toHaveLength(1);
    expect((await admin.query(`SELECT 1 FROM platform_audit WHERE action = 'ai.credits.grant'`)).rowCount).toBe(1); // el reintento no vuelve a auditarse
    const other = await grant(T.root, ORG_A, 999, 'key-reintento-01', 'Regalo');
    expect(other.status).toBe(409);
    expect(await json(other)).toMatchObject({ error: { code: 'IDEMPOTENCY_MISMATCH' } });
    expect((await call('POST', `/platform/ai/organizations/${ORG_A}/grants`, T.root, { credits: 5, note: 'Sin llave' })).status).toBe(400);
    expect((await grant(T.root, ORG_A, 5, 'corta')).status).toBe(400);
    // la misma llave en OTRA empresa es una operación distinta
    expect((await grant(T.root, ORG_B, 100, 'key-reintento-01', 'Regalo')).status).toBe(201);
    expect((await walletRow(ORG_B))!['balance_cache']).toBe(WELCOME + 100);
    // 10 reintentos a la vez
    const burst = await Promise.all(Array.from({ length: 10 }, () => grant(T.root, ORG_A, 7, 'key-rafaga-0001', 'Ráfaga')));
    expect(burst.every((b) => b.status === 201)).toBe(true);
    expect((await ledgerRows()).filter((r) => r['credits'] === 7)).toHaveLength(1);
    await expectConsistent();
  });

  it('datos de regalo no válidos y empresas que no son clientes', async () => {
    for (const bad of [{ credits: 0, note: 'Cero' }, { credits: -5, note: 'Negativo' }, { credits: 1.5, note: 'Decimal' }, { credits: 1_000_001, note: 'Enorme' }, { credits: 5, note: 'x' }, { credits: 5, note: '' }, { credits: 5 }, { credits: 5, note: 'ok', otro: 1 }]) {
      expect((await call('POST', `/platform/ai/organizations/${ORG_A}/grants`, T.root, bad, { 'idempotency-key': 'key-invalida-01' })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await grant(T.root, AG1, 5)).status).toBe(404); // una agencia no es cliente
    expect((await grant(T.root, IDS.platformOrg, 5)).status).toBe(404);
    expect((await grant(T.root, '11111111-1111-4111-8111-111111111111', 5)).status).toBe(404);
    expect((await call('POST', '/platform/ai/organizations/no-es-uuid/grants', T.root, { credits: 5, note: 'ok ok' }, { 'idempotency-key': 'key-invalida-02' })).status).toBe(400);
    expect(await walletRow(AG1)).toBeUndefined();
  });

  it('GET /platform/ai/organizations: lista las empresas cliente con saldo, apartado, entradas y salidas, y su margen', async () => {
    await view(T.alice);
    await grant(T.root, ORG_A, 300);
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'use' }));
    await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.07 }));
    const r = await call('GET', '/platform/ai/organizations', T.root);
    expect(r.status).toBe(200);
    const list = await json<{ items: Array<Row>; next_cursor: string | null; pricing: Row }>(r);
    expect(list.items.map((i) => i['name']).sort()).toEqual(['Barbería Norte', 'Estudio Luna']); // sin agencias ni la plataforma
    expect(list.items.find((i) => i['id'] === ORG_A)).toMatchObject({ balance: WELCOME + 300 - 14, held: 0, granted: WELCOME + 300, used: 14, margin_pct: '100.00', margin_override: false });
    expect(list.items.find((i) => i['id'] === ORG_B)).toMatchObject({ balance: 0, held: 0, granted: 0, used: 0 }); // sin monedero: ceros, y listar NO lo crea
    expect(await walletRow(ORG_B)).toBeUndefined();
    expect(list.pricing).toMatchObject({ usd_per_credit: '0.010000', global_margin_pct: '100.00' });
    expect((await call('GET', '/platform/ai/organizations?q=luna', T.root).then((x) => json<{ items: Array<Row> }>(x))).items.map((i) => i['name'])).toEqual(['Estudio Luna']);
    expect((await call('GET', '/platform/ai/organizations?limit=1', T.root).then((x) => json<{ items: Array<Row>; next_cursor: string | null }>(x))).next_cursor).not.toBeNull();
    expect((await call('GET', '/platform/ai/organizations?limit=0', T.root)).status).toBe(400);
    expect((await call('GET', '/platform/ai/organizations?state=raro', T.root)).status).toBe(400);
  });

  it('PUT /platform/ai/organizations/:id/margin: margen propio y vuelta al global; valida y audita', async () => {
    const set = await call('PUT', `/platform/ai/organizations/${ORG_A}/margin`, T.root, { margin_pct: '25.5' });
    expect(set.status).toBe(200);
    expect(await json(set)).toMatchObject({ id: ORG_A, margin_pct: '25.5', margin_override: true });
    const listed = await call('GET', '/platform/ai/organizations', T.root).then((x) => json<{ items: Array<Row> }>(x));
    expect(listed.items.find((i) => i['id'] === ORG_A)).toMatchObject({ margin_pct: '25.50', margin_override: true });
    expect(listed.items.find((i) => i['id'] === ORG_B)).toMatchObject({ margin_pct: '100.00', margin_override: false });
    const reset = await call('PUT', `/platform/ai/organizations/${ORG_A}/margin`, T.root, { margin_pct: null });
    expect(await json(reset)).toMatchObject({ margin_pct: '100.00', margin_override: false });
    for (const bad of [{ margin_pct: '1001' }, { margin_pct: '-1' }, { margin_pct: 'x' }, {}, { margin_pct: '5', otro: 1 }]) expect((await call('PUT', `/platform/ai/organizations/${ORG_A}/margin`, T.root, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await call('PUT', `/platform/ai/organizations/${AG1}/margin`, T.root, { margin_pct: '5' })).status).toBe(404);
    const audit = (await admin.query(`SELECT details FROM platform_audit WHERE action = 'ai.org_margin.update' ORDER BY at`)).rows;
    expect(audit.map((a) => a.details)).toEqual([{ before: null, after: '25.5' }, { before: '25.50', after: null }]);
  });

  it('GET /platform/ai/organizations/:id/ledger: el libro con costo y margen (solo plataforma) y cursor', async () => {
    await view(T.alice);
    for (let i = 0; i < 3; i++) {
      const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 50, kind: 'use', ref: `Uso ${i}` }));
      await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.07 }));
    }
    const r = await call('GET', `/platform/ai/organizations/${ORG_A}/ledger?limit=2`, T.root);
    expect(r.status).toBe(200);
    const page = await json<{ items: Array<Row>; next_cursor: string | null; balance: number }>(r);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ kind: 'use', credits: -14, cost_usd: '0.070000', margin_pct: '100.00' });
    expect(page.next_cursor).not.toBeNull();
    const next = await call('GET', `/platform/ai/organizations/${ORG_A}/ledger?limit=5&cursor=${page.next_cursor}`, T.root).then((x) => json<{ items: Array<Row> }>(x));
    expect(next.items.map((i) => i['kind'])).toEqual(['use', 'welcome']);
    expect(next.items[1]).toMatchObject({ cost_usd: null, margin_pct: null });
    expect((await call('GET', `/platform/ai/organizations/${AG1}/ledger`, T.root)).status).toBe(404);
    // consultar el libro NO crea el monedero de una empresa que no lo tenía
    expect((await call('GET', `/platform/ai/organizations/${ORG_B}/ledger`, T.root)).status).toBe(200);
    expect(await walletRow(ORG_B)).toBeUndefined();
  });
});

describe('aislamiento A↔B y permisos de la base de datos', () => {
  it('cada empresa ve solo su monedero y su libro; un regalo a una no toca a la otra', async () => {
    await view(T.alice);
    await view(T.bob);
    await grant(T.root, ORG_A, 400);
    expect((await view(T.alice)).balance).toBe(WELCOME + 400);
    expect((await view(T.bob)).balance).toBe(WELCOME);
    expect((await view(T.bob)).items.map((i) => i['kind'])).toEqual(['welcome']);
    const { holdId } = await inOrg(ORG_A, () => credits().reserve({ credits: 100, kind: 'use' }));
    expect((await view(T.bob))).toMatchObject({ held: 0 });
    await inOrg(ORG_A, () => credits().settle(holdId, { costUsd: 0.03 }));
    expect((await view(T.bob)).balance).toBe(WELCOME);
    // desde el contexto de B, ni se ve ni se puede liquidar una reserva de A
    const a = await inOrg(ORG_A, () => credits().reserve({ credits: 10, kind: 'use' }));
    await expect(inOrg(ORG_B, () => credits().settle(a.holdId, { costUsd: 1 }))).rejects.toMatchObject({ code: 'AI_HOLD_CLOSED' });
    expect((await admin.query(`SELECT status FROM ai_holds WHERE id = $1`, [a.holdId])).rows[0].status).toBe('active');
    await expectConsistent(ORG_A);
    await expectConsistent(ORG_B);
  });

  it('el libro es de solo inserción y las tablas de precio son solo de plataforma; el monedero y el libro no se tocan desde la plataforma', async () => {
    const as = async (url: string, sql: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        return await c.query(sql);
      } finally {
        await c.end();
      }
    };
    await view(T.alice);
    await expect(as(info.rwUrl, 'DELETE FROM ai_ledger')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'UPDATE ai_ledger SET credits = credits')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'TRUNCATE ai_ledger')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'DELETE FROM ai_wallets')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'DELETE FROM ai_holds')).rejects.toThrow(/permission denied/);
    for (const t of ['ai_pricing', 'ai_org_pricing']) await expect(as(info.rwUrl, `SELECT * FROM ${t}`), t).rejects.toThrow(/permission denied/);
    for (const url of [info.platformUrl, info.identityUrl]) for (const t of ['ai_wallets', 'ai_ledger', 'ai_holds']) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    await expect(as(info.identityUrl, 'SELECT * FROM ai_pricing')).rejects.toThrow(/permission denied/);
    await expect(as(info.platformUrl, 'DELETE FROM ai_pricing')).rejects.toThrow(/permission denied/);
    await expect(as(info.platformUrl, 'INSERT INTO ai_pricing(id) VALUES (2)')).rejects.toThrow(/permission denied/);
  });

  it('las restricciones de la base impiden movimientos incoherentes', async () => {
    await view(T.alice);
    const w = (await walletRow())!;
    const ins = (cols: string, vals: string) => admin.query(`INSERT INTO ai_ledger(id, organization_id, ${cols}) VALUES (gen_random_uuid(), '${ORG_A}', ${vals})`);
    await expect(ins('kind, credits, balance_after', `'use', 5, 10`)).rejects.toThrow(/ai_ledger_sign_by_kind/); // un consumo suma
    await expect(ins('kind, credits, balance_after', `'grant', -5, 10`)).rejects.toThrow(/ai_ledger_sign_by_kind/); // un regalo resta
    await expect(ins('kind, credits, balance_after', `'raro', 5, 10`)).rejects.toThrow(/ai_ledger_kind_valid/);
    await expect(ins('kind, credits, balance_after', `'grant', 5, -1`)).rejects.toThrow(/ai_ledger_balance_valid/);
    await expect(ins('kind, credits, balance_after, idempotency_key', `'grant', 5, 10, 'corta'`)).rejects.toThrow(/ai_ledger_key_shape/);
    await expect(admin.query(`UPDATE ai_wallets SET balance_cache = -1 WHERE id = '${w['id'] as string}'`)).rejects.toThrow(/ai_wallets_balance_valid/);
    await expect(admin.query(`INSERT INTO ai_wallets(id, organization_id) VALUES (gen_random_uuid(), '${ORG_A}')`)).rejects.toThrow(/ai_wallets_org_uq/); // un monedero por empresa
    await expect(admin.query(`INSERT INTO ai_holds(id, organization_id, credits, kind) VALUES (gen_random_uuid(), '${ORG_A}', 0, 'use')`)).rejects.toThrow(/ai_holds_credits_valid/);
    await expect(admin.query(`INSERT INTO ai_holds(id, organization_id, credits, kind) VALUES (gen_random_uuid(), '${ORG_A}', 5, 'grant')`)).rejects.toThrow(/ai_holds_kind_valid/);
    await expect(admin.query(`UPDATE ai_pricing SET usd_per_credit = 0`)).rejects.toThrow(/ai_pricing_price_valid/);
    await expect(admin.query(`UPDATE ai_pricing SET global_margin_pct = 1001`)).rejects.toThrow(/ai_pricing_margin_valid/);
    await expect(admin.query(`INSERT INTO ai_pricing(id) VALUES (2)`)).rejects.toThrow(/ai_pricing_singleton|duplicate/);
  });
});
