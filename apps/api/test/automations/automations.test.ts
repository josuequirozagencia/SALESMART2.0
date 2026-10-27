// M9.3 — Automatizaciones (ADR-54; F20): administración y motor. Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/automations
//   POST /v1/automations
//   GET /v1/automations/:id
//   PATCH /v1/automations/:id
//   POST /v1/automations/:id/activate
//   POST /v1/automations/:id/pause
//   POST /v1/automations/:id/test
//   GET /v1/automations/settings
//   PUT /v1/automations/settings
//   GET /v1/automations/:id/runs
//   DELETE /v1/automations/:id
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ConversationsService } from '../../src/modules/conversations';
import { DomainEventBus } from '../../src/modules/events';
import { AutomationsJob, AutomationsModule } from '../../src/modules/automations';
import { AutomationActionsService } from '../../src/modules/automations/automation-actions.service';
import { MAX_AUTOMATIONS, MAX_DEPTH, MAX_RUNS_PER_CONTACT_HOUR } from '../../src/modules/automations/automation-model';
import { FakeOutboundHttp, OUTBOUND_HTTP, OutboundError } from '../../src/modules/automations/outbound-http';
import { ChannelsModule } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { InboxModule } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { PipelinesModule } from '../../src/modules/pipelines';
import { QueuesModule } from '../../src/modules/queues';
import { TagsModule } from '../../src/modules/tags';
import { TemplatesModule } from '../../src/modules/templates';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({
  imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, PipelinesModule, OpportunitiesModule, QueuesModule, TagsModule, ChannelsModule, TemplatesModule, InboxModule, AutomationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })],
})
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const GHOST = '00000000-0000-4000-8000-00000000dead';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE automation_settings, automation_run_steps, automation_runs, automations, message_templates, response_timers, messages, conversation_participants, conversations, webhook_events, whatsapp_accounts, channel_routes, channel_accounts, tasks, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, custom_field_values, custom_field_definitions, contact_phones, contacts, queue_members, queue_distribution_state, queues, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

type Row = Record<string, unknown>;
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

interface Rule { id: string; name: string; status: string; version: number; trigger: { type: string; filter: Record<string, unknown> }; conditions: unknown[]; actions: Array<Record<string, unknown>>; recent: Record<string, number> }
interface RunStep { position: number; action: string; outcome: string; detail: string | null }
interface Run { id: string; status: string; reason: string | null; event_type: string; depth: number; contact: { id: string; name: string }; steps: RunStep[] }

const body = (name: string, trigger: Record<string, unknown>, actions: unknown[], conditions: unknown[] = []) => ({ name, trigger, conditions, actions });
const mk = async (token: string, b: unknown): Promise<Rule> => {
  const r = await call('POST', '/automations', token, b);
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  return json<Rule>(r);
};
const activate = async (token: string, id: string): Promise<Rule> => {
  const r = await call('POST', `/automations/${id}/activate`, token);
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
  return json<Rule>(r);
};
/** Crea la regla y la deja activa. */
const live = async (token: string, b: unknown): Promise<Rule> => activate(token, (await mk(token, b)).id);
const runsOf = async (token: string, id: string): Promise<Run[]> => (await json<{ items: Run[] }>(await call('GET', `/automations/${id}/runs?limit=100`, token))).items;
const mkContact = async (token: string, name = 'Lucía Paredes', extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await call('POST', '/contacts', token, { name, ...extra });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  return (await json<{ id: string }>(r)).id;
};
const mkTag = async (token: string, name: string): Promise<string> => (await json<{ id: string }>(await call('POST', '/tags', token, { name }))).id;
const mkField = async (token: string, name: string): Promise<string> => {
  const r = await call('POST', '/custom-fields', token, { name, type: 'text' });
  expect(r.status).toBe(201);
  return (await json<{ key: string }>(r)).key;
};
const queueOf = async (token: string, name = 'Ventas'): Promise<string> => (await json<{ id: string }>(await call('POST', '/queues', token, { name }))).id;
const tagNames = async (contact: string) => (await admin.query(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1 ORDER BY t.name`, [contact])).rows.map((r) => r.name as string);
const tasksOf = async () => (await admin.query(`SELECT * FROM tasks ORDER BY created_at`)).rows as Row[];
const dbRuns = async () => (await admin.query(`SELECT * FROM automation_runs ORDER BY created_at, id`)).rows as Row[];
const pipelineWithStages = async (org = ORG_A): Promise<{ pipeline: string; open1: string; open2: string; won: string; hidden: string }> => {
  const pipeline = (await admin.query(`INSERT INTO pipelines(id, organization_id, name, position) VALUES (gen_random_uuid(), $1, 'Ventas', 0) RETURNING id`, [org])).rows[0].id as string;
  const st = async (name: string, kind: string, pos: number, hidden = false) => (await admin.query(`INSERT INTO pipeline_stages(id, organization_id, pipeline_id, name, kind, position, is_hidden) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING id`, [org, pipeline, name, kind, pos, hidden])).rows[0].id as string;
  return { pipeline, open1: await st('Nuevo', 'open', 0), open2: await st('Interesado', 'open', 1), won: await st('Ganada', 'won', 2), hidden: await st('Oculta', 'open', 3, true) };
};
const mkOpp = async (contact: string, pipeline: string, stage: string, org = ORG_A): Promise<string> =>
  (await admin.query(`INSERT INTO opportunities(id, organization_id, pipeline_id, stage_id, contact_id, amount, status) VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, 'open') RETURNING id`, [org, pipeline, stage, contact])).rows[0].id as string;

/** Corre el motor hasta que no quede nada por resolver (las reglas pueden encadenarse). */
async function drain(now: () => Date = () => new Date()): Promise<number> {
  const job = app.get(AutomationsJob, { strict: false });
  let total = 0;
  for (let i = 0; i < 15; i += 1) {
    const n = await job.run(now());
    total += n;
    if (n === 0) break;
  }
  return total;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER', 'HTTP_OUT_PROVIDER', 'CAPI_PROVIDER', 'WHATSAPP_PROVIDER', 'PROVIDER_CREDENTIALS_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: process.env['TEST_LOG'] ?? 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AI_PROVIDER: 'fake', HTTP_OUT_PROVIDER: 'fake', CAPI_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: randomBytes(32).toString('base64') });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => {
  await app.close();
  await admin.end();
  process.env = saved;
});
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
});
afterEach(() => vi.restoreAllMocks());

// ═══════════════════════════════════════════════════════════════════════════ administración

describe('administración de automatizaciones', () => {
  const TAG_RULE = (tag: string) => body('Etiquetar nuevos', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]);

  it('sin sesión 401; un asesor no administra automatizaciones (403); lo de A no se mezcla con lo de B (404)', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    const r = await mk(T.alice, TAG_RULE(tag));
    const routes: Array<[string, string, unknown?]> = [['GET', '/automations'], ['POST', '/automations', TAG_RULE(tag)], ['GET', `/automations/${r.id}`], ['PATCH', `/automations/${r.id}`, { name: 'Y' }], ['POST', `/automations/${r.id}/activate`], ['POST', `/automations/${r.id}/pause`], ['GET', `/automations/${r.id}/runs`], ['DELETE', `/automations/${r.id}`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
    for (const [m, p, b] of routes.filter(([, p]) => p.includes(r.id))) expect((await call(m, p, T.bob, b)).status, `${m} ${p} de otra empresa`).toBe(404);
    expect((await json<{ items: Rule[] }>(await call('GET', '/automations', T.bob))).items).toEqual([]);
    expect((await json<{ items: Rule[] }>(await call('GET', '/automations', T.alice))).items.map((x) => x.name)).toEqual(['Etiquetar nuevos']);
    expect((await call('GET', '/automations/no-es-uuid', T.alice)).status).toBe(400);
  });

  it('valida la forma de forma estricta: disparador, filtros, condiciones y acciones', async () => {
    const bad = async (b: unknown) => expect((await call('POST', '/automations', T.alice, b)).status).toBe(400);
    const tag = await mkTag(T.alice, 'Nuevo');
    await bad(body('', { type: 'contact_created', filter: {} }, []));
    await bad(body('X', { type: 'no_existe', filter: {} }, []));
    await bad(body('X', { type: 'contact_created', filter: { canal: 'x' } }, []));
    await bad(body('X', { type: 'field_changed', filter: {} }, []));
    await bad(body('X', { type: 'contact_created', filter: {} }, [{ type: 'http_request', url: 'https://x.test' }]));
    await bad(body('X', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: 'x' }]));
    await bad(body('X', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag, extra: 1 }]));
    await bad(body('X', { type: 'contact_created', filter: {} }, [], [{ field: 'source', op: 'contains', value: 'x' }]));
    await bad(body('X', { type: 'contact_created', filter: {} }, Array(11).fill({ type: 'add_tag', tag_id: tag })));
    await bad({ ...body('X', { type: 'contact_created', filter: {} }, []), otro: 1 });
    expect((await call('PATCH', '/automations/' + GHOST, T.alice, {})).status).toBe(400); // nada que cambiar
  });

  it('valida que lo que nombra exista en ESTA empresa y encaje (etapas, colas, etiquetas, personas, campos, conexiones)', async () => {
    const mine = await pipelineWithStages();
    const theirs = await pipelineWithStages(ORG_B);
    const tagA = await mkTag(T.alice, 'Mía');
    const tagB = await mkTag(T.bob, 'De B');
    const queueB = await queueOf(T.bob);
    const sys = (await admin.query(`SELECT id FROM tags WHERE system_key = 'lead' AND organization_id = $1`, [ORG_A])).rows[0].id as string;
    await mkField(T.alice, 'Servicio');
    const t = { type: 'contact_created', filter: {} };
    const bad = async (label: string, b: unknown) => expect((await call('POST', '/automations', T.alice, b)).status, label).toBe(400);
    await bad('etiqueta de B', body('r1', t, [{ type: 'add_tag', tag_id: tagB }]));
    await bad('etiqueta inexistente', body('r2', t, [{ type: 'add_tag', tag_id: GHOST }]));
    await bad('etiqueta del sistema', body('r3', t, [{ type: 'add_tag', tag_id: sys }]));
    await bad('etapa de B', body('r4', t, [{ type: 'move_stage', stage_id: theirs.open1 }]));
    await bad('etapa ganada', body('r5', t, [{ type: 'move_stage', stage_id: mine.won }]));
    await bad('etapa oculta', body('r6', t, [{ type: 'move_stage', stage_id: mine.hidden }]));
    await bad('cola de B', body('r7', t, [{ type: 'assign_queue', queue_id: queueB }]));
    await bad('persona de B', body('r8', t, [{ type: 'assign_user', user_id: IDS.bob }]));
    await bad('campo inexistente', body('r9', t, [{ type: 'set_field', field: 'no_existe', value: 'x' }]));
    await bad('conexión inexistente', body('r10', t, [{ type: 'send_template', channel_id: GHOST, template_id: GHOST, params: {} }]));
    await bad('tarea para persona de B', body('r11', t, [{ type: 'create_task', title: 'x', assignee: IDS.bob }]));
    await bad('filtro: pipeline de B', body('r12', { type: 'opportunity_created', filter: { pipeline_id: theirs.pipeline } }, []));
    await bad('filtro: etapa de otro pipeline', body('r13', { type: 'stage_changed', filter: { pipeline_id: mine.pipeline, to_stage_id: theirs.open1 } }, []));
    await bad('filtro: campo inexistente', body('r14', { type: 'field_changed', filter: { field: 'no_existe' } }, []));
    await bad('filtro: conexión inexistente', body('r15', { type: 'message_received', filter: { channel_id: GHOST } }, []));
    await bad('condición: campo inexistente', body('r16', t, [], [{ field: 'custom:no_existe', op: 'is_empty' }]));
    await bad('condición: etiqueta de B', body('r17', t, [], [{ field: 'tag', op: 'has', value: tagB }]));
    // las válidas pasan (también una condición con etiqueta del sistema)
    expect((await call('POST', '/automations', T.alice, body('ok1', t, [{ type: 'add_tag', tag_id: tagA }, { type: 'move_stage', stage_id: mine.open2 }, { type: 'assign_user', user_id: IDS.carol }, { type: 'set_field', field: 'servicio', value: 'corte' }], [{ field: 'tag', op: 'not_has', value: sys }]))).status).toBe(201);
  });

  it('ciclo de vida: borrador → activa → en pausa; versión, nombre único, límite y borrado lógico', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    const r = await mk(T.alice, TAG_RULE(tag));
    expect(r).toMatchObject({ status: 'draft', version: 1, recent: { done: 0, skipped: 0, failed: 0, queued: 0 } });
    expect((await call('POST', `/automations/${r.id}/pause`, T.alice)).status).toBe(409); // no está activa
    // activar exige al menos una acción
    const empty = await mk(T.alice, body('Vacía', { type: 'contact_created', filter: {} }, []));
    expect((await call('POST', `/automations/${empty.id}/activate`, T.alice)).status).toBe(400);
    const on = await activate(T.alice, r.id);
    expect(on.status).toBe('active');
    expect((await activate(T.alice, r.id)).status).toBe('active'); // idempotente
    // cambiar nombre no sube la versión; cambiar la definición sí
    const renamed = await json<Rule>(await call('PATCH', `/automations/${r.id}`, T.alice, { name: 'Otro nombre', description: 'Para nuevos' }));
    expect(renamed).toMatchObject({ name: 'Otro nombre', version: 1, status: 'active' });
    const edited = await json<Rule>(await call('PATCH', `/automations/${r.id}`, T.alice, { trigger: { type: 'sale_created', filter: {} } }));
    expect(edited).toMatchObject({ version: 2, trigger: { type: 'sale_created' } });
    // una activa no puede quedarse sin acciones
    expect((await call('PATCH', `/automations/${r.id}`, T.alice, { actions: [] })).status).toBe(400);
    expect((await json<Rule>(await call('POST', `/automations/${r.id}/pause`, T.alice))).status).toBe('paused');
    expect((await call('PATCH', `/automations/${r.id}`, T.alice, { actions: [] })).status).toBe(200); // en pausa sí
    // nombre único (sin distinguir mayúsculas), también al renombrar
    expect((await call('POST', '/automations', T.alice, body('OTRO NOMBRE', { type: 'contact_created', filter: {} }, []))).status).toBe(409);
    const second = await mk(T.alice, body('Segunda', { type: 'contact_created', filter: {} }, []));
    expect((await call('PATCH', `/automations/${second.id}`, T.alice, { name: 'otro nombre' })).status).toBe(409);
    // borrado lógico: ya no se ve y libera el nombre
    expect((await call('DELETE', `/automations/${r.id}`, T.alice)).status).toBe(200);
    expect((await call('GET', `/automations/${r.id}`, T.alice)).status).toBe(404);
    expect((await call('DELETE', `/automations/${r.id}`, T.alice)).status).toBe(404);
    expect((await call('POST', '/automations', T.alice, body('Otro nombre', { type: 'contact_created', filter: {} }, []))).status).toBe(201);
    // todo quedó auditado
    const audit = (await admin.query(`SELECT field FROM audit_logs WHERE entity_type = 'automation' AND entity_id = $1 ORDER BY at`, [r.id])).rows.map((x) => x.field);
    expect(audit).toEqual(expect.arrayContaining([null, 'status', 'name', 'trigger', 'actions']));
  });

  it('máximo de automatizaciones por empresa', async () => {
    for (let i = 0; i < MAX_AUTOMATIONS; i += 1) await admin.query(`INSERT INTO automations(id, organization_id, name, trigger_type) VALUES (gen_random_uuid(), $1, $2, 'contact_created')`, [ORG_A, `Regla ${i}`]);
    const r = await call('POST', '/automations', T.alice, body('Una más', { type: 'contact_created', filter: {} }, []));
    expect(r.status).toBe(409);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('AUTOMATION_LIMIT');
    expect((await call('POST', '/automations', T.bob, body('Una más', { type: 'contact_created', filter: {} }, []))).status).toBe(201); // el tope es por empresa
  });
});

// ═══════════════════════════════════════════════════════════════════════════ motor

describe('motor: disparadores, condiciones y acciones', () => {
  it('un contacto nuevo dispara la regla activa: queda una ejecución con sus pasos, hace lo pedido y no se repite', async () => {
    const tag = await mkTag(T.alice, 'Bienvenida');
    const r = await live(T.alice, body('Etiquetar', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const c = await mkContact(T.alice);
    // nace en cola, junto con el contacto
    expect(await dbRuns()).toHaveLength(1);
    expect((await runsOf(T.alice, r.id))[0]).toMatchObject({ status: 'queued', event_type: 'contact_created', depth: 0, contact: { id: c, name: 'Lucía Paredes' } });
    expect(await tagNames(c)).toEqual([]);
    expect(await drain()).toBe(1);
    expect(await tagNames(c)).toEqual(['Bienvenida']);
    const [run] = await runsOf(T.alice, r.id);
    expect(run).toMatchObject({ status: 'done', reason: null });
    expect(run!.steps).toEqual([{ position: 1, action: 'add_tag', label: 'Poner una etiqueta', outcome: 'done', detail: 'Etiqueta «Bienvenida» puesta' }]);
    expect((await json<Rule>(await call('GET', `/automations/${r.id}`, T.alice))).recent).toEqual({ done: 1, skipped: 0, failed: 0, queued: 0, waiting: 0 });
    // volver a correr el motor no repite nada
    expect(await drain()).toBe(0);
    expect(await dbRuns()).toHaveLength(1);
    // la acción quedó auditada como automática
    expect((await admin.query(`SELECT source FROM audit_logs WHERE entity_type = 'contact' AND entity_id = $1 AND field = 'tags'`, [c])).rows).toEqual([{ source: 'automation' }]);
  });

  it('las que no están activas no reaccionan; las condiciones deciden al ocurrir el hecho y lo que no aplica no deja rastro', async () => {
    const tag = await mkTag(T.alice, 'Corte');
    const act = [{ type: 'add_tag', tag_id: tag }];
    await mkField(T.alice, 'Servicio');
    const draft = await mk(T.alice, body('Borrador', { type: 'contact_created', filter: {} }, act));
    const only = await live(T.alice, body('Solo VIP', { type: 'contact_created', filter: {} }, act, [{ field: 'custom:servicio', op: 'eq', value: 'vip' }]));
    const paused = await live(T.alice, body('Pausada', { type: 'contact_created', filter: {} }, act));
    await call('POST', `/automations/${paused.id}/pause`, T.alice);
    await mkContact(T.alice, 'Sin servicio');
    const vip = await mkContact(T.alice, 'Con servicio', { custom_fields: { servicio: 'VIP' } });
    await drain();
    expect(await runsOf(T.alice, draft.id)).toEqual([]);
    expect(await runsOf(T.alice, paused.id)).toEqual([]);
    const runs = await runsOf(T.alice, only.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'done', contact: { id: vip } });
  });

  it('si la regla se pausa o se borra después del hecho y antes de ejecutarse, la ejecución se descarta', async () => {
    const tag = await mkTag(T.alice, 'X');
    const r = await live(T.alice, body('Etiquetar', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const c = await mkContact(T.alice);
    await call('POST', `/automations/${r.id}/pause`, T.alice);
    await drain();
    expect((await runsOf(T.alice, r.id))[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('pausó') });
    expect(await tagNames(c)).toEqual([]);
    // contacto borrado antes de ejecutarse
    const r2 = await live(T.alice, body('Otra', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const c2 = await mkContact(T.alice, 'Se borra');
    expect((await call('DELETE', `/contacts/${c2}`, T.alice)).status).toBe(200);
    await drain();
    expect((await runsOf(T.alice, r2.id))[0]).toMatchObject({ status: 'skipped', reason: 'El contacto ya no existe' });
  });

  it('acciones de campos, etiquetas y tareas; cada paso se anota y uno que no se puede hacer no detiene a los demás', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    await mkField(T.alice, 'Servicio');
    const r = await live(
      T.alice,
      body('Combo', { type: 'contact_created', filter: {} }, [
        { type: 'set_field', field: 'servicio', value: 'corte' },
        { type: 'add_tag', tag_id: tag },
        { type: 'add_tag', tag_id: tag }, // ya la tiene → omitida
        { type: 'create_task', title: 'Llamar a {{primer_nombre}}', due_in_hours: 2 },
        { type: 'remove_tag', tag_id: tag },
      ]),
    );
    const c = await mkContact(T.alice, 'Lucía Paredes', { owner_id: IDS.carol });
    await drain();
    const [run] = await runsOf(T.alice, r.id);
    expect(run!.status).toBe('done');
    expect(run!.steps.map((s) => [s.action, s.outcome])).toEqual([['set_field', 'done'], ['add_tag', 'done'], ['add_tag', 'skipped'], ['create_task', 'done'], ['remove_tag', 'done']]);
    expect(await tagNames(c)).toEqual([]);
    const [task] = await tasksOf();
    expect(task).toMatchObject({ title: 'Llamar a Lucía', assignee_id: IDS.carol, contact_id: c, status: 'open' });
    expect(new Date(task!['due_at'] as string).getTime() - Date.now()).toBeGreaterThan(110 * 60_000);
    const got = await json<{ custom_fields: Record<string, unknown> }>(await call('GET', `/contacts/${c}`, T.alice));
    expect(got.custom_fields['servicio']).toBe('corte');
    expect((await admin.query(`SELECT source FROM audit_logs WHERE entity_type = 'contact' AND entity_id = $1 AND field = 'custom.servicio'`, [c])).rows).toEqual([{ source: 'automation' }]);
  });

  it('crear una tarea para «el responsable» sin responsable se omite con su motivo; un campo que ya no existe falla solo ese paso', async () => {
    await mkField(T.alice, 'Servicio');
    const r = await live(T.alice, body('Tareas', { type: 'contact_created', filter: {} }, [{ type: 'create_task', title: 'Seguir' }, { type: 'set_field', field: 'servicio', value: 'x' }]));
    await mkContact(T.alice, 'Sin dueño', { owner_id: null });
    // el campo se archiva antes de ejecutar → ese paso falla, el run queda «failed» y la tarea se omitió
    const field = (await json<{ items: Array<{ id: string; key: string }> }>(await call('GET', '/custom-fields', T.alice))).items.find((f) => f.key === 'servicio')!;
    expect((await call('POST', `/custom-fields/${field.id}/archive`, T.alice)).status).toBe(200);
    await drain();
    const [run] = await runsOf(T.alice, r.id);
    expect(run!.steps[0]).toMatchObject({ action: 'create_task', outcome: 'skipped', detail: expect.stringContaining('no tiene responsable') });
    expect(run!.steps[1]).toMatchObject({ action: 'set_field', outcome: 'failed' });
    expect(run).toMatchObject({ status: 'failed', reason: '1 acción falló' });
    expect(await tasksOf()).toEqual([]);
  });

  it('asignar a una persona cambia el responsable del contacto y de sus oportunidades abiertas; si la persona ya no puede recibir trabajo, el paso falla', async () => {
    const p = await pipelineWithStages();
    const r = await live(T.alice, body('Asignar', { type: 'contact_created', filter: {} }, [{ type: 'assign_user', user_id: IDS.carol }]));
    const c = await mkContact(T.alice, 'Para Carolina', { owner_id: IDS.alice });
    const opp = await mkOpp(c, p.pipeline, p.open1);
    await admin.query(`UPDATE opportunities SET owner_id = $1 WHERE id = $2`, [IDS.alice, opp]);
    await drain();
    expect((await admin.query(`SELECT owner_id FROM contacts WHERE id = $1`, [c])).rows[0].owner_id).toBe(IDS.carol);
    expect((await admin.query(`SELECT owner_id FROM opportunities WHERE id = $1`, [opp])).rows[0].owner_id).toBe(IDS.carol);
    expect((await runsOf(T.alice, r.id))[0]!.steps[0]).toMatchObject({ outcome: 'done' });
    // otra vez al mismo responsable: omitida
    const c2 = await mkContact(T.alice, 'Ya era suya', { owner_id: IDS.carol });
    await drain();
    expect((await runsOf(T.alice, r.id)).find((x) => x.contact.id === c2)!.steps[0]).toMatchObject({ outcome: 'skipped' });
    // Carolina deja el equipo antes de que corra la siguiente ejecución
    const c3 = await mkContact(T.alice, 'Llega tarde');
    await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1`, [IDS.carol]);
    app.get(OrgDirectoryService).invalidate();
    await drain();
    const late = (await runsOf(T.alice, r.id)).find((x) => x.contact.id === c3)!;
    expect(late.status).toBe('failed');
    expect(late.steps[0]).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('ya no puede recibir trabajo') });
  });

  it('mover de etapa: mueve la oportunidad abierta del pipeline, deja historial «automation» y se omite si no hay oportunidad o ya estaba ahí', async () => {
    const p = await pipelineWithStages();
    const r = await live(T.alice, body('Mover', { type: 'contact_created', filter: {} }, [{ type: 'move_stage', stage_id: p.open2 }]));
    const withOpp = await mkContact(T.alice, 'Con oportunidad');
    const noOpp = await mkContact(T.alice, 'Sin oportunidad');
    const opp = await mkOpp(withOpp, p.pipeline, p.open1);
    await drain();
    expect((await admin.query(`SELECT stage_id, status FROM opportunities WHERE id = $1`, [opp])).rows[0]).toEqual({ stage_id: p.open2, status: 'open' });
    expect((await admin.query(`SELECT from_stage_id, to_stage_id, origin FROM stage_history WHERE opportunity_id = $1`, [opp])).rows).toEqual([{ from_stage_id: p.open1, to_stage_id: p.open2, origin: 'automation' }]);
    expect((await admin.query(`SELECT source FROM audit_logs WHERE entity_type = 'opportunity' AND entity_id = $1`, [opp])).rows).toEqual([{ source: 'automation' }]);
    const runs = await runsOf(T.alice, r.id);
    expect(runs.find((x) => x.contact.id === noOpp)!.steps[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('no tiene una oportunidad abierta') });
    // la etapa se oculta después: el paso falla (no se mueve a una etapa que ya no recibe oportunidades)
    const again = await mkContact(T.alice, 'Otra');
    const opp2 = await mkOpp(again, p.pipeline, p.open1);
    await admin.query(`UPDATE pipeline_stages SET is_hidden = true WHERE id = $1`, [p.open2]);
    await drain();
    expect((await runsOf(T.alice, r.id)).find((x) => x.contact.id === again)!.steps[0]).toMatchObject({ outcome: 'failed' });
    expect((await admin.query(`SELECT stage_id FROM opportunities WHERE id = $1`, [opp2])).rows[0].stage_id).toBe(p.open1);
  });

  it('un cambio de etapa dispara otra regla (la oportunidad movida por una persona o por el sistema)', async () => {
    const p = await pipelineWithStages();
    const tag = await mkTag(T.alice, 'Interesado');
    const r = await live(T.alice, body('Al interesarse', { type: 'stage_changed', filter: { pipeline_id: p.pipeline, to_stage_id: p.open2 } }, [{ type: 'add_tag', tag_id: tag }]));
    const c = await mkContact(T.alice);
    const opp = await mkOpp(c, p.pipeline, p.open1);
    expect((await call('POST', `/opportunities/${opp}/move`, T.alice, { stage_id: p.open2 })).status).toBe(200);
    await drain();
    expect(await tagNames(c)).toEqual(['Interesado']);
    expect((await runsOf(T.alice, r.id))[0]).toMatchObject({ status: 'done', event_type: 'stage_changed' });
    // moverla a otra etapa no la dispara
    expect((await call('POST', `/opportunities/${opp}/move`, T.alice, { stage_id: p.open1 })).status).toBe(200);
    await drain();
    expect(await runsOf(T.alice, r.id)).toHaveLength(1);
  });

  it('cambiar un campo del contacto dispara la regla del campo (y del valor, si se pidió)', async () => {
    const tag = await mkTag(T.alice, 'Quiere barba');
    await mkField(T.alice, 'Servicio');
    const r = await live(T.alice, body('Barba', { type: 'field_changed', filter: { field: 'servicio', value: 'barba' } }, [{ type: 'add_tag', tag_id: tag }]));
    const c = await mkContact(T.alice);
    expect((await call('PATCH', `/contacts/${c}`, T.alice, { custom_fields: { servicio: 'corte' } })).status).toBe(200);
    await drain();
    expect(await runsOf(T.alice, r.id)).toEqual([]);
    expect((await call('PATCH', `/contacts/${c}`, T.alice, { custom_fields: { servicio: 'Barba' } })).status).toBe(200);
    await drain();
    expect(await tagNames(c)).toEqual(['Quiere barba']);
    expect(await runsOf(T.alice, r.id)).toHaveLength(1);
  });

  it('un mensaje del cliente dispara la regla; enviar un texto solo se puede dentro de la ventana de 24 h y sale como mensaje automático', async () => {
    const ch = (await json<{ id: string }>(await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN }))).id;
    const r = await live(T.alice, body('Responder', { type: 'message_received', filter: { channel_id: ch } }, [{ type: 'send_text', text: 'Hola {{primer_nombre}}, enseguida te atendemos' }]));
    const conversations = app.get(ConversationsService, { strict: false });
    const db = app.get(Database, { strict: false });
    const inbound = (id: string, from: string, name: string) =>
      TenantContext.run({ organizationId: ORG_A }, () =>
        db.withTenant((tx) => conversations.ingestInbound(tx, ch, { externalId: id, from, fromRaw: from.slice(1), profileName: name, kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date() }, { now: new Date(), timeZone: 'UTC', assignable: new Set<string>() })),
      );
    await inbound('wamid.1', '+593984217730', 'Marta Lema');
    await drain();
    const msgs = (await admin.query(`SELECT direction, sender_type, kind, body, status FROM messages WHERE direction = 'out'`)).rows;
    expect(msgs).toEqual([{ direction: 'out', sender_type: 'automation', kind: 'text', body: 'Hola Marta, enseguida te atendemos', status: 'queued' }]);
    expect((await runsOf(T.alice, r.id))[0]).toMatchObject({ status: 'done', event_type: 'message_received' });
    // la ventana se cerró (el último mensaje del cliente fue hace más de 24 h): no se puede escribir libremente
    await inbound('wamid.2', '+593984217731', 'Otro Cliente');
    await admin.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE peer_id = '593984217731'`);
    await drain();
    const old = (await runsOf(T.alice, r.id)).find((x) => x.contact.name === 'Otro Cliente')!;
    expect(old.steps[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('24 h') });
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages WHERE direction = 'out'`)).rows[0].n).toBe(1);
    // un contacto que revocó su consentimiento tampoco recibe mensajes automáticos
    await inbound('wamid.3', '+593984217732', 'Revocó');
    await admin.query(`UPDATE contacts SET consent = 'revoked' WHERE name = 'Revocó'`);
    await drain();
    expect((await runsOf(T.alice, r.id)).find((x) => x.contact.name === 'Revocó')!.steps[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('consentimiento') });
  });

  it('enviar un texto a un contacto sin conversación abierta se omite sin abrir ninguna', async () => {
    const r = await live(T.alice, body('Saludar', { type: 'contact_created', filter: {} }, [{ type: 'send_text', text: 'Hola' }]));
    await mkContact(T.alice);
    await drain();
    expect((await runsOf(T.alice, r.id))[0]!.steps[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('conversación') });
    expect((await admin.query(`SELECT count(*)::int AS n FROM conversations`)).rows[0].n).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════ defensas

describe('defensas: ciclos, profundidad, tope por hora, atomicidad y fallos', () => {
  it('dos reglas que se disparan entre sí no se ciclan: la que ya participó en la cadena se omite y queda registrado', async () => {
    await mkField(T.alice, 'Servicio');
    await mkField(T.alice, 'Estado');
    const a = await live(T.alice, body('A: servicio → estado', { type: 'field_changed', filter: { field: 'servicio' } }, [{ type: 'set_field', field: 'estado', value: 'a' }]));
    const b = await live(T.alice, body('B: estado → servicio', { type: 'field_changed', filter: { field: 'estado' } }, [{ type: 'set_field', field: 'servicio', value: 'b' }]));
    const c = await mkContact(T.alice);
    expect((await call('PATCH', `/contacts/${c}`, T.alice, { custom_fields: { servicio: 'z' } })).status).toBe(200);
    await drain();
    const ra = await runsOf(T.alice, a.id);
    const rb = await runsOf(T.alice, b.id);
    // A (por la persona) → B (por A) → A de nuevo (por B) se omite por ciclo
    expect(ra.map((x) => [x.status, x.depth]).sort()).toEqual([['done', 0], ['skipped', 2]]);
    expect(ra.find((x) => x.status === 'skipped')!.reason).toMatch(/Ciclo/);
    expect(rb.map((x) => [x.status, x.depth])).toEqual([['done', 1]]);
    // y todo terminó: no quedan ejecuciones en cola
    expect((await dbRuns()).filter((x) => x.status === 'queued')).toEqual([]);
    expect((await dbRuns()).find((x) => x.status === 'skipped')!['cause_run_id']).toBe((await dbRuns()).find((x) => x.automation_id === b.id)!['id']);
  });

  it(`una cadena de reglas no pasa de ${MAX_DEPTH} niveles de profundidad`, async () => {
    const keys: string[] = [];
    for (let i = 0; i <= MAX_DEPTH + 2; i += 1) keys.push(await mkField(T.alice, `Paso ${i}`));
    const rules: Rule[] = [];
    for (let i = 0; i <= MAX_DEPTH + 1; i += 1) rules.push(await live(T.alice, body(`Regla ${i}`, { type: 'field_changed', filter: { field: keys[i] } }, [{ type: 'set_field', field: keys[i + 1], value: String(i) }])));
    const c = await mkContact(T.alice);
    expect((await call('PATCH', `/contacts/${c}`, T.alice, { custom_fields: { [keys[0]!]: 'inicio' } })).status).toBe(200);
    await drain();
    const all = await dbRuns();
    const byDepth = (d: number) => all.filter((x) => x.depth === d);
    for (let d = 0; d <= MAX_DEPTH; d += 1) expect(byDepth(d), `profundidad ${d}`).toHaveLength(1);
    expect(all.filter((x) => x.status === 'done')).toHaveLength(MAX_DEPTH + 1);
    const over = all.find((x) => x.depth === MAX_DEPTH + 1)!;
    expect(over).toMatchObject({ status: 'skipped' });
    expect(String(over['reason'])).toContain('máximo');
    expect(all.filter((x) => x.status === 'queued')).toEqual([]);
    expect(rules).toHaveLength(MAX_DEPTH + 2);
  });

  it(`una regla ejecuta a lo sumo ${MAX_RUNS_PER_CONTACT_HOUR} veces por contacto por hora`, async () => {
    await mkField(T.alice, 'Servicio');
    const tag = await mkTag(T.alice, 'Cambió');
    const r = await live(T.alice, body('Cada cambio', { type: 'field_changed', filter: { field: 'servicio' } }, [{ type: 'add_tag', tag_id: tag }]));
    const c = await mkContact(T.alice);
    for (let i = 0; i < MAX_RUNS_PER_CONTACT_HOUR; i += 1) await admin.query(`INSERT INTO automation_runs(id, organization_id, automation_id, contact_id, event_type, event_key, status) VALUES (gen_random_uuid(), $1, $2, $3, 'field_changed', $4, 'done')`, [ORG_A, r.id, c, `previo-${i}`]);
    expect((await call('PATCH', `/contacts/${c}`, T.alice, { custom_fields: { servicio: 'nuevo' } })).status).toBe(200);
    const last = (await runsOf(T.alice, r.id))[0]!;
    expect(last).toMatchObject({ status: 'skipped', reason: expect.stringContaining('Tope') });
    // otro contacto no se ve afectado
    const other = await mkContact(T.alice, 'Otro');
    expect((await call('PATCH', `/contacts/${other}`, T.alice, { custom_fields: { servicio: 'nuevo' } })).status).toBe(200);
    expect((await runsOf(T.alice, r.id)).find((x) => x.contact.id === other)).toMatchObject({ status: 'queued' });
  });

  it('atomicidad: si el hecho se revierte, la ejecución que provocó también', async () => {
    const tag = await mkTag(T.alice, 'X');
    await live(T.alice, body('Etiquetar', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const c = await mkContact(T.alice);
    await admin.query('TRUNCATE automation_run_steps, automation_runs CASCADE');
    const bus = app.get(DomainEventBus, { strict: false });
    const db = app.get(Database, { strict: false });
    const emit = (fail: boolean, key: string) =>
      TenantContext.run({ organizationId: ORG_A }, () =>
        db.withTenant(async (tx) => {
          await bus.emit(tx, { type: 'contact_created', contactId: c, key, source: 'manual' });
          if (fail) throw new Error('el hecho se revierte');
        }),
      );
    await expect(emit(true, 'k-rollback')).rejects.toThrow('el hecho se revierte');
    expect(await dbRuns()).toEqual([]);
    await emit(false, 'k-commit');
    expect(await dbRuns()).toHaveLength(1);
    // el mismo hecho anunciado dos veces no duplica la ejecución (clave única por regla y hecho)
    await emit(false, 'k-commit');
    expect(await dbRuns()).toHaveLength(1);
  });

  it('un error inesperado revierte la ejecución completa y se reintenta con espera creciente; tras 3 intentos queda fallida', async () => {
    const tag = await mkTag(T.alice, 'X');
    const r = await live(T.alice, body('Etiquetar', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const c = await mkContact(T.alice);
    vi.spyOn(app.get(AutomationActionsService, { strict: false }), 'execute').mockRejectedValue(new Error('se cayó algo'));
    const t0 = Date.now();
    expect(await drain(() => new Date(t0))).toBe(0); // reintento programado: no cuenta como resuelta
    expect((await dbRuns())[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect(new Date((await dbRuns())[0]!['next_attempt_at'] as string).getTime()).toBeGreaterThan(t0 + 9_000);
    expect(await drain(() => new Date(t0 + 1_000))).toBe(0); // todavía no le toca
    expect((await dbRuns())[0]).toMatchObject({ attempts: 1 });
    expect(await drain(() => new Date(t0 + 11_000))).toBe(0);
    expect((await dbRuns())[0]).toMatchObject({ status: 'queued', attempts: 2 });
    expect(await drain(() => new Date(t0 + 40_000))).toBe(1);
    const [run] = await runsOf(T.alice, r.id);
    expect(run).toMatchObject({ status: 'failed', reason: expect.stringContaining('intentos') });
    expect(run!.steps).toEqual([]);
    expect(await tagNames(c)).toEqual([]);
    // cuando el fallo pasa, una ejecución nueva sí se hace
    vi.restoreAllMocks();
    const c2 = await mkContact(T.alice, 'Después');
    await drain();
    expect(await tagNames(c2)).toEqual(['X']);
  });

  it('aislamiento A↔B: la regla de una empresa solo reacciona a hechos de SU empresa y sus ejecuciones no se ven desde la otra', async () => {
    const tagA = await mkTag(T.alice, 'De A');
    const tagB = await mkTag(T.bob, 'De B');
    const ra = await live(T.alice, body('Etiquetar A', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tagA }]));
    const rb = await live(T.bob, body('Etiquetar B', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tagB }]));
    const ca = await mkContact(T.alice, 'Cliente de A');
    const cb = await mkContact(T.bob, 'Cliente de B');
    await drain();
    expect(await tagNames(ca)).toEqual(['De A']);
    expect(await tagNames(cb)).toEqual(['De B']);
    expect((await runsOf(T.alice, ra.id)).map((x) => x.contact.name)).toEqual(['Cliente de A']);
    expect((await runsOf(T.bob, rb.id)).map((x) => x.contact.name)).toEqual(['Cliente de B']);
    expect((await call('GET', `/automations/${ra.id}/runs`, T.bob)).status).toBe(404);
    // en la base, cada ejecución quedó en su empresa
    expect((await admin.query(`SELECT organization_id, count(*)::int AS n FROM automation_runs GROUP BY organization_id ORDER BY 1`)).rows).toEqual(expect.arrayContaining([{ organization_id: ORG_A, n: 1 }, { organization_id: ORG_B, n: 1 }]));
  });

  it('un tope por pasada: el motor toma un lote y sigue en la siguiente', async () => {
    const tag = await mkTag(T.alice, 'X');
    const r = await live(T.alice, body('Etiquetar', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    for (let i = 0; i < 3; i += 1) await mkContact(T.alice, `Cliente ${i}`);
    expect(await app.get(AutomationsJob, { strict: false }).run(new Date())).toBe(3);
    expect((await runsOf(T.alice, r.id)).every((x) => x.status === 'done')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════ prueba en seco

describe('prueba en seco: qué haría la regla con un contacto, sin escribir nada', () => {
  interface Dry { contact: { id: string; name: string }; conditions: Array<{ index: number; met: boolean }>; meets: boolean; actions: Array<{ position: number; action: string; would: string; detail: string }> }
  const dry = async (token: string, rule: string, contact: string) => call('POST', `/automations/${rule}/test`, token, { contact_id: contact });
  const counts = async () => (await admin.query(`SELECT (SELECT count(*) FROM tasks)::int AS tasks, (SELECT count(*) FROM contact_tags)::int AS tags, (SELECT count(*) FROM messages)::int AS messages, (SELECT count(*) FROM automation_runs)::int AS runs, (SELECT count(*) FROM audit_logs)::int AS audit, (SELECT count(*) FROM stage_history)::int AS history`)).rows[0] as Record<string, number>;

  it('dice qué haría cada acción y no escribe nada (ni tareas, ni etiquetas, ni mensajes, ni ejecuciones, ni auditoría)', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    const other = await mkTag(T.alice, 'Otra');
    const st = await pipelineWithStages();
    const r = await mk(
      T.alice,
      body('Combo', { type: 'contact_created', filter: {} }, [
        { type: 'add_tag', tag_id: tag },
        { type: 'remove_tag', tag_id: other }, // no la tiene → omitiría
        { type: 'create_task', title: 'Llamar a {{primer_nombre}}' },
        { type: 'move_stage', stage_id: st.open2 },
        { type: 'assign_user', user_id: IDS.carol },
        { type: 'send_text', text: 'Hola' }, // sin conversación → omitiría
      ]),
    );
    const c = await mkContact(T.alice, 'Lucía Paredes', { owner_id: IDS.carol });
    const opp = await mkOpp(c, st.pipeline, st.open1);
    await admin.query(`UPDATE opportunities SET owner_id = $1 WHERE id = $2`, [IDS.carol, opp]); // ya es de la misma persona → asignar la omitiría
    const before = await counts();
    const res = await dry(T.alice, r.id, c);
    expect(res.status).toBe(200);
    const out = await json<Dry>(res);
    expect(out).toMatchObject({ contact: { id: c, name: 'Lucía Paredes' }, meets: true, conditions: [] });
    expect(out.actions.map((a) => [a.position, a.action, a.would])).toEqual([[1, 'add_tag', 'do'], [2, 'remove_tag', 'skip'], [3, 'create_task', 'do'], [4, 'move_stage', 'do'], [5, 'assign_user', 'skip'], [6, 'send_text', 'skip']]);
    expect(out.actions[2]!.detail).toContain('Llamar a Lucía');
    expect(out.actions[5]!.detail).toContain('conversación');
    expect(await counts()).toEqual(before);
    expect(await tagNames(c)).toEqual([]);
  });

  it('si el contacto no cumple las condiciones lo dice (y cuál) y no lista acciones', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    await mkField(T.alice, 'Servicio');
    const r = await mk(T.alice, body('Condicionada', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }], [{ field: 'custom:servicio', op: 'eq', value: 'corte' }, { field: 'consent', op: 'eq', value: 'unknown' }]));
    const c = await mkContact(T.alice);
    const out = await json<Dry>(await dry(T.alice, r.id, c));
    expect(out).toMatchObject({ meets: false, conditions: [{ index: 0, met: false }, { index: 1, met: true }], actions: [] });
  });

  it('una persona que ya no puede recibir trabajo, la etapa oculta y el consentimiento revocado se ven como fallo u omisión', async () => {
    const st = await pipelineWithStages();
    const r = await live(T.alice, body('Varias', { type: 'contact_created', filter: {} }, [{ type: 'move_stage', stage_id: st.open2 }, { type: 'assign_user', user_id: IDS.carol }, { type: 'send_text', text: 'Hola' }]));
    await admin.query(`UPDATE pipeline_stages SET is_hidden = true WHERE id = $1`, [st.open2]);
    await admin.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [IDS.carol]).catch(() => undefined);
    app.get(OrgDirectoryService).invalidate();
    const c = await mkContact(T.alice);
    await admin.query(`UPDATE contacts SET consent = 'revoked' WHERE id = $1`, [c]);
    const out = await json<Dry>(await dry(T.alice, r.id, c));
    expect(out.actions[0]).toMatchObject({ action: 'move_stage', would: 'fail' });
    expect(out.actions[2]).toMatchObject({ action: 'send_text', would: 'skip', detail: expect.stringContaining('consentimiento') });
  });

  it('aislamiento y permisos: contacto o regla de otra empresa 404, contacto inexistente 404, forma estricta 400, asesor 403, sin sesión 401', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    const r = await mk(T.alice, body('X', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const mine = await mkContact(T.alice);
    const theirs = await mkContact(T.bob, 'Cliente de B');
    expect((await dry(T.alice, r.id, theirs)).status).toBe(404);
    expect((await dry(T.alice, r.id, GHOST)).status).toBe(404);
    expect((await dry(T.bob, r.id, theirs)).status).toBe(404);
    expect((await dry(T.carol, r.id, mine)).status).toBe(403);
    expect((await call('POST', `/automations/${r.id}/test`, undefined, { contact_id: mine })).status).toBe(401);
    expect((await call('POST', `/automations/${r.id}/test`, T.alice, { contact_id: mine, extra: 1 })).status).toBe(400);
    expect((await call('POST', `/automations/${r.id}/test`, T.alice, {})).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════ M9.5a: esperar, ejecutar otra regla, activar al agente

describe('esperar', () => {
  const H = 3_600_000;
  const tagOf = tagNames;

  it('una espera deja la ejecución en pausa y sigue cuando llega su hora, con los pasos numerados de corrido', async () => {
    const a = await mkTag(T.alice, 'Antes');
    const b = await mkTag(T.alice, 'Despues');
    const r = await live(T.alice, body('Con espera', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: a }, { type: 'wait', amount: 2, unit: 'hours' }, { type: 'add_tag', tag_id: b }, { type: 'create_task', title: 'Seguir a {{primer_nombre}}', assignee: IDS.carol }]));
    const c = await mkContact(T.alice, 'Lucía Paredes');
    const t0 = new Date();
    await drain(() => t0);
    expect(await tagOf(c)).toEqual(['Antes']);
    let [run] = await runsOf(T.alice, r.id);
    expect(run).toMatchObject({ status: 'waiting', resume_at: new Date(t0.getTime() + 2 * H).toISOString() });
    expect(run!.steps.map((s) => [s.position, s.action, s.outcome, s.detail])).toEqual([[1, 'add_tag', 'done', expect.any(String)], [2, 'wait', 'done', 'Espera de 2 horas']]);
    expect((await json<{ items: Rule[] }>(await call('GET', '/automations', T.alice))).items[0]!.recent).toMatchObject({ waiting: 1, queued: 0 });
    // antes de la hora no pasa nada
    await drain(() => new Date(t0.getTime() + 1 * H));
    expect(await tagOf(c)).toEqual(['Antes']);
    expect(((await json<{ items: Run[] }>(await call('GET', `/automations/${r.id}/runs?status=waiting`, T.alice))).items).length).toBe(1);
    // llegada su hora, continúa
    await drain(() => new Date(t0.getTime() + 2 * H + 1000));
    [run] = await runsOf(T.alice, r.id);
    expect(run).toMatchObject({ status: 'done', resume_at: null });
    expect(await tagOf(c)).toEqual(['Antes', 'Despues']);
    expect(run!.steps.map((s) => [s.position, s.action, s.outcome])).toEqual([[1, 'add_tag', 'done'], [2, 'wait', 'done'], [3, 'add_tag', 'done'], [4, 'create_task', 'done']]);
    expect((await tasksOf())[0]).toMatchObject({ title: 'Seguir a Lucía' });
    expect((await dbRuns())[0]!['resume_actions']).toBeNull();
  });

  it('una espera de días no se descarta por «demasiado tiempo en cola»', async () => {
    const b = await mkTag(T.alice, 'Despues');
    const r = await live(T.alice, body('Tres días', { type: 'contact_created', filter: {} }, [{ type: 'wait', amount: 3, unit: 'days' }, { type: 'add_tag', tag_id: b }]));
    const c = await mkContact(T.alice);
    const t0 = new Date();
    await drain(() => t0);
    await drain(() => new Date(t0.getTime() + 3 * 24 * H + 60_000));
    expect((await runsOf(T.alice, r.id))[0]).toMatchObject({ status: 'done' });
    expect(await tagOf(c)).toEqual(['Despues']);
  });

  it('editar la regla mientras espera NO cambia lo que ya empezó; pausarla o borrar al contacto sí lo cancela, con su motivo', async () => {
    const x = await mkTag(T.alice, 'Original');
    const y = await mkTag(T.alice, 'Editada');
    const r = await live(T.alice, body('Editable', { type: 'contact_created', filter: {} }, [{ type: 'wait', amount: 1, unit: 'hours' }, { type: 'add_tag', tag_id: x }]));
    const c1 = await mkContact(T.alice, 'Uno');
    const t0 = new Date();
    await drain(() => t0);
    expect((await call('PATCH', `/automations/${r.id}`, T.alice, { actions: [{ type: 'wait', amount: 1, unit: 'hours' }, { type: 'add_tag', tag_id: y }] })).status).toBe(200);
    await drain(() => new Date(t0.getTime() + 2 * H));
    expect(await tagOf(c1)).toEqual(['Original']);
    // pausar la regla cancela lo que espera
    const c2 = await mkContact(T.alice, 'Dos');
    const t1 = new Date();
    await drain(() => t1);
    expect((await call('POST', `/automations/${r.id}/pause`, T.alice)).status).toBe(200);
    await drain(() => new Date(t1.getTime() + 2 * H));
    expect(await tagOf(c2)).toEqual([]);
    expect((await runsOf(T.alice, r.id)).find((x2) => x2.contact.name === 'Dos')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('pausó') });
    // reactivar y borrar al contacto mientras espera
    await activate(T.alice, r.id);
    const c3 = await mkContact(T.alice, 'Tres');
    const t2 = new Date();
    await drain(() => t2);
    expect((await call('DELETE', `/contacts/${c3}`, T.alice)).status).toBeLessThan(300);
    await drain(() => new Date(t2.getTime() + 2 * H));
    expect((await runsOf(T.alice, r.id)).find((x2) => x2.contact.name === 'Tres')).toMatchObject({ status: 'skipped', reason: 'El contacto ya no existe' });
  });

  it('un paso que falló antes de la espera cuenta al final: la ejecución termina «con fallos»', async () => {
    const b = await mkTag(T.alice, 'Despues');
    await mkField(T.alice, 'Servicio');
    const r = await live(T.alice, body('Falla y espera', { type: 'contact_created', filter: {} }, [{ type: 'set_field', field: 'servicio', value: 'x' }, { type: 'wait', amount: 5, unit: 'minutes' }, { type: 'add_tag', tag_id: b }]));
    const field = (await json<{ items: Array<{ id: string; key: string }> }>(await call('GET', '/custom-fields', T.alice))).items.find((f) => f.key === 'servicio')!;
    await mkContact(T.alice);
    expect((await call('POST', `/custom-fields/${field.id}/archive`, T.alice)).status).toBe(200);
    const t0 = new Date();
    await drain(() => t0);
    await drain(() => new Date(t0.getTime() + 6 * 60_000));
    const [run] = await runsOf(T.alice, r.id);
    expect(run).toMatchObject({ status: 'failed', reason: '1 acción falló' });
    expect(run!.steps.map((s) => s.outcome)).toEqual(['failed', 'done', 'done']);
  });

  it('el servidor valida las esperas: de 1 minuto a 30 días, y no puede ser la última acción', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    const mkw = (a: Record<string, unknown>, tail = true) => body('Espera ' + JSON.stringify(a), { type: 'contact_created', filter: {} }, [a, ...(tail ? [{ type: 'add_tag', tag_id: tag }] : [])]);
    expect((await call('POST', '/automations', T.alice, mkw({ type: 'wait', amount: 1, unit: 'minutes' }))).status).toBe(201);
    expect((await call('POST', '/automations', T.alice, mkw({ type: 'wait', amount: 30, unit: 'days' }))).status).toBe(201);
    for (const bad of [{ type: 'wait', amount: 0, unit: 'minutes' }, { type: 'wait', amount: 31, unit: 'days' }, { type: 'wait', amount: 1, unit: 'weeks' }, { type: 'wait', amount: 1.5, unit: 'hours' }, { type: 'wait', unit: 'hours' }, { type: 'wait', amount: 1, unit: 'hours', extra: 1 }]) {
      expect((await call('POST', '/automations', T.alice, mkw(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const last = await call('POST', '/automations', T.alice, mkw({ type: 'wait', amount: 2, unit: 'hours' }, false));
    expect(last.status).toBe(400);
    expect(JSON.stringify(await last.json())).toContain('esperar al final no hace nada');
  });
});

describe('ejecutar otra automatización', () => {
  const calls = (target: string) => body('Llama a otra', { type: 'contact_created', filter: {} }, [{ type: 'run_rule', automation_id: target }]);

  it('la regla llamada corre en su propia ejecución (encadenada, con su hecho «rule_call») y la que llama anota qué pasó', async () => {
    const tag = await mkTag(T.alice, 'Llamada');
    const target = await live(T.alice, body('Ayudante', { type: 'sale_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const caller = await live(T.alice, calls(target.id));
    const c = await mkContact(T.alice);
    await drain();
    const [cr] = await runsOf(T.alice, caller.id);
    expect(cr).toMatchObject({ status: 'done', depth: 0 });
    expect(cr!.steps[0]).toMatchObject({ action: 'run_rule', outcome: 'done', detail: 'Se ejecutará «Ayudante»' });
    const [tr] = await runsOf(T.alice, target.id);
    expect(tr).toMatchObject({ status: 'done', event_type: 'rule_call', depth: 1 });
    expect(await tagNames(c)).toEqual(['Llamada']);
  });

  it('la regla llamada evalúa sus condiciones y debe estar activa; si no, el paso se omite sin dejar ejecución', async () => {
    const tag = await mkTag(T.alice, 'Llamada');
    await mkField(T.alice, 'Servicio');
    const conditional = await live(T.alice, body('Con condición', { type: 'sale_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }], [{ field: 'custom:servicio', op: 'eq', value: 'corte' }]));
    const draft = await mk(T.alice, body('Borrador', { type: 'sale_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const a = await live(T.alice, body('Llama a dos', { type: 'contact_created', filter: {} }, [{ type: 'run_rule', automation_id: conditional.id }, { type: 'run_rule', automation_id: draft.id }]));
    await mkContact(T.alice);
    await drain();
    const [run] = await runsOf(T.alice, a.id);
    expect(run!.steps.map((s) => [s.outcome, s.detail])).toEqual([['skipped', 'El contacto no cumple las condiciones de «Con condición»'], ['skipped', '«Borrador» no está activa']]);
    expect(await dbRuns()).toHaveLength(1); // solo la de la regla que llama
  });

  it('el servidor valida el destino: debe existir en la empresa y no puede ser la misma regla', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    const mine = await mk(T.alice, body('Mía', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const theirs = await mk(T.bob, body('De B', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: await mkTag(T.bob, 'B') }]));
    expect((await call('POST', '/automations', T.alice, calls(GHOST))).status).toBe(400);
    expect((await call('POST', '/automations', T.alice, calls(theirs.id))).status).toBe(400);
    const self = await call('PATCH', `/automations/${mine.id}`, T.alice, { actions: [{ type: 'run_rule', automation_id: mine.id }] });
    expect(self.status).toBe(400);
    expect(JSON.stringify(await self.json())).toContain('no puede ejecutarse a sí misma');
    expect((await call('POST', '/automations', T.alice, calls(mine.id))).status).toBe(201);
  });

  it('dos reglas que se llaman entre sí no se ciclan: la segunda vuelta de la primera se omite y queda registrada', async () => {
    const tag = await mkTag(T.alice, 'Hecho');
    const a = await live(T.alice, body('A', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const b = await live(T.alice, body('B', { type: 'sale_created', filter: {} }, [{ type: 'run_rule', automation_id: a.id }]));
    expect((await call('PATCH', `/automations/${a.id}`, T.alice, { actions: [{ type: 'run_rule', automation_id: b.id }] })).status).toBe(200);
    await mkContact(T.alice);
    await drain();
    const runsA = await runsOf(T.alice, a.id);
    expect(runsA.map((r) => r.status).sort()).toEqual(['done', 'skipped']);
    expect(runsA.find((r) => r.status === 'skipped')!.reason).toContain('Ciclo');
    expect((await runsOf(T.alice, b.id))[0]!.steps[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('se omitió') });
  });
});

describe('activar al agente de IA', () => {
  it('activa al agente de la conexión en la conversación abierta; si ya está activo, no hay agente o no hay conversación, se omite', async () => {
    const mkChannel = async (name: string, waba: string, phone: string) => (await json<{ id: string }>(await call('POST', '/channels', T.alice, { name, waba_id: waba, phone_number_id: phone, access_token: FAKE_WHATSAPP_TOKEN }))).id;
    const ch = await mkChannel('Ventas', '1234567890123', '1090123456789');
    const ch2 = await mkChannel('Sin agente', '1234567890124', '1090123456790');
    const agent = (await json<{ id: string }>(await call('POST', '/agents', T.alice, { name: 'Sofía' }))).id;
    expect((await call('PATCH', `/agents/${agent}`, T.alice, { personality: 'Cálida y cercana.', objective: 'Ayudar con horarios', active: true })).status).toBe(200);
    expect((await call('PUT', `/agents/${agent}/channels`, T.alice, { channel_ids: [ch] })).status).toBe(200);
    const r = await live(T.alice, body('Activar IA', { type: 'message_received', filter: {} }, [{ type: 'start_agent' }]));
    const conversations = app.get(ConversationsService, { strict: false });
    const db = app.get(Database, { strict: false });
    const inbound = (channel: string, id: string, from: string, name: string) =>
      TenantContext.run({ organizationId: ORG_A }, () =>
        db.withTenant((tx) => conversations.ingestInbound(tx, channel, { externalId: id, from, fromRaw: from.slice(1), profileName: name, kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date() }, { now: new Date(), timeZone: 'UTC', assignable: new Set<string>() })),
      );
    // 1) una persona ya trabaja la conversación: la automatización activa al agente
    await inbound(ch, 'wamid.1', '+593984217730', 'Marta Lema');
    await admin.query(`UPDATE conversations SET status = 'working', owner_id = $1, assigned_at = now() WHERE peer_id = '593984217730'`, [IDS.carol]);
    await drain();
    const st = (await admin.query(`SELECT s.status, s.resumed_at, s.reason, a.name FROM ai_conversation_state s JOIN agents a ON a.id = s.agent_id`)).rows;
    expect(st).toEqual([{ status: 'active', resumed_at: expect.any(Date), reason: null, name: 'Sofía' }]);
    expect((await runsOf(T.alice, r.id))[0]!.steps[0]).toMatchObject({ action: 'start_agent', outcome: 'done' });
    expect((await admin.query(`SELECT body FROM messages WHERE sender_type = 'system'`)).rows.map((m) => m.body)).toContain('Una automatización activó al agente Sofía.');
    expect((await admin.query(`SELECT source FROM audit_logs WHERE entity_type = 'conversation' AND field = 'ai_agent'`)).rows).toEqual([{ source: 'automation' }]);
    // 2) con otro mensaje, el agente ya estaba activo
    await inbound(ch, 'wamid.2', '+593984217730', 'Marta Lema');
    await drain();
    expect((await runsOf(T.alice, r.id))[0]!.steps[0]).toMatchObject({ outcome: 'skipped', detail: 'El agente de IA ya está activo en la conversación' });
    // 3) una conexión sin agente
    await inbound(ch2, 'wamid.3', '+593984217731', 'Otro');
    await drain();
    expect((await runsOf(T.alice, r.id)).find((x) => x.contact.name === 'Otro')!.steps[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('no tiene un agente de IA activo') });
  });

  it('un contacto sin conversación abierta se omite', async () => {
    const r = await live(T.alice, body('Activar IA', { type: 'contact_created', filter: {} }, [{ type: 'start_agent' }]));
    await mkContact(T.alice);
    await drain();
    expect((await runsOf(T.alice, r.id))[0]!.steps[0]).toMatchObject({ outcome: 'skipped', detail: 'No hay una conversación abierta con el contacto' });
  });
});

describe('prueba en seco de las acciones nuevas', () => {
  it('dice que esperaría, ejecutaría otra regla y activaría al agente (o por qué no), sin escribir nada', async () => {
    const tag = await mkTag(T.alice, 'Nuevo');
    const target = await live(T.alice, body('Ayudante', { type: 'sale_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }]));
    const r = await mk(T.alice, body('Con todo', { type: 'contact_created', filter: {} }, [{ type: 'add_tag', tag_id: tag }, { type: 'wait', amount: 2, unit: 'hours' }, { type: 'run_rule', automation_id: target.id }, { type: 'start_agent' }]));
    const c = await mkContact(T.alice);
    const snapshot = async () => (await admin.query(`SELECT (SELECT count(*) FROM automation_runs)::int AS runs, (SELECT count(*) FROM audit_logs)::int AS audit`)).rows[0];
    const before = await snapshot();
    const out = await json<{ actions: Array<{ action: string; would: string; detail: string; after_wait: boolean }> }>(await call('POST', `/automations/${r.id}/test`, T.alice, { contact_id: c }));
    expect(out.actions.map((a) => [a.action, a.would, a.after_wait])).toEqual([['add_tag', 'do', false], ['wait', 'do', false], ['run_rule', 'do', true], ['start_agent', 'skip', true]]);
    expect(out.actions[1]!.detail).toContain('2 horas');
    expect(out.actions[3]!.detail).toBe('No hay una conversación abierta con el contacto');
    expect(await snapshot()).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════ M9.5b: llamada HTTP

describe('llamada HTTP: lista de permitidos', () => {
  const settings = (token: string | undefined, hosts: unknown) => call('PUT', '/automations/settings', token, { http_allowed_hosts: hosts });

  it('sin sesión 401, el asesor 403 y cada empresa tiene su propia lista (A↔B)', async () => {
    expect((await call('GET', '/automations/settings')).status).toBe(401);
    expect((await settings(undefined, [])).status).toBe(401);
    expect((await call('GET', '/automations/settings', T.carol)).status).toBe(403);
    expect((await settings(T.carol, ['mi-sistema.com'])).status).toBe(403);
    expect(await json(await call('GET', '/automations/settings', T.alice))).toEqual({ http_allowed_hosts: [], limits: { max_hosts: 20 } });
    expect((await settings(T.alice, ['mi-sistema.com'])).status).toBe(200);
    expect((await json<{ http_allowed_hosts: string[] }>(await call('GET', '/automations/settings', T.alice))).http_allowed_hosts).toEqual(['mi-sistema.com']);
    expect((await json<{ http_allowed_hosts: string[] }>(await call('GET', '/automations/settings', T.bob))).http_allowed_hosts).toEqual([]);
  });

  it('normaliza y quita repetidos; rechaza IP, localhost, direcciones completas y más de 20, con el motivo; y deja auditoría', async () => {
    const ok = await json<{ http_allowed_hosts: string[] }>(await settings(T.alice, [' Mi-Sistema.COM ', 'mi-sistema.com', '*.n8n.cloud']));
    expect(ok.http_allowed_hosts).toEqual(['mi-sistema.com', '*.n8n.cloud']);
    expect((await admin.query(`SELECT source, new_value FROM audit_logs WHERE entity_type = 'automation_settings' AND field = 'http_allowed_hosts'`)).rows).toEqual([{ source: 'manual', new_value: ['mi-sistema.com', '*.n8n.cloud'] }]);
    for (const bad of [['127.0.0.1'], ['localhost'], ['https://mi-sistema.com'], ['mi-sistema.com:8080'], ['*'], ['8.8.8.8'], ['bien.com', '10.0.0.1']]) {
      const r = await settings(T.alice, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.stringify(await r.json())).toContain('no es un dominio válido');
    }
    expect((await settings(T.alice, Array.from({ length: 21 }, (_, i) => `d${i}.ejemplo.com`))).status).toBe(400);
    expect((await settings(T.alice, 'mi-sistema.com')).status).toBe(400);
    // lo que no cambió no deja otro rastro
    await settings(T.alice, ['mi-sistema.com', '*.n8n.cloud']);
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'automation_settings'`)).rows[0].n).toBe(1);
  });
});

describe('llamada HTTP: validación al guardar', () => {
  const http = (over: Record<string, unknown> = {}) => ({ type: 'http_request', method: 'POST', url: 'https://hooks.ejemplo.com/hook/abc', body: '{"nombre": "{{nombre}}"}', ...over });
  const mk1 = (a: unknown) => call('POST', '/automations', T.alice, body('Llamada ' + Math.random(), { type: 'contact_created', filter: {} }, [a]));

  it('el dominio debe estar en la lista; con él autorizado se guarda', async () => {
    const r = await mk1(http());
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain('no está en la lista de permitidos');
    await call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: ['hooks.ejemplo.com'] });
    expect((await mk1(http())).status).toBe(201);
    // un comodín cubre subdominios, no el dominio base
    await call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: ['*.ejemplo.com'] });
    expect((await mk1(http())).status).toBe(201);
    expect((await mk1(http({ url: 'https://ejemplo.com/x' }))).status).toBe(400);
  });

  it('rechaza direcciones que no son https, con puerto, con credenciales, IP, localhost o con variables', async () => {
    await call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: ['hooks.ejemplo.com'] });
    for (const url of ['http://hooks.ejemplo.com/x', 'https://hooks.ejemplo.com:8443/x', 'https://u:p@hooks.ejemplo.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://2130706433/x', 'https://hooks.ejemplo.com/{{telefono}}', 'no-es-una-direccion', '']) {
      expect((await mk1(http({ url }))).status, url).toBe(400);
    }
  });

  it('el cuerpo debe ser JSON con variables conocidas; GET no lleva cuerpo; las formas desconocidas se rechazan', async () => {
    await call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: ['hooks.ejemplo.com'] });
    for (const b of ['no es json', '"solo texto"', '{"a": {{id}}}', '{"clave": "{{password}}"}', '{"a": 1']) expect((await mk1(http({ body: b }))).status, b).toBe(400);
    expect((await mk1(http({ method: 'GET', body: '{"a":1}' }))).status).toBe(400);
    expect((await mk1(http({ method: 'GET', body: undefined }))).status).toBe(201);
    expect((await mk1(http({ method: 'POST', body: undefined }))).status).toBe(201);
    expect((await mk1(http({ method: 'PUT' }))).status).toBe(400);
    expect((await mk1(http({ method: 'DELETE' }))).status).toBe(400);
    expect((await mk1(http({ headers: { Authorization: 'x' } }))).status).toBe(400);
  });

  it('una regla puede tener a lo sumo 3 llamadas HTTP', async () => {
    await call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: ['hooks.ejemplo.com'] });
    const four = [http(), http(), http(), http()];
    const r = await call('POST', '/automations', T.alice, body('Cuatro', { type: 'contact_created', filter: {} }, four));
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain('como máximo 3 llamadas HTTP');
    expect((await call('POST', '/automations', T.alice, body('Tres', { type: 'contact_created', filter: {} }, four.slice(0, 3)))).status).toBe(201);
  });
});

describe('llamada HTTP: ejecución', () => {
  const fake = (): FakeOutboundHttp => app.get(OUTBOUND_HTTP, { strict: false }) as FakeOutboundHttp;
  const http = (over: Record<string, unknown> = {}) => ({ type: 'http_request', method: 'POST', url: 'https://hooks.ejemplo.com/hook/secreto-123?token=abc', body: '{"nombre": "{{nombre}}", "correo": "{{correo}}", "telefono": "{{telefono}}", "id": "{{id}}"}', ...over });
  const allowed = async () => call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: ['hooks.ejemplo.com'] });
  const withContact = async (name = 'Lucía Paredes') => mkContact(T.alice, name, { email: 'lucia@ejemplo.com', phones: ['+593984217730'] });

  it('llama una vez con el cuerpo armado (valores escapados), la llave de idempotencia y deja solo el dominio en el historial y la auditoría', async () => {
    fake().reset();
    await allowed();
    const r = await live(T.alice, body('Avisar', { type: 'contact_created', filter: {} }, [http()]));
    const c = await withContact('Ana "la" Pérez');
    await drain();
    expect(fake().sent).toHaveLength(1);
    const sent = fake().sent[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url.href).toBe('https://hooks.ejemplo.com/hook/secreto-123?token=abc');
    expect(JSON.parse(sent.body!)).toEqual({ nombre: 'Ana "la" Pérez', correo: 'lucia@ejemplo.com', telefono: '+593984217730', id: c });
    const [run] = await runsOf(T.alice, r.id);
    expect(sent.idempotencyKey).toBe(`${run!.id}:1`);
    expect(run).toMatchObject({ status: 'done' });
    expect(run!.steps[0]).toMatchObject({ action: 'http_request', outcome: 'done', detail: 'Llamada a hooks.ejemplo.com: respondió 200' });
    const audit = (await admin.query(`SELECT source, new_value FROM audit_logs WHERE entity_type = 'contact' AND field = 'http_request'`)).rows;
    expect(audit).toEqual([{ source: 'automation', new_value: { host: 'hooks.ejemplo.com', method: 'POST', status: 200, variables: ['nombre', 'correo', 'telefono', 'id'] } }]);
    expect(JSON.stringify([audit, run])).not.toMatch(/secreto-123|token=abc|lucia@ejemplo|593984217730/);
  });

  it('GET sin cuerpo y POST sin cuerpo se mandan sin datos del contacto', async () => {
    fake().reset();
    await allowed();
    await live(T.alice, body('Solo avisar', { type: 'contact_created', filter: {} }, [http({ method: 'GET', body: undefined }), http({ method: 'POST', body: undefined })]));
    await withContact();
    await drain();
    expect(fake().sent.map((s) => [s.method, s.body])).toEqual([['GET', null], ['POST', null]]);
    expect(fake().sent.map((s) => s.idempotencyKey.split(':')[1])).toEqual(['1', '2']);
  });

  it('un código de error o una redirección fallan el paso (con su motivo), no se reintentan y no frenan las demás acciones', async () => {
    fake().reset();
    await allowed();
    const tag = await mkTag(T.alice, 'Despues');
    const r = await live(T.alice, body('Falla', { type: 'contact_created', filter: {} }, [http(), http(), { type: 'add_tag', tag_id: tag }]));
    fake().reply({ status: 500 }, { status: 302 });
    const c = await withContact();
    await drain();
    const [run] = await runsOf(T.alice, r.id);
    expect(run!.steps.map((s) => [s.outcome, s.detail])).toEqual([['failed', 'hooks.ejemplo.com respondió 500'], ['failed', 'hooks.ejemplo.com respondió 302: las redirecciones no se siguen'], ['done', expect.any(String)]]);
    expect(run).toMatchObject({ status: 'failed', reason: '2 acciones fallaron' });
    expect(await tagNames(c)).toEqual(['Despues']);
    expect(fake().sent).toHaveLength(2); // sin reintentos
    expect((await dbRuns())[0]!['attempts']).toBe(0);
    // aunque el destino respondió con error, lo que ya salió queda auditado
    expect((await admin.query(`SELECT new_value->>'status' AS s FROM audit_logs WHERE field = 'http_request' ORDER BY id`)).rows.map((x) => x.s)).toEqual(['500', '302']);
  });

  it('un fallo de red (tiempo agotado, dirección bloqueada, sin conexión) falla el paso con un texto sin la dirección', async () => {
    fake().reset();
    await allowed();
    const r = await live(T.alice, body('Red', { type: 'contact_created', filter: {} }, [http(), http(), http()]));
    fake().reply(new OutboundError('timeout', 'El servidor de destino tardó demasiado en responder'), new OutboundError('blocked', 'El destino apunta a una dirección que no es pública y no se permite'), new OutboundError('connect', 'No se pudo conectar con el servidor de destino'));
    await withContact();
    await drain();
    const [run] = await runsOf(T.alice, r.id);
    expect(run!.steps.map((s) => s.detail)).toEqual(['Llamada a hooks.ejemplo.com: El servidor de destino tardó demasiado en responder', 'Llamada a hooks.ejemplo.com: El destino apunta a una dirección que no es pública y no se permite', 'Llamada a hooks.ejemplo.com: No se pudo conectar con el servidor de destino']);
    expect(JSON.stringify(run)).not.toMatch(/secreto-123|token=abc/);
    // no salió ningún dato: no hay auditoría de envío
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE field = 'http_request'`)).rows[0].n).toBe(0);
  });

  it('si el dominio se quita de la lista DESPUÉS de guardar la regla, la llamada no sale y el paso falla con el motivo', async () => {
    fake().reset();
    await allowed();
    const r = await live(T.alice, body('Quitada', { type: 'contact_created', filter: {} }, [http()]));
    await call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: [] });
    await withContact();
    await drain();
    expect(fake().sent).toHaveLength(0);
    expect((await runsOf(T.alice, r.id))[0]!.steps[0]).toMatchObject({ outcome: 'failed', detail: 'El dominio hooks.ejemplo.com no está en la lista de permitidos de la empresa' });
  });

  it('la lista de una empresa no autoriza a la otra', async () => {
    fake().reset();
    await call('PUT', '/automations/settings', T.bob, { http_allowed_hosts: ['hooks.ejemplo.com'] });
    expect((await call('POST', '/automations', T.alice, body('De A', { type: 'contact_created', filter: {} }, [http()]))).status).toBe(400);
  });

  it('un contacto sin correo ni teléfono manda esos valores vacíos (no «undefined» ni «null»)', async () => {
    fake().reset();
    await allowed();
    await live(T.alice, body('Vacíos', { type: 'contact_created', filter: {} }, [http()]));
    await mkContact(T.alice, 'Sin datos');
    await drain();
    expect(JSON.parse(fake().sent[0]!.body!)).toMatchObject({ nombre: 'Sin datos', correo: '', telefono: '' });
  });

  it('la prueba en seco dice que llamaría (o por qué no) sin llamar a nadie', async () => {
    fake().reset();
    await allowed();
    const r = await mk(T.alice, body('Probar', { type: 'contact_created', filter: {} }, [http(), http({ method: 'GET', body: undefined })]));
    const c = await withContact();
    await call('PUT', '/automations/settings', T.alice, { http_allowed_hosts: [] });
    const out = await json<{ actions: Array<{ would: string; detail: string }> }>(await call('POST', `/automations/${r.id}/test`, T.alice, { contact_id: c }));
    expect(out.actions.map((a) => a.would)).toEqual(['fail', 'fail']);
    await allowed();
    const ok = await json<{ actions: Array<{ would: string; detail: string }> }>(await call('POST', `/automations/${r.id}/test`, T.alice, { contact_id: c }));
    expect(ok.actions.map((a) => [a.would, a.detail])).toEqual([['do', 'Llamaría a hooks.ejemplo.com (POST, con datos del contacto)'], ['do', 'Llamaría a hooks.ejemplo.com (GET)']]);
    expect(fake().sent).toHaveLength(0);
  });
});
