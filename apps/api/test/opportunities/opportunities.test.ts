// M4.2 — Oportunidades (ADR-49). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/opportunities
//   POST /v1/opportunities
//   GET /v1/opportunities/:id
//   PATCH /v1/opportunities/:id
//   DELETE /v1/opportunities/:id
//   POST /v1/opportunities/:id/move
//   GET /v1/pipelines/:id/summary
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
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { PipelinesModule } from '../../src/modules/pipelines';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, PipelinesModule, OpportunitiesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  erin: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';

interface Stage { id: string; name: string; kind: 'open' | 'won' | 'lost'; is_hidden: boolean }
interface Pipeline { id: string; name: string; stages: Stage[]; opportunity_count: number }
interface Contact { id: string; name: string }
interface Opp {
  id: string; pipeline_id: string; stage_id: string; status: 'open' | 'won' | 'lost'; amount: string; currency: string; owner: { id: string; name: string } | null; lost_reason: string | null; closed_at: string | null;
  contact: { id: string; name: string; email: string | null; phone: string | null; source: string; tags: Array<{ id: string; name: string }> };
  history: Array<{ from_stage: { id: string; name: string } | null; to_stage: { id: string; name: string }; user: { id: string } | null; origin: string }>;
}
interface Page { items: Opp[]; next_cursor: string | null; access: { write: boolean; view_all: boolean } }
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
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.erin, 'erin@a.test', 'Erika Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.erin, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
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
let T: Record<'alice' | 'carol' | 'erin' | 'bob' | 'dave' | 'root', string>;
const code = async (r: Response): Promise<string> => (await json<Err>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
const pipelinesOf = async (t: string): Promise<Pipeline[]> => (await ok<{ items: Pipeline[] }>(await call('GET', '/pipelines', t))).items;
const main = async (t: string): Promise<Pipeline> => (await pipelinesOf(t))[0]!;
const stage = (p: Pipeline, name: string): Stage => p.stages.find((s) => s.name === name)!;
let seq = 0;
const mkContact = async (t: string, name: string, extra: Record<string, unknown> = {}): Promise<Contact> => ok<Contact>(await call('POST', '/contacts', t, { name, phones: [`+5939${String(10000000 + ++seq)}`], ...extra }), 201);
const mkOpp = async (t: string, body: Record<string, unknown>): Promise<Opp> => ok<Opp>(await call('POST', '/opportunities', t, body), 201);
const move = (t: string, id: string, stageId: string, reason?: string) => call('POST', `/opportunities/${id}/move`, t, { stage_id: stageId, ...(reason ? { lost_reason: reason } : {}) });
const names = (page: Page): string[] => page.items.map((o) => o.contact.name);
const listOpps = async (t: string, qs = ''): Promise<Page> => ok<Page>(await call('GET', `/opportunities${qs ? `?${qs}` : ''}`, t));
const audits = async (entityId: string) =>
  (await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'opportunity' AND entity_id = $1 ORDER BY at, id`, [entityId])).rows as Array<{ field: string | null; old_value: unknown; new_value: Record<string, unknown> | string }>;

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
  seq = 0;
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), erin: await login('erin@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('permisos', () => {
  it('sin sesión 401 y la plataforma 403 en todas las rutas', async () => {
    const id = NOBODY;
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/opportunities'], ['POST', '/opportunities', { contact_id: id }], ['GET', `/opportunities/${id}`], ['PATCH', `/opportunities/${id}`, { amount: 1 }], ['DELETE', `/opportunities/${id}`],
      ['POST', `/opportunities/${id}/move`, { stage_id: id }], ['GET', `/pipelines/${id}/summary`],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('el asesor opera sus oportunidades; la agencia en «lectura» solo lee', async () => {
    const c = await mkContact(T.carol, 'De Carolina');
    const o = await mkOpp(T.carol, { contact_id: c.id });
    expect((await listOpps(T.carol)).access).toEqual({ write: true, view_all: false });
    expect((await listOpps(T.alice)).access).toEqual({ write: true, view_all: true });
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    expect((await call('GET', `/opportunities/${o.id}`, T.dave)).status).toBe(200);
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await call('GET', '/opportunities', T.dave)).status).toBe(200);
    expect((await listOpps(T.dave)).access.write).toBe(false);
    const p = await main(T.alice);
    for (const [m, path, b] of [['POST', '/opportunities', { contact_id: c.id }], ['PATCH', `/opportunities/${o.id}`, { amount: 5 }], ['POST', `/opportunities/${o.id}/move`, { stage_id: stage(p, 'Contactado').id }], ['DELETE', `/opportunities/${o.id}`]] as const) {
      expect((await call(m, path, T.dave, b)).status, `${m} ${path} lectura`).toBe(403);
    }
  });
});

describe('crear', () => {
  it('sin pipeline ni etapa usa el primer pipeline y su primera etapa abierta; deja el historial y la auditoría', async () => {
    const p = await main(T.alice);
    const c = await mkContact(T.alice, 'Ana Torres', { email: 'ana@x.test' });
    const o = await mkOpp(T.alice, { contact_id: c.id });
    expect(o).toMatchObject({ pipeline_id: p.id, stage_id: stage(p, 'Nuevo').id, status: 'open', amount: '0.00', currency: 'USD', lost_reason: null, closed_at: null, owner: null });
    expect(o.contact).toMatchObject({ id: c.id, name: 'Ana Torres', email: 'ana@x.test', source: 'manual' });
    expect(o.contact.phone).toMatch(/^\+5939/);
    expect(o.history).toHaveLength(1);
    expect(o.history[0]).toMatchObject({ from_stage: null, to_stage: { name: 'Nuevo' }, user: { id: IDS.alice }, origin: 'manual' });
    const a = await audits(o.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.new_value).toMatchObject({ contact_id: c.id, stage_id: stage(p, 'Nuevo').id });
  });

  it('elige pipeline y etapa; la etapa debe ser abierta, visible y del pipeline', async () => {
    const p = await main(T.alice);
    const other = await ok<Pipeline>(await call('POST', '/pipelines', T.alice, { name: 'Cursos' }), 201);
    await ok(await call('PATCH', `/pipeline-stages/${stage(p, 'Calificado').id}`, T.alice, { is_hidden: true }));
    const c = await mkContact(T.alice, 'Ana');
    const bad = async (body: Record<string, unknown>, label: string) => expect((await call('POST', '/opportunities', T.alice, { contact_id: c.id, ...body })).status, label).toBe(400);
    await bad({ stage_id: stage(p, 'Ganado').id }, 'etapa ganada');
    await bad({ stage_id: stage(p, 'Calificado').id }, 'etapa oculta');
    await bad({ stage_id: stage(other, 'Nuevo').id }, 'etapa de otro pipeline');
    await bad({ pipeline_id: NOBODY }, 'pipeline inexistente');
    await bad({ amount: 'abc' }, 'monto no numérico');
    await bad({ owner_id: 'x' }, 'responsable mal escrito');
    await bad({ otro: 1 }, 'campo desconocido');
    const o = await mkOpp(T.alice, { contact_id: c.id, pipeline_id: other.id, stage_id: stage(other, 'En seguimiento').id });
    expect(o).toMatchObject({ pipeline_id: other.id, stage_id: stage(other, 'En seguimiento').id });
  });

  it('el monto se normaliza a texto con 2 decimales y rechaza negativos, más de 2 decimales y desbordes', async () => {
    const p = await main(T.alice);
    const make = async (amount: unknown) => {
      const c = await mkContact(T.alice, `C ${++seq}`);
      return call('POST', '/opportunities', T.alice, { contact_id: c.id, amount });
    };
    expect((await ok<Opp>(await make(1500.5), 201)).amount).toBe('1500.50');
    expect((await ok<Opp>(await make('99'), 201)).amount).toBe('99.00');
    expect((await ok<Opp>(await make('1,5'), 201)).amount).toBe('1.50');
    expect((await ok<Opp>(await make(0), 201)).amount).toBe('0.00');
    expect((await ok<Opp>(await make('999999999999.99'), 201)).amount).toBe('999999999999.99');
    for (const v of [-1, '-5', 1.234, '1.234', '1e3', 'abc', '', 1e15, '1000000000000']) expect((await make(v)).status, String(v)).toBe(400);
    expect(p.id).toBeTruthy();
  });

  it('una sola abierta por contacto y pipeline (409); otro pipeline o una cerrada no estorban', async () => {
    const p = await main(T.alice);
    const other = await ok<Pipeline>(await call('POST', '/pipelines', T.alice, { name: 'Cursos' }), 201);
    const c = await mkContact(T.alice, 'Ana');
    const first = await mkOpp(T.alice, { contact_id: c.id });
    const dup = await call('POST', '/opportunities', T.alice, { contact_id: c.id });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('OPPORTUNITY_OPEN_EXISTS');
    expect((await call('POST', '/opportunities', T.alice, { contact_id: c.id, pipeline_id: other.id })).status).toBe(201);
    await ok(await move(T.alice, first.id, stage(p, 'Ganado').id));
    expect((await call('POST', '/opportunities', T.alice, { contact_id: c.id })).status).toBe(201); // ya cerró la anterior
  });

  it('responsable: el asesor solo se asigna a sí mismo; el administrador elige a alguien de la empresa, nadie, o hereda el del contacto', async () => {
    const carolContact = await mkContact(T.carol, 'De Carolina');
    expect((await mkOpp(T.carol, { contact_id: carolContact.id })).owner?.id).toBe(IDS.carol);
    const denied = await call('POST', '/opportunities', T.carol, { contact_id: (await mkContact(T.carol, 'Otro')).id, owner_id: IDS.erin });
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('OWNER_NOT_ALLOWED');
    // el administrador: hereda el responsable del contacto, o pide otro, o ninguno
    const assigned = await mkContact(T.alice, 'Asignado', { owner_id: IDS.erin });
    expect((await mkOpp(T.alice, { contact_id: assigned.id })).owner?.id).toBe(IDS.erin);
    const free = await mkContact(T.alice, 'Libre', { owner_id: IDS.erin });
    expect((await mkOpp(T.alice, { contact_id: free.id, owner_id: IDS.carol })).owner?.id).toBe(IDS.carol);
    const none = await mkContact(T.alice, 'Sin dueño', { owner_id: IDS.erin });
    expect((await mkOpp(T.alice, { contact_id: none.id, owner_id: null })).owner).toBeNull();
    const invalid = await call('POST', '/opportunities', T.alice, { contact_id: (await mkContact(T.alice, 'X')).id, owner_id: IDS.bob });
    expect(invalid.status).toBe(400);
  });

  it('el contacto debe existir y la persona debe poder verlo (404 uniforme)', async () => {
    const hers = await mkContact(T.erin, 'De Erika');
    expect((await call('POST', '/opportunities', T.carol, { contact_id: hers.id })).status).toBe(404);
    expect((await call('POST', '/opportunities', T.carol, { contact_id: NOBODY })).status).toBe(404);
    expect((await call('POST', '/opportunities', T.alice, { contact_id: hers.id })).status).toBe(201);
  });
});

describe('mover', () => {
  it('entre etapas abiertas: actualiza la etapa y deja el historial en orden; mover a donde ya está no hace nada', async () => {
    const p = await main(T.alice);
    const o = await mkOpp(T.alice, { contact_id: (await mkContact(T.alice, 'Ana')).id });
    const moved = await ok<Opp>(await move(T.alice, o.id, stage(p, 'Calificado').id));
    expect(moved).toMatchObject({ stage_id: stage(p, 'Calificado').id, status: 'open' });
    expect(moved.history.map((h) => [h.from_stage?.name ?? null, h.to_stage.name])).toEqual([['Nuevo', 'Calificado'], [null, 'Nuevo']]);
    expect(moved.history[0]).toMatchObject({ user: { id: IDS.alice }, origin: 'manual' });
    const same = await ok<Opp>(await move(T.alice, o.id, stage(p, 'Calificado').id));
    expect(same.history).toHaveLength(2);
    expect((await audits(o.id)).map((a) => a.field)).toEqual([null, 'stage_id']);
  });

  it('a «ganada» la cierra con fecha, conserva el monto y no pide motivo; salir de ella la reabre', async () => {
    const p = await main(T.alice);
    const o = await mkOpp(T.alice, { contact_id: (await mkContact(T.alice, 'Ana')).id, amount: 2000 });
    const won = await ok<Opp>(await move(T.alice, o.id, stage(p, 'Ganado').id));
    expect(won).toMatchObject({ status: 'won', amount: '2000.00', lost_reason: null });
    expect(won.closed_at).not.toBeNull();
    const back = await ok<Opp>(await move(T.alice, o.id, stage(p, 'Propuesta').id));
    expect(back).toMatchObject({ status: 'open', closed_at: null, amount: '2000.00' });
  });

  it('a «perdida» exige el motivo; se guarda, se muestra y se borra al reabrir', async () => {
    const p = await main(T.alice);
    const lostStage = await ok<{ stages: Stage[] }>(await call('POST', `/pipelines/${p.id}/stages`, T.alice, { name: 'Perdido', kind: 'lost' }), 201);
    const perdido = lostStage.stages.find((s) => s.name === 'Perdido')!;
    const o = await mkOpp(T.alice, { contact_id: (await mkContact(T.alice, 'Ana')).id });
    const noReason = await call('POST', `/opportunities/${o.id}/move`, T.alice, { stage_id: perdido.id });
    expect(noReason.status).toBe(400);
    expect((await json<Err>(noReason)).error.details[0]).toMatchObject({ path: 'lost_reason', code: 'required' });
    expect((await move(T.alice, o.id, perdido.id, 'x'.repeat(201))).status).toBe(400);
    const lost = await ok<Opp>(await move(T.alice, o.id, perdido.id, 'No contestó más'));
    expect(lost).toMatchObject({ status: 'lost', lost_reason: 'No contestó más' });
    expect(lost.closed_at).not.toBeNull();
    const reopened = await ok<Opp>(await move(T.alice, o.id, stage(p, 'Nuevo').id));
    expect(reopened).toMatchObject({ status: 'open', lost_reason: null, closed_at: null });
    // un motivo enviado a una etapa que no es la perdida se ignora
    expect((await ok<Opp>(await move(T.alice, o.id, stage(p, 'Contactado').id, 'ignorado'))).lost_reason).toBeNull();
    expect(JSON.stringify(await audits(o.id))).not.toContain('No contestó más'); // el motivo vive en la oportunidad, no en la auditoría
  });

  it('solo a una etapa de SU pipeline y no a una oculta; reabrir con otra abierta del mismo contacto es 409', async () => {
    const p = await main(T.alice);
    const other = await ok<Pipeline>(await call('POST', '/pipelines', T.alice, { name: 'Cursos' }), 201);
    const c = await mkContact(T.alice, 'Ana');
    const o = await mkOpp(T.alice, { contact_id: c.id });
    expect((await move(T.alice, o.id, stage(other, 'Nuevo').id)).status).toBe(400);
    expect((await move(T.alice, o.id, NOBODY)).status).toBe(400);
    await ok(await call('PATCH', `/pipeline-stages/${stage(p, 'Calificado').id}`, T.alice, { is_hidden: true }));
    const hidden = await move(T.alice, o.id, stage(p, 'Calificado').id);
    expect(hidden.status).toBe(409);
    expect(await code(hidden)).toBe('STAGE_HIDDEN');
    await ok(await move(T.alice, o.id, stage(p, 'Ganado').id));
    await mkOpp(T.alice, { contact_id: c.id }); // nueva abierta del mismo contacto
    const clash = await move(T.alice, o.id, stage(p, 'Nuevo').id);
    expect(clash.status).toBe(409);
    expect(await code(clash)).toBe('OPPORTUNITY_OPEN_EXISTS');
    expect((await ok<Opp>(await call('GET', `/opportunities/${o.id}`, T.alice))).status).toBe('won'); // no cambió
  });

  it('el asesor mueve las suyas; las ajenas son 404', async () => {
    const p = await main(T.alice);
    const mine = await mkOpp(T.carol, { contact_id: (await mkContact(T.carol, 'Mía')).id });
    const hers = await mkOpp(T.erin, { contact_id: (await mkContact(T.erin, 'Suya')).id });
    expect((await move(T.carol, mine.id, stage(p, 'Contactado').id)).status).toBe(200);
    expect((await move(T.carol, hers.id, stage(p, 'Contactado').id)).status).toBe(404);
    expect((await move(T.alice, hers.id, stage(p, 'Contactado').id)).status).toBe(200);
  });
});

describe('listar, filtrar y resumir', () => {
  async function world() {
    const p = await main(T.alice);
    const tag = await ok<{ id: string }>(await call('POST', '/tags', T.alice, { name: 'VIP' }), 201);
    const ana = await mkContact(T.alice, 'Ana Torres', { email: 'ana@correo.test', tag_ids: [tag.id] });
    const beto = await mkContact(T.carol, 'Beto Luna');
    const carla = await mkContact(T.erin, 'Carla Mora');
    await admin.query(`UPDATE contacts SET source = 'meta_ctwa' WHERE id = $1`, [carla.id]);
    const a = await mkOpp(T.alice, { contact_id: ana.id, amount: 3000, owner_id: IDS.carol });
    const b = await mkOpp(T.carol, { contact_id: beto.id, amount: 500 });
    const c = await mkOpp(T.erin, { contact_id: carla.id, amount: 1200 });
    await ok(await move(T.alice, c.id, stage(p, 'Propuesta').id));
    await ok(await move(T.alice, a.id, stage(p, 'Ganado').id));
    return { p, tag, ana, beto, carla, a, b, c };
  }

  it('el asesor solo ve las suyas; el administrador, todas; ordenadas por la entrada más reciente a su etapa', async () => {
    await world();
    expect(names(await listOpps(T.alice))).toEqual(['Ana Torres', 'Carla Mora', 'Beto Luna']);
    expect(names(await listOpps(T.carol))).toEqual(['Ana Torres', 'Beto Luna']); // Ana le fue asignada
    expect(names(await listOpps(T.erin))).toEqual(['Carla Mora']);
    expect(names(await listOpps(T.alice, 'limit=1'))).toEqual(['Ana Torres']);
  });

  it('filtros: etapa, estado, responsable, texto (nombre, correo, teléfono), origen, etiqueta, valor mínimo y contacto', async () => {
    const w = await world();
    expect(names(await listOpps(T.alice, `stage=${stage(w.p, 'Propuesta').id}`))).toEqual(['Carla Mora']);
    expect(names(await listOpps(T.alice, 'status=won'))).toEqual(['Ana Torres']);
    expect(names(await listOpps(T.alice, 'status=lost'))).toEqual([]);
    expect(names(await listOpps(T.alice, 'owner=me'))).toEqual([]);
    expect(names(await listOpps(T.alice, `owner=${IDS.erin}`))).toEqual(['Carla Mora']);
    expect(names(await listOpps(T.carol, 'owner=me'))).toEqual(['Ana Torres', 'Beto Luna']);
    expect(names(await listOpps(T.carol, `owner=${IDS.erin}`))).toEqual([]); // fuera de su alcance
    expect(names(await listOpps(T.alice, 'q=luna'))).toEqual(['Beto Luna']);
    expect(names(await listOpps(T.alice, 'q=ana%40correo'))).toEqual(['Ana Torres']);
    expect(names(await listOpps(T.alice, 'q=%25'))).toEqual([]); // el comodín se toma literal
    const phone = (await ok<{ items: Array<{ phones: Array<{ e164: string }> }> }>(await call('GET', `/contacts?q=Beto`, T.alice))).items[0]!.phones[0]!.e164;
    expect(names(await listOpps(T.alice, `q=${encodeURIComponent(phone.slice(-6))}`))).toEqual(['Beto Luna']);
    expect(names(await listOpps(T.alice, 'source=meta_ctwa'))).toEqual(['Carla Mora']);
    expect(names(await listOpps(T.alice, `tag=${w.tag.id}`))).toEqual(['Ana Torres']);
    expect(names(await listOpps(T.alice, 'min=1000'))).toEqual(['Ana Torres', 'Carla Mora']);
    expect(names(await listOpps(T.alice, `contact=${w.beto.id}`))).toEqual(['Beto Luna']);
    expect(names(await listOpps(T.alice, `q=a&min=1000&stage=${stage(w.p, 'Propuesta').id}`))).toEqual(['Carla Mora']);
    for (const bad of ['status=otra', 'owner=otro', 'tag=x', 'min=-1', 'limit=0', 'cursor=basura', 'pipeline=x']) expect((await call('GET', `/opportunities?${bad}`, T.alice)).status, bad).toBe(400);
  });

  it('paginación por cursor sin repetir ni saltar; una oportunidad de un contacto borrado no sale', async () => {
    const p = await main(T.alice);
    const made: string[] = [];
    for (let i = 1; i <= 5; i++) made.push((await mkOpp(T.alice, { contact_id: (await mkContact(T.alice, `Contacto ${i}`)).id })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const page: Page = await listOpps(T.alice, `limit=2${cursor ? `&cursor=${cursor}` : ''}&stage=${stage(p, 'Nuevo').id}`);
      seen.push(...page.items.map((o) => o.id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...made].reverse());
    expect((await call('GET', '/opportunities?cursor=eyJ0Ijoibm8ifQ', T.alice)).status).toBe(400);
  });

  it('el resumen cuenta y suma por etapa con los mismos filtros y alcance', async () => {
    const w = await world();
    const sum = async (t: string, qs = '') => Object.fromEntries((await ok<{ items: Array<{ stage_id: string; count: number; total: string }> }>(await call('GET', `/pipelines/${w.p.id}/summary${qs ? `?${qs}` : ''}`, t))).items.map((i) => [i.stage_id, [i.count, i.total]]));
    expect(await sum(T.alice)).toEqual({ [stage(w.p, 'Nuevo').id]: [1, '500.00'], [stage(w.p, 'Propuesta').id]: [1, '1200.00'], [stage(w.p, 'Ganado').id]: [1, '3000.00'] });
    expect(await sum(T.carol)).toEqual({ [stage(w.p, 'Nuevo').id]: [1, '500.00'], [stage(w.p, 'Ganado').id]: [1, '3000.00'] });
    expect(await sum(T.alice, 'min=1000')).toEqual({ [stage(w.p, 'Propuesta').id]: [1, '1200.00'], [stage(w.p, 'Ganado').id]: [1, '3000.00'] });
    expect(await sum(T.alice, 'q=luna')).toEqual({ [stage(w.p, 'Nuevo').id]: [1, '500.00'] });
    expect((await call('GET', `/pipelines/${NOBODY}/summary`, T.alice)).status).toBe(404);
    expect((await call('GET', `/pipelines/${w.p.id}/summary?stage=${NOBODY}`, T.alice)).status).toBe(400); // la etapa no es un filtro del resumen
  });

  it('el listado de pipelines cuenta las oportunidades (el asesor, las suyas)', async () => {
    const w = await world();
    const asAdmin = (await pipelinesOf(T.alice))[0]!;
    expect(asAdmin.opportunity_count).toBe(3);
    expect((await pipelinesOf(T.carol))[0]!.opportunity_count).toBe(2);
    expect(w.p.id).toBe(asAdmin.id);
  });
});

describe('editar y borrar', () => {
  it('cambia el monto y el responsable con auditoría; el asesor no reasigna', async () => {
    const o = await mkOpp(T.carol, { contact_id: (await mkContact(T.carol, 'Mía')).id, amount: 100 });
    const edited = await ok<Opp>(await call('PATCH', `/opportunities/${o.id}`, T.carol, { amount: '250.5' }));
    expect(edited.amount).toBe('250.50');
    const denied = await call('PATCH', `/opportunities/${o.id}`, T.carol, { owner_id: IDS.erin });
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('OWNER_NOT_ALLOWED');
    expect((await ok<Opp>(await call('PATCH', `/opportunities/${o.id}`, T.alice, { owner_id: IDS.erin }))).owner?.id).toBe(IDS.erin);
    expect((await call('GET', `/opportunities/${o.id}`, T.carol)).status).toBe(404); // ya no es suya
    expect((await call('PATCH', `/opportunities/${o.id}`, T.alice, { owner_id: IDS.bob })).status).toBe(400);
    expect((await call('PATCH', `/opportunities/${o.id}`, T.alice, {})).status).toBe(400);
    expect((await call('PATCH', `/opportunities/${o.id}`, T.alice, { amount: -3 })).status).toBe(400);
    expect((await audits(o.id)).map((a) => a.field)).toEqual([null, 'amount', 'owner_id']);
  });

  it('borrado lógico: desaparece de listas y conteos, libera al contacto para otra abierta y deja pasar el borrado del pipeline', async () => {
    const p = await ok<Pipeline>(await call('POST', '/pipelines', T.alice, { name: 'Cursos' }), 201);
    const c = await mkContact(T.alice, 'Ana');
    const o = await mkOpp(T.alice, { contact_id: c.id, pipeline_id: p.id });
    expect((await call('DELETE', `/pipelines/${p.id}`, T.alice)).status).toBe(409);
    await ok(await call('DELETE', `/opportunities/${o.id}`, T.alice));
    expect((await call('GET', `/opportunities/${o.id}`, T.alice)).status).toBe(404);
    expect((await call('DELETE', `/opportunities/${o.id}`, T.alice)).status).toBe(404);
    expect(names(await listOpps(T.alice))).toEqual([]);
    expect((await call('POST', '/opportunities', T.alice, { contact_id: c.id, pipeline_id: p.id })).status).toBe(201);
    expect((await audits(o.id)).map((a) => a.field)).toEqual([null, 'deleted']);
  });

  it('el asesor borra las suyas y no las ajenas', async () => {
    const mine = await mkOpp(T.carol, { contact_id: (await mkContact(T.carol, 'Mía')).id });
    const hers = await mkOpp(T.erin, { contact_id: (await mkContact(T.erin, 'Suya')).id });
    expect((await call('DELETE', `/opportunities/${hers.id}`, T.carol)).status).toBe(404);
    expect((await call('DELETE', `/opportunities/${mine.id}`, T.carol)).status).toBe(200);
  });

  it('borrar un contacto borra sus oportunidades (y queda en la auditoría)', async () => {
    const p = await main(T.alice);
    const c = await mkContact(T.alice, 'Ana');
    const o = await mkOpp(T.alice, { contact_id: c.id });
    expect((await pipelinesOf(T.alice))[0]!.opportunity_count).toBe(1);
    await ok(await call('DELETE', `/contacts/${c.id}`, T.alice));
    expect((await call('GET', `/opportunities/${o.id}`, T.alice)).status).toBe(404);
    expect((await pipelinesOf(T.alice))[0]!.opportunity_count).toBe(0);
    expect((await audits(o.id)).at(-1)!.new_value).toEqual({ deleted: true, reason: 'contact_deleted' });
    expect((await call('DELETE', `/pipeline-stages/${stage(p, 'Nuevo').id}`, T.alice)).status).toBe(200); // ya no bloquea
  });

  it('eliminar una etapa abierta mueve sus oportunidades a la anterior y el historial lo registra con origen «system»', async () => {
    const p = await main(T.alice);
    const o = await mkOpp(T.alice, { contact_id: (await mkContact(T.alice, 'Ana')).id });
    await ok(await move(T.alice, o.id, stage(p, 'Calificado').id));
    await ok(await call('DELETE', `/pipeline-stages/${stage(p, 'Calificado').id}`, T.alice));
    const now = await ok<Opp>(await call('GET', `/opportunities/${o.id}`, T.alice));
    expect(now.stage_id).toBe(stage(p, 'Contactado').id);
    expect(now.history[0]).toMatchObject({ from_stage: { name: 'Calificado' }, to_stage: { name: 'Contactado' }, origin: 'system' });
  });
});

describe('aislamiento A↔B', () => {
  it('B no ve, cambia ni mueve las oportunidades de A (404); no puede usar contactos, pipelines ni etapas de A', async () => {
    const p = await main(T.alice);
    const o = await mkOpp(T.alice, { contact_id: (await mkContact(T.alice, 'Ana')).id, amount: 900 });
    const bp = await main(T.bob);
    expect((await listOpps(T.bob)).items).toEqual([]);
    for (const [m, path, b] of [
      ['GET', `/opportunities/${o.id}`], ['PATCH', `/opportunities/${o.id}`, { amount: 1 }], ['DELETE', `/opportunities/${o.id}`], ['POST', `/opportunities/${o.id}/move`, { stage_id: bp.stages[1]!.id }], ['GET', `/pipelines/${p.id}/summary`],
    ] as const) {
      expect((await call(m, path, T.bob, b)).status, `${m} ${path}`).toBe(404);
    }
    const bContact = await mkContact(T.bob, 'De B');
    expect((await call('POST', '/opportunities', T.bob, { contact_id: o.contact.id })).status).toBe(404); // contacto de A
    expect((await call('POST', '/opportunities', T.bob, { contact_id: bContact.id, pipeline_id: p.id })).status).toBe(400); // pipeline de A
    expect((await call('POST', '/opportunities', T.bob, { contact_id: bContact.id, stage_id: stage(p, 'Nuevo').id })).status).toBe(400); // etapa de A
    const bo = await mkOpp(T.bob, { contact_id: bContact.id });
    expect((await move(T.bob, bo.id, stage(p, 'Contactado').id)).status).toBe(400); // etapa de A
    // nada de A cambió
    expect(await ok<Opp>(await call('GET', `/opportunities/${o.id}`, T.alice))).toMatchObject({ amount: '900.00', status: 'open' });
    expect((await pipelinesOf(T.alice))[0]!.opportunity_count).toBe(1);
  });
});
