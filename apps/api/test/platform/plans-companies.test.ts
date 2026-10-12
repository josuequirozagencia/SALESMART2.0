// M2.2 — Empresas y planes (consola del Súper Admin). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/platform/plans · POST /v1/platform/plans · PATCH /v1/platform/plans/:id
//   POST /v1/platform/plans/:id/archive · POST /v1/platform/plans/:id/restore
//   GET /v1/platform/companies · PUT /v1/platform/companies/:id/plan
import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from '@sales-smart/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrganizationsModule, PLAN_FEATURE_KEYS } from '../../src/modules/organizations';
import { RequirePermission } from '../../src/rbac';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, ORG_C, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Controller('probe')
class ProbeController {
  @RequirePermission('contacts.read')
  @Get('business')
  business() { return { ok: true }; }
}
@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [ProbeController] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const DAY = 86_400_000;
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  agencyOrg: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency (dueña de la agencia)
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, trials, organization_members, organizations, users, plans, platform_audit CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [ORG_C, 'client', 'Café Origen'], [IDS.agencyOrg, 'agency', 'Agencia Demo']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.bob, 'bob@b.test', 'Beto Ruiz'], [IDS.carol, 'carol@a.test', null], [IDS.dave, 'dave@agencia.test', 'Dana Vega'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, IDS.agencyOrg, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}
/** Prueba de una organización con fechas relativas (días, pueden ser negativos). */
async function trial(org: string, owner: string, endsInDays: number, status: 'active' | 'expired' = 'active') {
  await admin.query(
    `INSERT INTO trials(id, organization_id, owner_user_id, started_at, ends_at, status, expired_at) VALUES ($1,$2,$3, now() - interval '10 days', now() + make_interval(secs => $4), $5, $6)`,
    [uuidv7(), org, owner, endsInDays * 86400, status, status === 'expired' ? new Date() : null],
  );
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(seed);

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
interface Plan { id: string; name: string; description: string | null; max_users: number | null; max_connections: number | null; max_queues: number | null; features: Record<string, boolean>; archived: boolean; companies: number }
interface Company { id: string; name: string; kind: string; state: string; plan: { id: string; name: string } | null; users: number; owner_email: string | null; trial_ends_at: string | null }
const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const codeOf = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;

let rootToken = '';
const mkPlan = async (over: Record<string, unknown> = {}): Promise<Plan> => {
  const r = await call('POST', '/platform/plans', rootToken, { name: `Plan ${uuidv7().slice(-8)}`, ...over });
  expect(r.status).toBe(201);
  return json<Plan>(r);
};
const companies = async (qs = ''): Promise<{ items: Company[]; next_cursor: string | null }> => json(await call('GET', `/platform/companies${qs}`, rootToken));
const assign = (orgId: string, planId: string | null) => call('PUT', `/platform/companies/${orgId}/plan`, rootToken, { plan_id: planId });
beforeEach(async () => { rootToken = await login('root@plat.test'); });

describe('acceso: solo el Súper Admin', () => {
  it('sin sesión 401 y con una sesión de cliente 403 en TODAS las rutas; no cambia nada', async () => {
    const plan = await mkPlan();
    const client = await login('alice@a.test');
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/platform/plans'], ['POST', '/platform/plans', { name: 'Hack' }], ['PATCH', `/platform/plans/${plan.id}`, { name: 'Hack' }],
      ['POST', `/platform/plans/${plan.id}/archive`], ['POST', `/platform/plans/${plan.id}/restore`],
      ['GET', '/platform/companies'], ['PUT', `/platform/companies/${ORG_A}/plan`, { plan_id: plan.id }],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, client, b)).status, `${m} ${p} cliente`).toBe(403);
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM plans`)).rows[0].n).toBe(1);
    expect((await admin.query(`SELECT plan_id FROM organizations WHERE id = $1`, [ORG_A])).rows[0].plan_id).toBeNull();
  });
});

describe('planes', () => {
  it('crea un plan: 201, todas las claves del catálogo normalizadas (las no enviadas quedan apagadas) y límites nulos = ilimitado', async () => {
    const r = await call('POST', '/platform/plans', rootToken, { name: '  Pro  ', description: 'Para equipos', max_users: 10, features: { kanban: true, agenda: true } });
    expect(r.status).toBe(201);
    const p = await json<Plan>(r);
    expect(p).toMatchObject({ name: 'Pro', description: 'Para equipos', max_users: 10, max_connections: null, max_queues: null, archived: false, companies: 0 });
    expect(Object.keys(p.features).sort()).toEqual([...PLAN_FEATURE_KEYS].sort());
    expect(p.features).toMatchObject({ kanban: true, agenda: true, campaigns: false, telephony: false });
    const row = (await admin.query(`SELECT features FROM plans WHERE id = $1`, [p.id])).rows[0];
    expect(Object.keys(row.features).sort()).toEqual([...PLAN_FEATURE_KEYS].sort());
  });

  it('valida: nombre corto/largo/con control, límites fuera de rango o no enteros, claves de módulo desconocidas o no booleanas, campos de más → 400 y nada se crea', async () => {
    const bad: unknown[] = [
      {}, { name: 'A' }, { name: 'x'.repeat(61) }, { name: 'Pro\u0007' }, { name: 'Pro', max_users: 0 }, { name: 'Pro', max_users: 100_001 }, { name: 'Pro', max_queues: 1.5 }, { name: 'Pro', max_connections: '3' },
      { name: 'Pro', features: { hackeo: true } }, { name: 'Pro', features: { kanban: 'si' } }, { name: 'Pro', features: [] }, { name: 'Pro', description: 'x'.repeat(201) }, { name: 'Pro', extra: 1 }, { name: 'Pro', id: uuidv7() },
    ];
    for (const b of bad) expect((await call('POST', '/platform/plans', rootToken, b)).status, JSON.stringify(b)).toBe(400);
    expect((await admin.query(`SELECT count(*)::int AS n FROM plans`)).rows[0].n).toBe(0);
  });

  it('el nombre es único sin importar mayúsculas ni espacios (409 PLAN_NAME_TAKEN); 6 creaciones simultáneas → solo una', async () => {
    await mkPlan({ name: 'Básico' });
    const dup = await call('POST', '/platform/plans', rootToken, { name: '  bÁsico ' });
    expect(dup.status).toBe(409);
    expect(await codeOf(dup)).toBe('PLAN_NAME_TAKEN');
    const rs = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/platform/plans', rootToken, { name: 'Carrera' })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
  });

  it('lista con el catálogo de módulos, el número de empresas por plan y sin los archivados salvo que se pidan', async () => {
    const a = await mkPlan({ name: 'Activo' });
    const b = await mkPlan({ name: 'Viejo' });
    expect((await call('POST', `/platform/plans/${b.id}/archive`, rootToken)).status).toBe(200);
    await assign(ORG_A, a.id);
    await assign(ORG_B, a.id);
    const l = await json<{ items: Plan[]; feature_catalog: Array<{ key: string; label: string }> }>(await call('GET', '/platform/plans', rootToken));
    expect(l.items.map((p) => p.name)).toEqual(['Activo']);
    expect(l.items[0]!.companies).toBe(2);
    expect(l.feature_catalog.map((f) => f.key)).toEqual([...PLAN_FEATURE_KEYS]);
    expect(l.feature_catalog.find((f) => f.key === 'ai_agents')?.label).toBe('Agentes IA');
    const all = await json<{ items: Plan[] }>(await call('GET', '/platform/plans?include_archived=true', rootToken));
    expect(all.items.map((p) => p.name).sort()).toEqual(['Activo', 'Viejo']);
    expect((await call('GET', '/platform/plans?include_archived=quizas', rootToken)).status).toBe(400);
    expect((await call('GET', '/platform/plans?foo=1', rootToken)).status).toBe(400);
  });

  it('edita parcialmente: los módulos se FUSIONAN, descripción null la borra, límite null = ilimitado; nombre repetido → 409', async () => {
    const p = await mkPlan({ name: 'Pro', description: 'Hola', max_users: 5, max_queues: 3, features: { kanban: true, flows: true } });
    const r = await call('PATCH', `/platform/plans/${p.id}`, rootToken, { features: { flows: false, telephony: true }, description: null, max_users: null });
    expect(r.status).toBe(200);
    expect(await json<Plan>(r)).toMatchObject({ description: null, max_users: null, max_queues: 3, features: { kanban: true, flows: false, telephony: true, agenda: false } });
    await mkPlan({ name: 'Otro' });
    expect((await call('PATCH', `/platform/plans/${p.id}`, rootToken, { name: ' OTRO ' })).status).toBe(409);
    expect((await call('PATCH', `/platform/plans/${p.id}`, rootToken, { name: 'Renombrado' })).status).toBe(200);
  });

  it('PATCH: vacío o con campos ajenos → 400; plan inexistente → 404; id inválido → 400; un plan archivado no se edita (409 PLAN_ARCHIVED)', async () => {
    const p = await mkPlan({ name: 'Pro' });
    expect((await call('PATCH', `/platform/plans/${p.id}`, rootToken, {})).status).toBe(400);
    expect((await call('PATCH', `/platform/plans/${p.id}`, rootToken, { archived: true })).status).toBe(400);
    expect((await call('PATCH', `/platform/plans/${uuidv7()}`, rootToken, { name: 'Nada' })).status).toBe(404);
    expect((await call('PATCH', '/platform/plans/no-es-uuid', rootToken, { name: 'Nada' })).status).toBe(400);
    await call('POST', `/platform/plans/${p.id}/archive`, rootToken);
    const r = await call('PATCH', `/platform/plans/${p.id}`, rootToken, { name: 'Tarde' });
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe('PLAN_ARCHIVED');
  });

  it('archivar: un plan EN USO no se archiva (409 PLAN_IN_USE con el número); sin uso sí, es idempotente y se restaura; nunca se borra', async () => {
    const p = await mkPlan({ name: 'Pro' });
    await assign(ORG_A, p.id);
    const inUse = await call('POST', `/platform/plans/${p.id}/archive`, rootToken);
    expect(inUse.status).toBe(409);
    const err = await json<{ error: { code: string; message: string } }>(inUse);
    expect(err.error.code).toBe('PLAN_IN_USE');
    expect(err.error.message).toContain('1 empresa');
    await assign(ORG_A, null);
    expect(await json<Plan>(await call('POST', `/platform/plans/${p.id}/archive`, rootToken))).toMatchObject({ archived: true });
    expect(await json<Plan>(await call('POST', `/platform/plans/${p.id}/archive`, rootToken))).toMatchObject({ archived: true });
    expect(await json<Plan>(await call('POST', `/platform/plans/${p.id}/restore`, rootToken))).toMatchObject({ archived: false });
    expect((await call('POST', `/platform/plans/${uuidv7()}/archive`, rootToken)).status).toBe(404);
    expect((await admin.query(`SELECT count(*)::int AS n FROM plans`)).rows[0].n).toBe(1);
  });

  it('archivar y asignar A LA VEZ nunca dejan una empresa con un plan archivado (bloqueo del plan)', async () => {
    for (let i = 0; i < 8; i++) {
      const p = await mkPlan({ name: `Carrera ${i}` });
      const [arch, asg] = await Promise.all([call('POST', `/platform/plans/${p.id}/archive`, rootToken), assign(ORG_A, p.id)]);
      const outcomes = [arch.status, asg.status];
      expect(outcomes.includes(200) && outcomes.filter((s) => s === 200).length === 2, `ronda ${i}: ambas no pueden ganar (${outcomes})`).toBe(false);
      const row = (await admin.query(`SELECT p.archived_at, (SELECT count(*)::int FROM organizations WHERE plan_id = p.id) AS n FROM plans p WHERE p.id = $1`, [p.id])).rows[0];
      expect(row.archived_at !== null && row.n > 0, `ronda ${i}: archivado y en uso`).toBe(false);
      await assign(ORG_A, null);
    }
  });
});

describe('empresas', () => {
  it('lista las empresas (nunca la plataforma) con el estado derivado, usuarios activos, responsable y fin de prueba', async () => {
    await trial(ORG_A, IDS.alice, 3);
    await trial(ORG_B, IDS.bob, -2);
    await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1`, [IDS.carol]); // el asesor revocado no cuenta
    const l = await companies();
    expect(l.items.map((c) => c.name).sort()).toEqual(['Agencia Demo', 'Barbería Norte', 'Café Origen', 'Estudio Luna']);
    expect(l.items.some((c) => c.kind === 'platform')).toBe(false);
    const by = Object.fromEntries(l.items.map((c) => [c.name, c]));
    expect(by['Barbería Norte']).toMatchObject({ kind: 'client', state: 'trial', users: 1, owner_email: 'alice@a.test', plan: null });
    expect(new Date(by['Barbería Norte']!.trial_ends_at!).getTime()).toBeGreaterThan(Date.now() + 2 * DAY);
    expect(by['Estudio Luna']).toMatchObject({ state: 'trial_expired', owner_email: 'bob@b.test' });
    expect(by['Café Origen']).toMatchObject({ state: 'active', users: 0, owner_email: null, trial_ends_at: null }); // sin prueba ni plan
    expect(by['Agencia Demo']).toMatchObject({ kind: 'agency', state: 'active', owner_email: 'dave@agencia.test' });
  });

  it('estados: suspendida manda sobre todo; el estado materializado «expired» también vence; un plan saca a la empresa de la prueba', async () => {
    await trial(ORG_A, IDS.alice, -1, 'expired'); // materializada
    await trial(ORG_B, IDS.bob, 5);
    await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_B]);
    expect((await companies()).items.find((c) => c.id === ORG_A)?.state).toBe('trial_expired');
    expect((await companies()).items.find((c) => c.id === ORG_B)?.state).toBe('suspended');
    const p = await mkPlan({ name: 'Pro' });
    await assign(ORG_A, p.id);
    expect((await companies()).items.find((c) => c.id === ORG_A)).toMatchObject({ state: 'active', trial_ends_at: null, plan: { id: p.id, name: 'Pro' } });
  });

  it('filtros: tipo, estado, plan (id o «none») y búsqueda por nombre o por correo de un miembro; el % y el _ se buscan literalmente', async () => {
    await trial(ORG_A, IDS.alice, 3);
    await trial(ORG_B, IDS.bob, -2);
    const p = await mkPlan({ name: 'Pro' });
    await assign(ORG_C, p.id);
    expect((await companies('?kind=agency')).items.map((c) => c.name)).toEqual(['Agencia Demo']);
    expect((await companies('?state=trial')).items.map((c) => c.name)).toEqual(['Barbería Norte']);
    expect((await companies('?state=trial_expired')).items.map((c) => c.name)).toEqual(['Estudio Luna']);
    expect((await companies(`?plan=${p.id}`)).items.map((c) => c.name)).toEqual(['Café Origen']);
    expect((await companies('?plan=none')).items).toHaveLength(3);
    expect((await companies('?q=luna')).items.map((c) => c.name)).toEqual(['Estudio Luna']);
    expect((await companies('?q=ALICE@A.TEST')).items.map((c) => c.name)).toEqual(['Barbería Norte']); // por correo de un miembro
    expect((await companies('?q=carol')).items.map((c) => c.name)).toEqual(['Barbería Norte']);
    expect((await companies('?q=%25')).items).toHaveLength(0); // «%» literal: no es comodín
    expect((await companies('?q=_')).items).toHaveLength(0);
    for (const bad of ['?kind=platform', '?state=otro', '?plan=abc', '?limit=0', '?limit=101', '?cursor=x', '?q=', '?foo=1']) expect((await call('GET', `/platform/companies${bad}`, rootToken)).status, bad).toBe(400);
  });

  it('paginación por cursor: sin repetidos ni huecos', async () => {
    for (let i = 0; i < 6; i++) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,'client',$2,'UTC')`, [uuidv7(), `Extra ${i}`]);
    const all = (await companies('?limit=100')).items.map((c) => c.id);
    expect(all).toHaveLength(10);
    expect(all).toEqual([...all].sort().reverse());
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const p: Awaited<ReturnType<typeof companies>> = await companies(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...p.items.map((c) => c.id));
      cursor = p.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
  });
});

describe('asignar un plan', () => {
  it('asigna y quita; devuelve el estado resultante y deja el cambio en platform_audit con la empresa afectada', async () => {
    const p = await mkPlan({ name: 'Pro' });
    const r = await assign(ORG_A, p.id);
    expect(r.status).toBe(200);
    expect(await json<{ id: string; state: string; plan: { name: string } }>(r)).toMatchObject({ id: ORG_A, state: 'active', plan: { name: 'Pro' } });
    expect((await admin.query(`SELECT plan_id FROM organizations WHERE id = $1`, [ORG_A])).rows[0].plan_id).toBe(p.id);
    expect(await json<{ plan: null }>(await assign(ORG_A, null))).toMatchObject({ plan: null });
    const audit = (await admin.query(`SELECT action, entity_type, entity_id, actor_user_id, target_org_id, details FROM platform_audit WHERE action = 'company.plan_changed' ORDER BY at`)).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ entity_type: 'organization', entity_id: ORG_A, actor_user_id: IDS.root, target_org_id: ORG_A, details: { from_plan_id: null, to_plan_id: p.id } });
    expect(audit[1]).toMatchObject({ details: { from_plan_id: p.id, to_plan_id: null } });
  });

  it('errores: empresa inexistente o la plataforma → 404; plan inexistente → 404 PLAN_NOT_FOUND; archivado → 409; cuerpo inválido → 400; nada cambia', async () => {
    const p = await mkPlan({ name: 'Pro' });
    const old = await mkPlan({ name: 'Viejo' });
    await call('POST', `/platform/plans/${old.id}/archive`, rootToken);
    expect((await assign(uuidv7(), p.id)).status).toBe(404);
    expect((await assign(IDS.platformOrg, p.id)).status).toBe(404); // la plataforma nunca recibe plan
    const missing = await assign(ORG_A, uuidv7());
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe('PLAN_NOT_FOUND');
    const archived = await assign(ORG_A, old.id);
    expect(archived.status).toBe(409);
    expect(await codeOf(archived)).toBe('PLAN_ARCHIVED');
    for (const b of [{}, { plan_id: 'x' }, { plan_id: p.id, extra: 1 }, { plan: p.id }]) expect((await call('PUT', `/platform/companies/${ORG_A}/plan`, rootToken, b)).status, JSON.stringify(b)).toBe(400);
    expect((await call('PUT', '/platform/companies/no-es-uuid/plan', rootToken, { plan_id: p.id })).status).toBe(400);
    expect((await admin.query(`SELECT count(*)::int AS n FROM organizations WHERE plan_id IS NOT NULL`)).rows[0].n).toBe(0);
  });

  it('con un plan la empresa DEJA de estar en pausa aunque su prueba haya vencido (con el mismo token); al quitarlo vuelve la pausa', async () => {
    await trial(ORG_A, IDS.alice, -3);
    const t = await login('alice@a.test');
    expect((await call('GET', '/probe/business', t)).status).toBe(403); // prueba vencida: en pausa
    const p = await mkPlan({ name: 'Pro' });
    await assign(ORG_A, p.id);
    expect((await call('GET', '/probe/business', t)).status).toBe(200); // ya es cliente con plan
    expect((await call('GET', '/trials/me', t)).status).toBe(404); // no hay prueba que mostrar
    await assign(ORG_A, null);
    expect((await call('GET', '/probe/business', t)).status).toBe(403);
    expect((await call('GET', '/trials/me', t)).status).toBe(200);
  });

  it('en la consola de pruebas: la empresa con plan muestra su plan, ya no cuenta como activa ni vencida, y sigue en «Todas»', async () => {
    await trial(ORG_A, IDS.alice, 5);
    await trial(ORG_B, IDS.bob, -1);
    const p = await mkPlan({ name: 'Pro' });
    await assign(ORG_A, p.id);
    await assign(ORG_B, p.id);
    const get = async (qs = '') => json<{ items: Array<{ organization_name: string; plan_name: string | null }>; summary: { active: number; expiring_soon: number } }>(await call('GET', `/platform/trials${qs}`, rootToken));
    const all = await get();
    expect(all.items.map((i) => [i.organization_name, i.plan_name]).sort()).toEqual([['Barbería Norte', 'Pro'], ['Estudio Luna', 'Pro']]);
    expect(all.summary.active).toBe(0);
    expect((await get('?state=active')).items).toHaveLength(0);
    expect((await get('?state=expired')).items).toHaveLength(0);
  });
});

describe('base de datos', () => {
  it('CHECK y FK: nombre, límites, módulos como objeto, la plataforma sin plan y plan_id existente', async () => {
    const ins = (name: string, extra = '') => admin.query(`INSERT INTO plans(id,name${extra ? ',' + extra.split('=')[0] : ''}) VALUES (gen_random_uuid(),$1${extra ? ',' + extra.split('=')[1] : ''})`, [name]);
    await expect(ins('A')).rejects.toThrow(/plans_name_len/);
    await expect(ins('Ok1', 'max_users=0')).rejects.toThrow(/plans_limits_range/);
    await expect(ins('Ok2', 'max_queues=100001')).rejects.toThrow(/plans_limits_range/);
    await expect(ins('Ok3', `features='[]'::jsonb`)).rejects.toThrow(/plans_features_object/);
    await expect(ins('Ok4', `description=repeat('x', 201)`)).rejects.toThrow(/plans_description_len/);
    const p = await mkPlan({ name: 'Pro' });
    await expect(admin.query(`UPDATE organizations SET plan_id = $1 WHERE id = $2`, [p.id, IDS.platformOrg])).rejects.toThrow(/organizations_platform_no_plan/);
    await expect(admin.query(`UPDATE organizations SET plan_id = $1 WHERE id = $2`, [uuidv7(), ORG_A])).rejects.toThrow(/organizations_plan_id_plans_id_fk/);
    await expect(admin.query(`DELETE FROM plans WHERE id = $1`, [p.id])).resolves.toBeTruthy(); // sin uso se podría borrar con superusuario…
    await assign(ORG_A, (await mkPlan({ name: 'Otro' })).id);
    await expect(admin.query(`DELETE FROM plans`)).rejects.toThrow(/organizations_plan_id_plans_id_fk/); // …pero NUNCA uno en uso
  });

  it('privilegios: app_identity SELECT/INSERT/UPDATE sin DELETE; app_rw y app_platform sin acceso', async () => {
    const open = async (url: string) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };
    const idc = await open(info.identityUrl);
    const rw = await open(info.rwUrl);
    const pl = await open(info.platformUrl);
    try {
      await expect(idc.query('SELECT 1 FROM plans')).resolves.toBeTruthy();
      for (const q of ['DELETE FROM plans', 'TRUNCATE plans']) await expect(idc.query(q), q).rejects.toThrow(/permission denied/);
      for (const [n, c] of [['app_rw', rw], ['app_platform', pl]] as const) for (const q of ['SELECT 1 FROM plans', `INSERT INTO plans(id,name) VALUES (gen_random_uuid(),'x')`]) await expect(c.query(q), `${n}: ${q}`).rejects.toThrow(/permission denied/);
    } finally {
      await Promise.all([idc.end(), rw.end(), pl.end()]);
    }
  });

  it('auditoría de los planes: crear, editar, archivar y restaurar quedan en platform_audit con el actor', async () => {
    const p = await mkPlan({ name: 'Pro', description: 'secreto-comercial' });
    await call('PATCH', `/platform/plans/${p.id}`, rootToken, { max_users: 5 });
    await call('POST', `/platform/plans/${p.id}/archive`, rootToken);
    await call('POST', `/platform/plans/${p.id}/restore`, rootToken);
    const rows = (await admin.query(`SELECT action, entity_id, actor_user_id, details FROM platform_audit WHERE entity_type = 'plan' ORDER BY at`)).rows;
    expect(rows.map((r) => r.action)).toEqual(['plan.created', 'plan.updated', 'plan.archived', 'plan.restored']);
    expect(rows.every((r) => r.entity_id === p.id && r.actor_user_id === IDS.root)).toBe(true);
    expect(rows[1].details).toEqual({ fields: ['max_users'] });
    expect(JSON.stringify(rows)).not.toContain('secreto-comercial'); // el contenido no se copia a la auditoría
  });
});
