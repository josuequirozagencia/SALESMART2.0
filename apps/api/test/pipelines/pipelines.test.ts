// M4.1 — Pipelines y etapas (ADR-49). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/pipelines
//   POST /v1/pipelines
//   PUT /v1/pipelines/order
//   PATCH /v1/pipelines/:id
//   DELETE /v1/pipelines/:id
//   POST /v1/pipelines/:id/stages
//   PUT /v1/pipelines/:id/stages/order
//   PATCH /v1/pipeline-stages/:id
//   DELETE /v1/pipeline-stages/:id
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { OrganizationsModule } from '../../src/modules/organizations';
import { PipelinesModule } from '../../src/modules/pipelines';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, PipelinesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';

interface Stage { id: string; name: string; position: number; kind: 'open' | 'won' | 'lost'; is_hidden: boolean; color: string; opportunity_count: number }
interface Pipeline { id: string; name: string; position: number; appointment_stage_id: string | null; opportunity_count: number; stages: Stage[] }
interface Listing { items: Pipeline[]; access: { manage: boolean; write: boolean } }
interface Err { error: { code: string; message: string; details: Array<{ path: string; code: string; message: string }> } }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE stage_history, opportunities, pipeline_stages, pipelines, tasks, notes, contact_companies, companies, contact_import_rows, contact_imports, contact_list_members, contact_lists, contact_tags, tags, meta_events, custom_field_values, custom_field_definitions, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
  for (const [u, o, r, lv] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, lv]);
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
let T: Record<'alice' | 'carol' | 'bob' | 'dave' | 'root', string>;
const code = async (r: Response): Promise<string> => (await json<Err>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
const list = async (t: string): Promise<Listing> => ok<Listing>(await call('GET', '/pipelines', t));
const main = async (t: string): Promise<Pipeline> => (await list(t)).items[0]!;
const stageOf = (p: Pipeline, name: string): Stage => p.stages.find((s) => s.name === name)!;
const names = (p: Pipeline): string[] => p.stages.map((s) => s.name);
const mkPipeline = async (t: string, name: string, stages?: unknown): Promise<Pipeline> => ok<Pipeline>(await call('POST', '/pipelines', t, { name, ...(stages ? { stages } : {}) }), 201);
const audits = async (entityType: string, entityId?: string) =>
  (await admin.query(`SELECT entity_id, field, old_value, new_value FROM audit_logs WHERE entity_type = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY at, id`, entityId ? [entityType, entityId] : [entityType])).rows as Array<{ entity_id: string; field: string | null; old_value: unknown; new_value: Record<string, unknown> }>;

let phoneSeq = 0;
/** Contacto y oportunidad directos en la base (las rutas de oportunidades llegan en M4.2). */
async function insertOpp(org: string, pipelineId: string, stageId: string, over: { owner?: string | null; status?: 'open' | 'won' | 'lost'; contactId?: string } = {}): Promise<{ id: string; contactId: string }> {
  const status = over.status ?? 'open';
  let contactId = over.contactId;
  if (!contactId) {
    const c = await admin.query(`INSERT INTO contacts(organization_id, id, name, source, consent) VALUES ($1, gen_random_uuid(), $2, 'manual', 'unknown') RETURNING id`, [org, `Contacto ${++phoneSeq}`]);
    contactId = c.rows[0].id as string;
  }
  const r = await admin.query(
    `INSERT INTO opportunities(organization_id, id, pipeline_id, stage_id, contact_id, owner_id, status, lost_reason, closed_at) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [org, pipelineId, stageId, contactId, over.owner === undefined ? null : over.owner, status, status === 'lost' ? 'No contestó' : null, status === 'open' ? null : new Date()],
  );
  return { id: r.rows[0].id as string, contactId };
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('permisos', () => {
  it('sin sesión 401 y la plataforma 403 en todas las rutas', async () => {
    const id = NOBODY;
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/pipelines'], ['POST', '/pipelines', { name: 'x' }], ['PUT', '/pipelines/order', { ids: [id] }], ['PATCH', `/pipelines/${id}`, { name: 'y' }], ['DELETE', `/pipelines/${id}`],
      ['POST', `/pipelines/${id}/stages`, { name: 'x' }], ['PUT', `/pipelines/${id}/stages/order`, { ids: [id] }], ['PATCH', `/pipeline-stages/${id}`, { name: 'x' }], ['DELETE', `/pipeline-stages/${id}`],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('el asesor ve los pipelines pero no los configura; la agencia en «lectura» tampoco', async () => {
    const p = await main(T.alice);
    expect((await list(T.carol)).access).toEqual({ manage: false, write: true, view_all: false }); // opera sus oportunidades (M4.2), no configura
    expect((await list(T.alice)).access).toMatchObject({ manage: true });
    const denied: Array<[string, string, unknown?]> = [
      ['POST', '/pipelines', { name: 'x' }], ['PUT', '/pipelines/order', { ids: [p.id] }], ['PATCH', `/pipelines/${p.id}`, { name: 'y' }], ['DELETE', `/pipelines/${p.id}`],
      ['POST', `/pipelines/${p.id}/stages`, { name: 'x' }], ['PUT', `/pipelines/${p.id}/stages/order`, { ids: [p.stages[0]!.id] }], ['PATCH', `/pipeline-stages/${p.stages[0]!.id}`, { name: 'x' }], ['DELETE', `/pipeline-stages/${p.stages[0]!.id}`],
    ];
    for (const [m, path, b] of denied) expect((await call(m, path, T.carol, b)).status, `${m} ${path} asesor`).toBe(403);

    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    expect((await call('POST', '/pipelines', T.dave, { name: 'Agencia' })).status).toBe(201); // nivel administrador
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await call('GET', '/pipelines', T.dave)).status).toBe(200);
    for (const [m, path, b] of denied) expect((await call(m, path, T.dave, b)).status, `${m} ${path} lectura`).toBe(403);
  });
});

describe('listado y pipeline por defecto', () => {
  it('al primer uso nace «Ventas» con las cinco etapas del prototipo; es idempotente y no se repite aunque lleguen dos peticiones a la vez', async () => {
    const [a, b] = await Promise.all([list(T.alice), list(T.carol)]);
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
    const p = await main(T.alice);
    expect(p).toMatchObject({ name: 'Ventas', position: 0, appointment_stage_id: null, opportunity_count: 0 });
    expect(p.stages.map((s) => [s.name, s.kind, s.color, s.position, s.is_hidden])).toEqual([
      ['Nuevo', 'open', 'blue', 0, false], ['Contactado', 'open', 'teal', 1, false], ['Calificado', 'open', 'violet', 2, false], ['Propuesta', 'open', 'amber', 3, false], ['Ganado', 'won', 'green', 4, false],
    ]);
    expect((await admin.query('SELECT count(*)::int AS n FROM pipelines')).rows[0].n).toBe(1);
    expect((await list(T.alice)).items).toHaveLength(1);
  });
});

describe('pipelines', () => {
  it('crea con las etapas por defecto o con las propias; valida nombres, tipos y cantidades', async () => {
    const simple = await mkPipeline(T.alice, 'Cursos');
    expect(simple.stages.map((s) => [s.name, s.kind])).toEqual([['Nuevo', 'open'], ['En seguimiento', 'open'], ['Ganado', 'won']]);
    expect(simple.position).toBe(1);
    const custom = await mkPipeline(T.alice, 'Barbería', [{ name: 'Consulta', color: 'pink' }, { name: 'Cortó', kind: 'won' }, { name: 'No volvió', kind: 'lost' }]);
    expect(custom.stages.map((s) => [s.name, s.kind, s.color])).toEqual([['Consulta', 'open', 'pink'], ['Cortó', 'won', 'green'], ['No volvió', 'lost', 'red']]);

    const bad = async (body: unknown, label: string) => expect((await call('POST', '/pipelines', T.alice, body)).status, label).toBe(400);
    await bad({}, 'sin nombre');
    await bad({ name: '  ' }, 'nombre en blanco');
    await bad({ name: 'x'.repeat(61) }, 'nombre largo');
    await bad({ name: 'Ok', stages: [{ name: 'Solo' }] }, 'menos de dos etapas');
    await bad({ name: 'Ok', stages: [{ name: 'A' }, { name: 'B' }] }, 'sin ganada');
    await bad({ name: 'Ok', stages: [{ name: 'A', kind: 'won' }, { name: 'B', kind: 'won' }] }, 'dos ganadas');
    await bad({ name: 'Ok', stages: [{ name: 'A', kind: 'won' }, { name: 'B', kind: 'lost' }] }, 'sin etapa abierta');
    await bad({ name: 'Ok', stages: [{ name: 'A' }, { name: 'B', kind: 'lost' }, { name: 'C', kind: 'lost' }, { name: 'D', kind: 'won' }] }, 'dos perdidas');
    await bad({ name: 'Ok', stages: [{ name: 'A' }, { name: 'a', kind: 'won' }] }, 'nombres repetidos');
    await bad({ name: 'Ok', stages: [{ name: 'A', color: 'fucsia' }, { name: 'B', kind: 'won' }] }, 'color fuera de la paleta');
    await bad({ name: 'Ok', otro: 1 }, 'campo desconocido');
  });

  it('el nombre es único sin distinguir mayúsculas; renombrar y borrar liberan el nombre', async () => {
    await mkPipeline(T.alice, 'Cursos');
    const dup = await call('POST', '/pipelines', T.alice, { name: 'cursos' });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('PIPELINE_EXISTS');
    const other = await mkPipeline(T.alice, 'Otro');
    expect(await code(await call('PATCH', `/pipelines/${other.id}`, T.alice, { name: 'CURSOS' }))).toBe('PIPELINE_EXISTS');
    const renamed = await ok<Pipeline>(await call('PATCH', `/pipelines/${other.id}`, T.alice, { name: 'Renovaciones' }));
    expect(renamed.name).toBe('Renovaciones');
    await ok(await call('DELETE', `/pipelines/${other.id}`, T.alice));
    expect((await call('POST', '/pipelines', T.alice, { name: 'Renovaciones' })).status).toBe(201);
    expect((await call('PATCH', `/pipelines/${other.id}`, T.alice, { name: 'x' })).status).toBe(404);
    expect((await call('PATCH', `/pipelines/${renamed.id}`, T.alice, {})).status).toBe(400);
  });

  it('hasta 10 pipelines', async () => {
    await list(T.alice);
    for (let i = 2; i <= 10; i++) await mkPipeline(T.alice, `Pipeline ${i}`);
    const over = await call('POST', '/pipelines', T.alice, { name: 'Pipeline 11' });
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('PIPELINE_LIMIT');
  });

  it('el último pipeline no se borra; uno con oportunidades tampoco; si no, se borra con sus etapas (borrado lógico)', async () => {
    const first = await main(T.alice);
    const lastTry = await call('DELETE', `/pipelines/${first.id}`, T.alice);
    expect(lastTry.status).toBe(409);
    expect(await code(lastTry)).toBe('PIPELINE_LAST');
    const second = await mkPipeline(T.alice, 'Cursos');
    await insertOpp(ORG_A, second.id, stageOf(second, 'Nuevo').id);
    const busy = await call('DELETE', `/pipelines/${second.id}`, T.alice);
    expect(busy.status).toBe(409);
    expect(await code(busy)).toBe('PIPELINE_HAS_OPPORTUNITIES');
    await ok(await call('DELETE', `/pipelines/${first.id}`, T.alice)); // el primero está vacío
    expect((await list(T.alice)).items.map((p) => p.name)).toEqual(['Cursos']);
    expect((await admin.query('SELECT count(*)::int AS n FROM pipeline_stages WHERE pipeline_id = $1 AND deleted_at IS NULL', [first.id])).rows[0].n).toBe(0);
    expect((await call('DELETE', `/pipelines/${first.id}`, T.alice)).status).toBe(404);
    expect((await call('POST', `/pipelines/${first.id}/stages`, T.alice, { name: 'x' })).status).toBe(404);
  });

  it('reordena los pipelines; un orden desactualizado es 409', async () => {
    const a = await main(T.alice);
    const b = await mkPipeline(T.alice, 'B');
    const c = await mkPipeline(T.alice, 'C');
    const out = await ok<Listing>(await call('PUT', '/pipelines/order', T.alice, { ids: [c.id, a.id, b.id] }));
    expect(out.items.map((p) => p.name)).toEqual(['C', 'Ventas', 'B']);
    expect(out.items.map((p) => p.position)).toEqual([0, 1, 2]);
    const stale = await call('PUT', '/pipelines/order', T.alice, { ids: [a.id, b.id] });
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('PIPELINE_ORDER_STALE');
    expect((await call('PUT', '/pipelines/order', T.alice, { ids: [a.id, a.id, b.id, c.id] })).status).toBe(400);
  });

  it('etapa de cita: opcional, de este pipeline y abierta; se limpia si la etapa deja de ser abierta o se borra', async () => {
    const p = await main(T.alice);
    const other = await mkPipeline(T.alice, 'Otro');
    const set = (stageId: string | null) => call('PATCH', `/pipelines/${p.id}`, T.alice, { appointment_stage_id: stageId });
    expect((await set(stageOf(other, 'Nuevo').id)).status).toBe(400); // de otro pipeline
    expect((await set(NOBODY)).status).toBe(400);
    expect((await set(stageOf(p, 'Ganado').id)).status).toBe(400); // la ganada no
    const withAppt = await ok<Pipeline>(await set(stageOf(p, 'Calificado').id));
    expect(withAppt.appointment_stage_id).toBe(stageOf(p, 'Calificado').id);
    expect((await ok<Pipeline>(await set(null))).appointment_stage_id).toBeNull();
    await set(stageOf(p, 'Propuesta').id);
    await ok(await call('PATCH', `/pipeline-stages/${stageOf(p, 'Propuesta').id}`, T.alice, { kind: 'lost' }));
    expect((await main(T.alice)).appointment_stage_id).toBeNull();
    await set(stageOf(p, 'Calificado').id);
    await ok(await call('DELETE', `/pipeline-stages/${stageOf(p, 'Calificado').id}`, T.alice));
    expect((await main(T.alice)).appointment_stage_id).toBeNull();
  });
});

describe('etapas', () => {
  it('crea una etapa abierta justo antes de la ganada y una perdida al final; nombre único; hasta 15', async () => {
    const p = await main(T.alice);
    const a = await ok<Pipeline>(await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Negociación', color: 'pink' }), 201);
    expect(names(a)).toEqual(['Nuevo', 'Contactado', 'Calificado', 'Propuesta', 'Negociación', 'Ganado']);
    expect(a.stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(stageOf(a, 'Negociación')).toMatchObject({ kind: 'open', color: 'pink' });
    const b = await ok<Pipeline>(await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Perdido', kind: 'lost' }), 201);
    expect(names(b).at(-1)).toBe('Perdido');
    expect(stageOf(b, 'Perdido')).toMatchObject({ kind: 'lost', color: 'red' });
    expect(await code(await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Otra perdida', kind: 'lost' }))).toBe('STAGE_KIND_TAKEN');
    const dup = await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'nuevo' });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('STAGE_EXISTS');
    expect((await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'X', kind: 'won' })).status).toBe(400);
    expect((await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: '' })).status).toBe(400);
    expect((await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'x'.repeat(41) })).status).toBe(400);
    // 7 etapas hasta aquí; llenar hasta 15
    for (let i = 8; i <= 15; i++) await ok(await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: `Etapa ${i}` }), 201);
    const over = await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Etapa 16' });
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('STAGE_LIMIT');
  });

  it('renombra, cambia el color y oculta; la ganada no se oculta; el nombre sigue siendo único; el mismo nombre en otro pipeline vale', async () => {
    const p = await main(T.alice);
    const other = await mkPipeline(T.alice, 'Otro');
    const id = stageOf(p, 'Contactado').id;
    const out = await ok<Pipeline>(await call('PATCH', `/pipeline-stages/${id}`, T.alice, { name: 'Primer contacto', color: 'gray', is_hidden: true }));
    expect(stageOf(out, 'Primer contacto')).toMatchObject({ color: 'gray', is_hidden: true });
    expect(await code(await call('PATCH', `/pipeline-stages/${id}`, T.alice, { name: 'NUEVO' }))).toBe('STAGE_EXISTS');
    expect((await call('PATCH', `/pipeline-stages/${stageOf(other, 'Nuevo').id}`, T.alice, { name: 'Calificado' })).status).toBe(200);
    const hideWon = await call('PATCH', `/pipeline-stages/${stageOf(p, 'Ganado').id}`, T.alice, { is_hidden: true });
    expect(hideWon.status).toBe(409);
    expect(await code(hideWon)).toBe('STAGE_WON_HIDDEN');
    expect((await ok<Pipeline>(await call('PATCH', `/pipeline-stages/${id}`, T.alice, { is_hidden: false }))).stages.find((s) => s.id === id)!.is_hidden).toBe(false);
    expect((await call('PATCH', `/pipeline-stages/${id}`, T.alice, {})).status).toBe(400);
    expect((await call('PATCH', `/pipeline-stages/${id}`, T.alice, { color: 'fucsia' })).status).toBe(400);
    expect((await call('PATCH', `/pipeline-stages/${NOBODY}`, T.alice, { name: 'x' })).status).toBe(404);
  });

  it('marcar otra etapa como ganada deja a la anterior abierta (y la muestra si estaba oculta); la ganada no pasa a abierta ni a perdida directamente', async () => {
    const p = await main(T.alice);
    await ok(await call('PATCH', `/pipeline-stages/${stageOf(p, 'Propuesta').id}`, T.alice, { is_hidden: true }));
    const out = await ok<Pipeline>(await call('PATCH', `/pipeline-stages/${stageOf(p, 'Propuesta').id}`, T.alice, { kind: 'won' }));
    expect(stageOf(out, 'Propuesta')).toMatchObject({ kind: 'won', is_hidden: false });
    expect(stageOf(out, 'Ganado').kind).toBe('open');
    expect(out.stages.filter((s) => s.kind === 'won')).toHaveLength(1);
    for (const kind of ['open', 'lost']) {
      const r = await call('PATCH', `/pipeline-stages/${stageOf(out, 'Propuesta').id}`, T.alice, { kind });
      expect(r.status, kind).toBe(409);
      expect(await code(r)).toBe('STAGE_WON_REQUIRED');
    }
  });

  it('perdida: se marca, cambia de etapa y vuelve a abierta; la última abierta no se puede convertir', async () => {
    const p = await mkPipeline(T.alice, 'Corto'); // Nuevo, En seguimiento, Ganado
    const lost = await ok<Pipeline>(await call('PATCH', `/pipeline-stages/${stageOf(p, 'En seguimiento').id}`, T.alice, { kind: 'lost' }));
    expect(stageOf(lost, 'En seguimiento').kind).toBe('lost');
    const swapped = await ok<Pipeline>(await call('PATCH', `/pipeline-stages/${stageOf(p, 'Nuevo').id}`, T.alice, { kind: 'lost' }));
    expect(stageOf(swapped, 'Nuevo').kind).toBe('lost'); // quedaba «En seguimiento» abierta tras el cambio de titular
    expect(stageOf(swapped, 'En seguimiento').kind).toBe('open');
    const back = await ok<Pipeline>(await call('PATCH', `/pipeline-stages/${stageOf(p, 'Nuevo').id}`, T.alice, { kind: 'open' }));
    expect(stageOf(back, 'Nuevo').kind).toBe('open');
    // dos etapas más: Nuevo(open), En seguimiento(open), Ganado → convertir una en perdida deja una abierta
    await ok(await call('PATCH', `/pipeline-stages/${stageOf(p, 'Nuevo').id}`, T.alice, { kind: 'lost' }));
    const last = await call('PATCH', `/pipeline-stages/${stageOf(p, 'En seguimiento').id}`, T.alice, { kind: 'lost' });
    expect(last.status).toBe(200); // «Nuevo» (perdida) cede su tipo y vuelve a abierta: sigue habiendo una abierta
    const final = await main(T.alice).then(() => list(T.alice)).then((l) => l.items.find((x) => x.id === p.id)!);
    expect(final.stages.filter((s) => s.kind === 'open')).toHaveLength(1);
    const noOpen = await call('PATCH', `/pipeline-stages/${final.stages.find((s) => s.kind === 'open')!.id}`, T.alice, { kind: 'won' });
    expect(noOpen.status).toBe(200); // la ganada cede su tipo y queda abierta
    expect((await list(T.alice)).items.find((x) => x.id === p.id)!.stages.filter((s) => s.kind === 'open')).toHaveLength(1);
  });

  it('cambiar el tipo de una etapa con oportunidades se rechaza, también si la que cedería el tipo tiene oportunidades', async () => {
    const p = await main(T.alice);
    await insertOpp(ORG_A, p.id, stageOf(p, 'Calificado').id);
    const r = await call('PATCH', `/pipeline-stages/${stageOf(p, 'Calificado').id}`, T.alice, { kind: 'lost' });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('STAGE_KIND_HAS_OPPORTUNITIES');
    await insertOpp(ORG_A, p.id, stageOf(p, 'Ganado').id, { status: 'won' });
    const swap = await call('PATCH', `/pipeline-stages/${stageOf(p, 'Propuesta').id}`, T.alice, { kind: 'won' });
    expect(swap.status).toBe(409);
    expect(await code(swap)).toBe('STAGE_KIND_HAS_OPPORTUNITIES');
    expect((await main(T.alice)).stages.find((s) => s.name === 'Ganado')!.kind).toBe('won'); // nada cambió
  });

  it('eliminar: la ganada no; la única abierta no; una abierta con oportunidades las pasa a la abierta anterior (a la siguiente si era la primera) y lo deja en el historial', async () => {
    const p = await main(T.alice);
    const won = await call('DELETE', `/pipeline-stages/${stageOf(p, 'Ganado').id}`, T.alice);
    expect(won.status).toBe(409);
    expect(await code(won)).toBe('STAGE_WON_REQUIRED');

    const o1 = await insertOpp(ORG_A, p.id, stageOf(p, 'Calificado').id);
    const o2 = await insertOpp(ORG_A, p.id, stageOf(p, 'Nuevo').id);
    const out = await ok<Pipeline>(await call('DELETE', `/pipeline-stages/${stageOf(p, 'Calificado').id}`, T.alice));
    expect(names(out)).toEqual(['Nuevo', 'Contactado', 'Propuesta', 'Ganado']);
    expect(out.stages.map((s) => s.position)).toEqual([0, 1, 2, 3]);
    expect((await admin.query('SELECT stage_id FROM opportunities WHERE id = $1', [o1.id])).rows[0].stage_id).toBe(stageOf(p, 'Contactado').id);
    const hist = (await admin.query('SELECT from_stage_id, to_stage_id, origin, user_id FROM stage_history WHERE opportunity_id = $1', [o1.id])).rows;
    expect(hist).toEqual([{ from_stage_id: stageOf(p, 'Calificado').id, to_stage_id: stageOf(p, 'Contactado').id, origin: 'system', user_id: IDS.alice }]);
    expect(stageOf(out, 'Contactado').opportunity_count).toBe(1);

    // la primera etapa: sus oportunidades pasan a la siguiente abierta
    await ok(await call('DELETE', `/pipeline-stages/${stageOf(p, 'Nuevo').id}`, T.alice));
    expect((await admin.query('SELECT stage_id FROM opportunities WHERE id = $1', [o2.id])).rows[0].stage_id).toBe(stageOf(p, 'Contactado').id);
    expect((await admin.query('SELECT count(*)::int AS n FROM stage_history')).rows[0].n).toBe(2);
    expect((await audits('pipeline_stage', stageOf(p, 'Calificado').id)).at(-1)!.new_value).toEqual({ deleted: true, moved_opportunities: 1 });

    // se borran hasta quedar una abierta
    await ok(await call('DELETE', `/pipeline-stages/${stageOf(p, 'Propuesta').id}`, T.alice));
    const lastOpen = await call('DELETE', `/pipeline-stages/${stageOf(p, 'Contactado').id}`, T.alice);
    expect(lastOpen.status).toBe(409);
    expect(await code(lastOpen)).toBe('STAGE_LAST_OPEN');
    expect((await call('DELETE', `/pipeline-stages/${stageOf(p, 'Calificado').id}`, T.alice)).status).toBe(404);
  });

  it('eliminar una etapa perdida con oportunidades se rechaza; sin ellas se elimina; el nombre de una etapa eliminada queda libre', async () => {
    const p = await main(T.alice);
    await ok(await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Perdido', kind: 'lost' }), 201);
    const withLost = await main(T.alice);
    await insertOpp(ORG_A, p.id, stageOf(withLost, 'Perdido').id, { status: 'lost' });
    const r = await call('DELETE', `/pipeline-stages/${stageOf(withLost, 'Perdido').id}`, T.alice);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('STAGE_HAS_CLOSED_OPPORTUNITIES');
    await ok(await call('DELETE', `/pipeline-stages/${stageOf(withLost, 'Propuesta').id}`, T.alice));
    expect((await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Propuesta' })).status).toBe(201);
  });

  it('reordena las etapas; un orden desactualizado o incompleto es 409', async () => {
    const p = await main(T.alice);
    const ids = p.stages.map((s) => s.id);
    const wanted = [ids[1]!, ids[0]!, ids[2]!, ids[4]!, ids[3]!];
    const out = await ok<Pipeline>(await call('PUT', `/pipelines/${p.id}/stages/order`, T.alice, { ids: wanted }));
    expect(names(out)).toEqual(['Contactado', 'Nuevo', 'Calificado', 'Ganado', 'Propuesta']);
    expect(out.stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
    const stale = await call('PUT', `/pipelines/${p.id}/stages/order`, T.alice, { ids: wanted.slice(1) });
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('STAGE_ORDER_STALE');
    expect((await call('PUT', `/pipelines/${NOBODY}/stages/order`, T.alice, { ids: wanted })).status).toBe(404);
    expect((await audits('pipeline_stage')).filter((a) => a.field === 'position').length).toBeGreaterThan(0);
  });

  it('cada cambio queda en la auditoría', async () => {
    const p = await main(T.alice);
    await call('PATCH', `/pipelines/${p.id}`, T.alice, { name: 'Ventas 2' });
    const s = await ok<Pipeline>(await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Extra' }), 201);
    await call('PATCH', `/pipeline-stages/${stageOf(s, 'Extra').id}`, T.alice, { name: 'Extra 2', color: 'pink' });
    await call('DELETE', `/pipeline-stages/${stageOf(s, 'Extra').id}`, T.alice);
    expect((await audits('pipeline', p.id)).map((a) => a.field)).toEqual([null, 'name']);
    expect((await audits('pipeline_stage', stageOf(s, 'Extra').id)).map((a) => a.field)).toEqual([null, 'name', 'color', 'deleted']);
  });
});

describe('conteo de oportunidades por persona', () => {
  it('el asesor cuenta solo las suyas; el administrador, todas', async () => {
    const p = await main(T.alice);
    await insertOpp(ORG_A, p.id, stageOf(p, 'Nuevo').id, { owner: IDS.carol });
    await insertOpp(ORG_A, p.id, stageOf(p, 'Nuevo').id, { owner: IDS.alice });
    await insertOpp(ORG_A, p.id, stageOf(p, 'Contactado').id, { owner: null });
    const asAdmin = await main(T.alice);
    expect(asAdmin.opportunity_count).toBe(3);
    expect(stageOf(asAdmin, 'Nuevo').opportunity_count).toBe(2);
    const asAdvisor = await main(T.carol);
    expect(asAdvisor.opportunity_count).toBe(1);
    expect(stageOf(asAdvisor, 'Nuevo').opportunity_count).toBe(1);
    expect(stageOf(asAdvisor, 'Contactado').opportunity_count).toBe(0);
  });
});

describe('aislamiento A↔B', () => {
  it('B tiene sus propios pipelines y no ve, cambia ni borra los de A (404); los nombres se comparan por empresa', async () => {
    const a = await main(T.alice);
    const bMain = await main(T.bob);
    expect(bMain.id).not.toBe(a.id);
    expect(bMain.name).toBe('Ventas'); // el mismo nombre en otra empresa es válido
    expect((await list(T.bob)).items.map((p) => p.id)).not.toContain(a.id);
    for (const [m, p, b] of [
      ['PATCH', `/pipelines/${a.id}`, { name: 'Robado' }], ['DELETE', `/pipelines/${a.id}`], ['POST', `/pipelines/${a.id}/stages`, { name: 'x' }], ['PUT', `/pipelines/${a.id}/stages/order`, { ids: a.stages.map((s) => s.id) }],
      ['PATCH', `/pipeline-stages/${a.stages[0]!.id}`, { name: 'Robada' }], ['DELETE', `/pipeline-stages/${a.stages[0]!.id}`],
    ] as const) {
      expect((await call(m, p, T.bob, b)).status, `${m} ${p}`).toBe(404);
    }
    // una etapa de A no sirve como etapa de cita de B
    expect((await call('PATCH', `/pipelines/${bMain.id}`, T.bob, { appointment_stage_id: a.stages[0]!.id })).status).toBe(400);
    // el orden de B no admite pipelines de A
    expect((await call('PUT', '/pipelines/order', T.bob, { ids: [a.id] })).status).toBe(409);
    expect((await main(T.alice)).name).toBe('Ventas');
    expect(names(await main(T.alice))).toEqual(['Nuevo', 'Contactado', 'Calificado', 'Propuesta', 'Ganado']);
  });
});

describe('base de datos: privilegios y restricciones', () => {
  const as = async (url: string, sql: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  };

  it('app_rw no borra ni vacía; el historial de etapas es solo de inserción; platform e identity no ven las tablas', async () => {
    for (const t of ['pipelines', 'pipeline_stages', 'opportunities', 'stage_history']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `DELETE ${t}`).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(as(info.rwUrl, `UPDATE stage_history SET origin = 'manual'`)).rejects.toThrow(/permission denied/);
  });

  it('las restricciones imponen las reglas: una ganada, una perdida, nombres, ganada visible, una abierta por contacto y pipeline, motivo de pérdida y cierre coherentes', async () => {
    const p = await main(T.alice);
    const q = await mkPipeline(T.alice, 'Otro');
    const sql = (text: string) => admin.query(text);
    const st = (pipeline: string, name: string, kind: string, extra = '') => `INSERT INTO pipeline_stages(organization_id, id, pipeline_id, name, position, kind ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ('${ORG_A}', gen_random_uuid(), '${pipeline}', '${name}', 20, '${kind}' ${extra ? ', ' + extra.split('=')[1] : ''})`;
    await expect(sql(st(p.id, 'Otra ganada', 'won'))).rejects.toThrow(/pipeline_stages_one_won_uq/);
    await expect(sql(st(p.id, 'Perdida 1', 'lost'))).resolves.toBeDefined();
    await expect(sql(st(p.id, 'Perdida 2', 'lost'))).rejects.toThrow(/pipeline_stages_one_lost_uq/);
    await expect(sql(st(p.id, 'ganado', 'open'))).rejects.toThrow(/pipeline_stages_name_uq/);
    await expect(sql(st(p.id, '   ', 'open'))).rejects.toThrow(/pipeline_stages_name_shape/);
    await expect(sql(st(p.id, 'Rara', 'rara'))).rejects.toThrow(/pipeline_stages_kind_valid/);
    await expect(sql(st(p.id, 'Color', 'open', `color='fucsia'`))).rejects.toThrow(/pipeline_stages_color_valid/);
    await expect(sql(`UPDATE pipeline_stages SET is_hidden = true WHERE id = '${stageOf(p, 'Ganado').id}'`)).rejects.toThrow(/pipeline_stages_won_visible/);
    await expect(sql(`UPDATE pipelines SET name = 'ventas' WHERE id = '${q.id}'`)).rejects.toThrow(/pipelines_org_name_uq/);
    // la etapa de cita debe ser del MISMO pipeline
    await expect(sql(`UPDATE pipelines SET appointment_stage_id = '${stageOf(q, 'Nuevo').id}' WHERE id = '${p.id}'`)).rejects.toThrow(/pipelines_appointment_stage_fk/);

    const nuevo = stageOf(p, 'Nuevo').id;
    const opp = await insertOpp(ORG_A, p.id, nuevo);
    await expect(insertOpp(ORG_A, p.id, nuevo, { contactId: opp.contactId })).rejects.toThrow(/opportunities_one_open_uq/);
    await expect(insertOpp(ORG_A, p.id, stageOf(p, 'Ganado').id, { status: 'won', contactId: opp.contactId })).resolves.toBeDefined(); // cerradas sí pueden repetirse
    await expect(insertOpp(ORG_A, q.id, stageOf(q, 'Nuevo').id, { contactId: opp.contactId })).resolves.toBeDefined(); // otro pipeline, otra oportunidad
    await expect(insertOpp(ORG_A, p.id, stageOf(q, 'Nuevo').id)).rejects.toThrow(/opportunities_stage_fk/); // etapa de otro pipeline
    await expect(sql(`UPDATE opportunities SET status = 'lost' WHERE id = '${opp.id}'`)).rejects.toThrow(/opportunities_(lost_reason|closed)_consistent/);
    await expect(sql(`UPDATE opportunities SET lost_reason = 'x' WHERE id = '${opp.id}'`)).rejects.toThrow(/opportunities_lost_reason_consistent/);
    await expect(sql(`UPDATE opportunities SET status = 'won' WHERE id = '${opp.id}'`)).rejects.toThrow(/opportunities_closed_consistent/);
    await expect(sql(`UPDATE opportunities SET amount = -1 WHERE id = '${opp.id}'`)).rejects.toThrow(/opportunities_amount_valid/);
    await expect(sql(`UPDATE opportunities SET currency = 'usd' WHERE id = '${opp.id}'`)).rejects.toThrow(/opportunities_currency_valid/);
    // claves foráneas entre empresas
    const bPipeline = await main(T.bob);
    await expect(insertOpp(ORG_A, bPipeline.id, bPipeline.stages[0]!.id)).rejects.toThrow(/opportunities_pipeline_fk|opportunities_stage_fk/);
    await expect(sql(`INSERT INTO stage_history(organization_id, id, opportunity_id, to_stage_id, origin) VALUES ('${ORG_B}', gen_random_uuid(), '${opp.id}', '${bPipeline.stages[0]!.id}', 'manual')`)).rejects.toThrow(/stage_history_opportunity_fk/);
    await expect(sql(`INSERT INTO stage_history(organization_id, id, opportunity_id, to_stage_id, origin) VALUES ('${ORG_A}', gen_random_uuid(), '${opp.id}', '${nuevo}', 'raro')`)).rejects.toThrow(/stage_history_origin_valid/);
  });

  it('la RLS: sin organización activa app_rw no ve nada; con la de A no ve lo de B', async () => {
    await main(T.alice);
    await main(T.bob);
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const t of ['pipelines', 'pipeline_stages']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query('SELECT count(*)::int AS n FROM pipelines')).rows[0].n).toBe(1);
      expect((await c.query('SELECT count(*)::int AS n FROM pipeline_stages')).rows[0].n).toBe(5);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
