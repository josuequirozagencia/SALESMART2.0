// V21b — Espacio extra de la biblioteca (ADR-75). Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   GET /v1/library/storage-plans
//   POST /v1/library/storage-requests
//   GET /v1/platform/storage-plans
//   POST /v1/platform/storage-plans
//   PATCH /v1/platform/storage-plans/:id
//   GET /v1/platform/storage-requests
//   GET /v1/platform/storage-companies
//   GET /v1/platform/companies/:id/storage-grants
//   POST /v1/platform/companies/:id/storage-grants
//   POST /v1/platform/companies/:id/storage-grants/:grantId/revoke
//   POST /v1/platform/companies/:id/storage-request/dismiss
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { LibraryModule } from '../../src/modules/library';
import { OrganizationsModule } from '../../src/modules/organizations';
import { StorageModule } from '../../src/modules/storage';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, LibraryModule, StorageModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
  root: 'f0000000-0000-4000-8000-0000000000f1', // Súper Admin
};

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE storage_grants, storage_requests, media_assets, media_folders, platform_audit, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  await admin.query(`DELETE FROM storage_plans WHERE name NOT IN ('Extra S', 'Extra M', 'Extra L', 'Extra XL')`);
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone,storage_quota_bytes) VALUES ($1,$2,$3,'UTC',1000)`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

const JPEG = (n = 404) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 5)]);
const upload = (token: string, bytes: Buffer, filename = 'foto.jpg') => fetch(`${base}/library/assets`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent(filename), authorization: `Bearer ${token}` }, body: bytes });
interface Usage { used_bytes: number; quota_bytes: number; available_bytes: number; included_bytes: number; extra_bytes: number; next_expiry_at: string | null; request: { plan_name: string | null } | null }
const usage = (token: string) => call('GET', '/library/usage', token).then((r) => json<Usage>(r));
interface Plan { id: string; name: string; extra_bytes: number; price_amount: string }
interface Grant { id: string; kind: string; extra_bytes: number; active: boolean; revoked: boolean; plan_name: string; price_amount: string | null; ends_at: string | null }
const mkPlan = async (name: string, gb: number, price = '3'): Promise<Plan> => {
  const r = await call('POST', '/platform/storage-plans', T.root, { name, extra_gb: gb, price_amount: price });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  return json<Plan>(r);
};
let n = 0;
const grant = (org: string, body: unknown, key = `key-${(n += 1)}-${Date.now()}`, token = T.root) => call('POST', `/platform/companies/${org}/storage-grants`, token, body, { 'idempotency-key': key });
const grantsOf = (org: string) => call('GET', `/platform/companies/${org}/storage-grants`, T.root).then((r) => json<{ items: Grant[]; quota: { effective_bytes: number } }>(r));
const MINI = 0.000002; // ≈ 2 147 bytes: lo justo para que un archivo de ~400 bytes quepa

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'REQUIRE_VIRUS_SCAN']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
});

describe('cupo efectivo y subidas', () => {
  it('incluido + extra vigente; un plan vencido o anulado no suma y el cambio del catálogo no altera lo vendido', async () => {
    expect(await usage(T.alice)).toMatchObject({ included_bytes: 1000, extra_bytes: 0, quota_bytes: 1000 });
    const plan = await mkPlan('Mini', MINI, '3');
    const g = await grant(ORG_A, { plan_id: plan.id });
    expect(g.status, JSON.stringify(await g.clone().json())).toBe(201);
    const granted = (await json<{ item: Grant }>(g)).item;
    expect(await usage(T.alice)).toMatchObject({ extra_bytes: plan.extra_bytes, quota_bytes: 1000 + plan.extra_bytes });
    // cambiar el catálogo no reescribe lo ya vendido
    expect((await call('PATCH', `/platform/storage-plans/${plan.id}`, T.root, { extra_gb: 5, price_amount: '99', name: 'Otro' })).status).toBe(200);
    expect(await usage(T.alice)).toMatchObject({ extra_bytes: plan.extra_bytes });
    expect((await grantsOf(ORG_A)).items.find((x) => x.id === granted.id)).toMatchObject({ plan_name: 'Mini', price_amount: '3.00', extra_bytes: plan.extra_bytes });
    // vencido: no suma
    await admin.query(`INSERT INTO storage_grants(id, organization_id, kind, plan_name, extra_bytes, starts_at, ends_at, idempotency_key) VALUES (gen_random_uuid(), $1, 'grant', 'Viejo', 5000, now() - interval '10 days', now() - interval '1 day', 'old-grant-1')`, [ORG_A]);
    expect((await usage(T.alice)).extra_bytes).toBe(plan.extra_bytes);
    // anulado: no suma, y no se puede anular dos veces
    const rv = await call('POST', `/platform/companies/${ORG_A}/storage-grants/${granted.id}/revoke`, T.root, { reason: 'Se canceló el pago' });
    expect(rv.status, JSON.stringify(await rv.clone().json())).toBe(200);
    expect((await usage(T.alice)).extra_bytes).toBe(0);
    expect((await call('POST', `/platform/companies/${ORG_A}/storage-grants/${granted.id}/revoke`, T.root, { reason: 'otra vez' })).status).toBe(409);
    expect((await grantsOf(ORG_A)).items.find((x) => x.id === granted.id)).toMatchObject({ active: false, revoked: true });
  });

  it('cabe justo pasa; no cabe da 409 QUOTA_EXCEEDED; con un plan activado después, pasa', async () => {
    await admin.query(`UPDATE organizations SET storage_quota_bytes = 404 WHERE id = $1`, [ORG_A]);
    expect((await upload(T.alice, JPEG(404))).status).toBe(201); // justo
    const full = await upload(T.alice, JPEG(404), 'otra.jpg');
    expect(full.status).toBe(409);
    expect((await json<{ error: { code: string } }>(full)).error.code).toBe('QUOTA_EXCEEDED');
    const plan = await mkPlan('Mini', MINI);
    expect((await grant(ORG_A, { plan_id: plan.id })).status).toBe(201);
    expect((await upload(T.alice, JPEG(404), 'otra.jpg')).status).toBe(201);
  });

  it('al vencer con el uso sobre el cupo: se conserva y se puede ver lo subido; solo se rechazan subidas nuevas', async () => {
    await admin.query(`UPDATE organizations SET storage_quota_bytes = 404 WHERE id = $1`, [ORG_A]);
    await admin.query(`INSERT INTO storage_grants(id, organization_id, kind, plan_name, extra_bytes, starts_at, ends_at, idempotency_key) VALUES (gen_random_uuid(), $1, 'grant', 'Vigente', 2000, now() - interval '1 day', now() + interval '1 hour', 'live-grant-1')`, [ORG_A]);
    const up = await upload(T.alice, JPEG(404), 'a.jpg');
    const up2 = await upload(T.alice, JPEG(404), 'b.jpg');
    expect(up.status).toBe(201);
    expect(up2.status).toBe(201);
    const a = await json<{ id: string }>(up);
    // el espacio extra vence: el uso (808) queda sobre el cupo (404)
    await admin.query(`UPDATE storage_grants SET ends_at = now() - interval '1 minute', starts_at = now() - interval '2 days' WHERE idempotency_key = 'live-grant-1'`);
    const u = await usage(T.alice);
    expect(u.used_bytes).toBe(808);
    expect(u.quota_bytes).toBe(404);
    expect(u.available_bytes).toBe(0);
    expect((await call('GET', `/library/assets/${a.id}/url`, T.carol)).status).toBe(200); // se sigue pudiendo ver
    expect((await call('GET', '/library', T.carol)).status).toBe(200);
    expect((await upload(T.alice, JPEG(404), 'c.jpg')).status).toBe(409); // solo lo nuevo se rechaza
    expect((await admin.query(`SELECT count(*)::int AS n FROM media_assets WHERE state = 'ready'`)).rows[0].n).toBe(2);
  });
});

describe('concesiones', () => {
  it('la misma Idempotency-Key no duplica; sin llave 400; un regalo sin motivo 400; con motivo vale', async () => {
    const plan = await mkPlan('Mini', MINI);
    const first = await grant(ORG_A, { plan_id: plan.id }, 'same-key-0001');
    const again = await grant(ORG_A, { plan_id: plan.id }, 'same-key-0001');
    expect(first.status).toBe(201);
    expect((await json<{ replayed: boolean }>(again)).replayed).toBe(true);
    expect((await admin.query(`SELECT count(*)::int AS n FROM storage_grants WHERE kind = 'grant'`)).rows[0].n).toBe(1);
    expect((await call('POST', `/platform/companies/${ORG_A}/storage-grants`, T.root, { plan_id: plan.id })).status).toBe(400);
    expect((await grant(ORG_A, { extra_gb: 1 })).status).toBe(400);
    const gift = await grant(ORG_A, { extra_gb: 1, reason: 'Cortesía por la espera' });
    expect(gift.status, JSON.stringify(await gift.clone().json())).toBe(201);
    expect((await grant(ORG_A, { plan_id: plan.id, ends_at: '2020-01-01T00:00:00Z' })).status).toBe(400); // fin en el pasado
    expect((await admin.query(`SELECT count(*)::int AS n FROM platform_audit WHERE action = 'storage.grant'`)).rows[0].n).toBe(2); // el reintento no audita otra vez
  });

  it('la auditoría deja activar, anular y solicitar', async () => {
    const plan = await mkPlan('Mini', MINI);
    expect((await call('POST', '/library/storage-requests', T.alice, { plan_id: plan.id })).status).toBe(201);
    const g = await json<{ item: Grant }>(await grant(ORG_A, { plan_id: plan.id }));
    await call('POST', `/platform/companies/${ORG_A}/storage-grants/${g.item.id}/revoke`, T.root, { reason: 'Prueba de anulación' });
    const pa = (await admin.query(`SELECT action FROM platform_audit WHERE action LIKE 'storage.%' ORDER BY at`)).rows.map((r) => r.action as string);
    expect(pa).toEqual(expect.arrayContaining(['storage.plan.create', 'storage.grant', 'storage.revoke']));
    const al = (await admin.query(`SELECT entity_type FROM audit_logs WHERE entity_type IN ('storage_request', 'storage_grant')`)).rows.map((r) => r.entity_type as string);
    expect(al).toEqual(expect.arrayContaining(['storage_request', 'storage_grant']));
  });
});

describe('solicitudes', () => {
  it('el administrador pide espacio (una abierta por empresa), el asesor no; conceder la resuelve; descartar la cierra', async () => {
    const plan = await mkPlan('Mini', MINI);
    expect((await call('POST', '/library/storage-requests', T.carol, { plan_id: plan.id })).status).toBe(403);
    expect((await call('GET', '/library/storage-plans', T.carol)).status).toBe(403);
    const opts = await json<{ plans: Array<{ id: string; price_amount: string }>; request: unknown }>(await call('GET', '/library/storage-plans', T.alice));
    expect(opts.plans.map((p) => p.id)).toContain(plan.id);
    expect(Object.keys(opts.plans[0]!).sort()).toEqual(['currency', 'extra_bytes', 'id', 'name', 'period', 'price_amount']); // solo el precio de lista
    const r1 = await call('POST', '/library/storage-requests', T.alice, { plan_id: plan.id, note: 'Necesitamos subir el catálogo' });
    expect(r1.status).toBe(201);
    expect((await call('POST', '/library/storage-requests', T.alice, {})).status).toBe(409);
    expect((await usage(T.alice)).request).toMatchObject({ plan_name: 'Mini' });
    const open = await json<{ items: Array<{ id: string; open_request: unknown }> }>(await call('GET', '/platform/storage-requests', T.root));
    expect(open.items.map((i) => i.id)).toEqual([ORG_A]);
    expect((await grant(ORG_A, { plan_id: plan.id })).status).toBe(201);
    expect((await usage(T.alice)).request).toBeNull();
    expect((await json<{ items: unknown[] }>(await call('GET', '/platform/storage-requests', T.root))).items).toEqual([]);
    // y una solicitud nueva se puede descartar
    expect((await call('POST', '/library/storage-requests', T.alice, {})).status).toBe(201);
    expect((await call('POST', `/platform/companies/${ORG_A}/storage-request/dismiss`, T.root)).status).toBe(200);
    expect((await call('POST', `/platform/companies/${ORG_A}/storage-request/dismiss`, T.root)).status).toBe(404);
    expect((await call('POST', '/library/storage-requests', T.alice, { plan_id: '00000000-0000-4000-8000-00000000dead' })).status).toBe(404);
  });

  it('un plan desactivado ya no se ofrece al cliente; el catálogo de plataforma lo sigue mostrando', async () => {
    const plan = await mkPlan('Temporal', 1);
    expect((await call('PATCH', `/platform/storage-plans/${plan.id}`, T.root, { active: false })).status).toBe(200);
    const opts = await json<{ plans: Array<{ id: string }> }>(await call('GET', '/library/storage-plans', T.alice));
    expect(opts.plans.map((p) => p.id)).not.toContain(plan.id);
    expect((await json<{ items: Plan[] }>(await call('GET', '/platform/storage-plans', T.root))).items.map((p) => p.id)).toContain(plan.id);
    expect((await call('POST', '/library/storage-requests', T.alice, { plan_id: plan.id })).status).toBe(404);
  });
});

describe('aislamiento y permisos', () => {
  it('A↔B: cada empresa ve solo su cupo, su solicitud y nunca las concesiones de la otra; un cliente no entra a la plataforma', async () => {
    const plan = await mkPlan('Mini', MINI);
    expect((await grant(ORG_A, { plan_id: plan.id })).status).toBe(201);
    expect((await call('POST', '/library/storage-requests', T.alice, {})).status).toBe(201);
    expect((await usage(T.bob))).toMatchObject({ extra_bytes: 0, quota_bytes: 1000, request: null });
    expect((await call('POST', '/library/storage-requests', T.bob, {})).status).toBe(201); // B tiene la suya, aparte
    const both = await json<{ items: Array<{ id: string; quota: { extra_bytes: number } }> }>(await call('GET', '/platform/storage-companies', T.root));
    expect(Object.fromEntries(both.items.map((i) => [i.id, i.quota.extra_bytes]))).toMatchObject({ [ORG_A]: plan.extra_bytes, [ORG_B]: 0 });
    expect((await grantsOf(ORG_B)).items).toEqual([]);
    for (const [m, p, b] of [
      ['GET', '/platform/storage-plans'], ['POST', '/platform/storage-plans', { name: 'x', extra_gb: 1, price_amount: '1' }], ['GET', '/platform/storage-requests'], ['GET', '/platform/storage-companies'],
      ['GET', `/platform/companies/${ORG_A}/storage-grants`], ['POST', `/platform/companies/${ORG_A}/storage-grants`, { extra_gb: 1, reason: 'x' }], ['POST', `/platform/companies/${ORG_A}/storage-request/dismiss`],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, T.alice, b, { 'idempotency-key': 'abcdefgh1234' })).status, `${m} ${p} cliente`).toBe(403);
    }
    expect((await call('GET', '/library/storage-plans')).status).toBe(401);
    expect((await call('POST', '/library/storage-requests', undefined, {})).status).toBe(401);
    // una empresa que no es cliente o no existe: 404
    expect((await call('GET', `/platform/companies/${IDS.platformOrg}/storage-grants`, T.root)).status).toBe(404);
    expect((await call('GET', '/platform/companies/00000000-0000-4000-8000-00000000dead/storage-grants', T.root)).status).toBe(404);
  });

  it('las tablas de concesiones son de solo inserción y el catálogo solo es de plataforma (a nivel de privilegios)', async () => {
    const plan = await mkPlan('Mini', MINI);
    await grant(ORG_A, { plan_id: plan.id });
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      await rw.query('BEGIN');
      await rw.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await expect(rw.query(`UPDATE storage_grants SET extra_bytes = 1`)).rejects.toThrow(/permission denied/i);
      await rw.query('ROLLBACK');
      await rw.query('BEGIN');
      await rw.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await expect(rw.query(`DELETE FROM storage_grants`)).rejects.toThrow(/permission denied/i);
      await rw.query('ROLLBACK');
      await rw.query('BEGIN');
      await expect(rw.query(`SELECT * FROM storage_plans`)).rejects.toThrow(/permission denied/i);
      await rw.query('ROLLBACK');
      await rw.query('BEGIN');
      await rw.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await expect(rw.query(`DELETE FROM storage_requests`)).rejects.toThrow(/permission denied/i);
      await rw.query('ROLLBACK');
    } finally {
      await rw.end();
    }
  });
});
