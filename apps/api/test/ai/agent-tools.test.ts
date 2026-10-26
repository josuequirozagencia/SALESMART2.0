// M8.5b — Herramientas del agente de IA (ADR-53; F17). Cubre el simulador en seco: POST /v1/agents/:id/test
//   POST /v1/agents/:id/test
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AgentRuntimeService, AI_PROVIDER, AiModule, FakeAiProvider, HANDOFF_MESSAGE, KnowledgeProcessorService, MAX_AI_TASKS_PER_DAY, MAX_TOOL_ROUNDS, parseArgs, toolDefinitions, toolGuidance } from '../../src/modules/ai';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { AiModelPricesService, AiPricingService } from '../../src/modules/platform';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, AiModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const HORARIOS = 'Nuestro horario de atención es de lunes a viernes de 9 a 18 horas. Los sábados atendemos hasta el mediodía.';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let ai: FakeAiProvider;
let T: Record<'alice' | 'carol' | 'bob', string>;
let channelA = '';
let channelB = '';
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ai_tool_calls, tasks, custom_field_values, custom_field_definitions, ai_conversation_state, agent_test_runs, agent_channels, agent_documents, agents, document_chunks, knowledge_documents, messages, conversations, contact_phones, contacts, channel_accounts, ai_holds, ai_ledger, ai_wallets, ai_org_pricing, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
  await admin.query(`UPDATE ai_pricing SET usd_per_credit = 0.01, global_margin_pct = 100`);
  await admin.query(`UPDATE ai_model_prices SET usd_per_1m_input = 0.02, usd_per_1m_output = 0 WHERE model = 'text-embedding-3-small'`);
  await admin.query(`UPDATE ai_model_prices SET usd_per_1m_input = 0.15, usd_per_1m_output = 0.60 WHERE model = 'gpt-4o-mini'`);
  await admin.query(`UPDATE trial_config SET welcome_credits = 1000`);
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
  channelA = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', 'Ventas') RETURNING id`, [ORG_A])).rows[0].id as string;
  channelB = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', 'Ventas B') RETURNING id`, [ORG_B])).rows[0].id as string;
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
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);
const runtime = () => app.get(AgentRuntimeService);
/** Una pasada de la tarea para la empresa. */
const tick = (at: Date = new Date(), org = ORG_A) => inOrg(org, () => runtime().runDue(at));

/** Un agente activo atendiendo la conexión de la empresa A (con la biblioteca de horarios si se pide). */
async function liveAgent(opts: { docs?: boolean; patch?: Record<string, unknown>; token?: string; channel?: string } = {}): Promise<string> {
  const token = opts.token ?? T.alice;
  const id = ((await (await call('POST', '/agents', token, { name: 'Sofía' })).json()) as { id: string }).id;
  expect((await call('PATCH', `/agents/${id}`, token, { personality: 'Cálida y cercana.', objective: 'Ayudar con horarios', active: true, ...opts.patch })).status).toBe(200);
  if (opts.docs) {
    const r = await fetch(`${base}/knowledge/documents`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('horarios.txt'), authorization: `Bearer ${token}` }, body: Buffer.from(HORARIOS) });
    expect(r.status).toBe(201);
    const docId = ((await r.json()) as { id: string }).id;
    await inOrg(token === T.bob ? ORG_B : ORG_A, () => app.get(KnowledgeProcessorService).runDue(new Date(Date.now() + 1000)));
    expect((await call('PUT', `/agents/${id}/documents`, token, { document_ids: [docId] })).status).toBe(200);
  }
  expect((await call('PUT', `/agents/${id}/channels`, token, { channel_ids: [opts.channel ?? channelA] })).status).toBe(200);
  return id;
}

let seq = 0;
interface Mk { org?: string; status?: string; owner?: string | null }
async function mkConv(o: Mk = {}): Promise<{ id: string; contact: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const channel = org === ORG_B ? channelB : channelA;
  const status = o.status ?? 'unassigned';
  const owner = status === 'unassigned' ? null : (o.owner ?? IDS.carol);
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, `+59398700${String(seq).padStart(4, '0')}`]);
  const id = (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id, closed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now(), now(), 0, $7, $8) RETURNING id`,
      [org, contact, channel, status, owner, owner ? new Date() : null, `5939870${String(seq).padStart(4, '0')}`, status === 'closed' ? new Date() : null],
    )
  ).rows[0].id as string;
  return { id, contact };
}
let extSeq = 0;
/** Un mensaje del cliente (por omisión, de texto y de ahora). */
async function inbound(conv: string, text: string | null, over: { kind?: string; at?: Date; org?: string } = {}): Promise<void> {
  extSeq += 1;
  const org = over.org ?? ORG_A;
  await admin.query(
    `INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', $5, $6, 'received', $7)`,
    [org, conv, org === ORG_B ? channelB : channelA, `wamid.RT${extSeq}`, over.kind ?? 'text', text, over.at ?? new Date()],
  );
}
const messagesOf = async (conv: string) => (await admin.query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sent_at, id`, [conv])).rows as Row[];
const aiMessages = async (conv: string) => (await messagesOf(conv)).filter((m) => m['sender_type'] === 'ai');
const notes = async (conv: string) => (await messagesOf(conv)).filter((m) => m['kind'] === 'note').map((m) => String(m['body']));
const state = async (conv: string) => ((await admin.query(`SELECT * FROM ai_conversation_state WHERE conversation_id = $1`, [conv])).rows[0] ?? null) as Row | null;
const ledger = async (org = ORG_A) => (await admin.query(`SELECT * FROM ai_ledger WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Row[];

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AI_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  ai = app.get<FakeAiProvider>(AI_PROVIDER);
});
afterAll(async () => { await admin.query(`UPDATE ai_model_prices SET usd_per_1m_input = 0.15, usd_per_1m_output = 0.60 WHERE model = 'gpt-4o-mini'`); await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  app.get(AiPricingService).invalidate();
  app.get(AiModelPricesService).invalidate();
  ai.calls.length = 0;
  ai.keysSeen.length = 0;
  ai.clearFailures();
  ai.chatResult = null;
  ai.requiresCredentials = false;
  ai.tokensPerInput = null;
  ai.chatReply = () => 'Con gusto te ayudo';
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
});


// ── ayudas de esta prueba ────────────────────────────────────────────────────
let n = 0;
const tc = (name: string, args: unknown, raw?: string) => ({ id: `call_${++n}`, name, arguments: raw ?? JSON.stringify(args) });
/** El modelo pide estas herramientas en su primera respuesta y, al recibir los resultados, contesta `final`. */
const modelCalls = (calls: Array<ReturnType<typeof tc>>, final = 'Anotado, ¡gracias!'): void => {
  ai.chatResult = (req) => (req.messages.some((m) => m.role === 'tool') ? { text: final } : { toolCalls: calls });
};
const chatCalls = () => ai.calls.filter((c) => c.kind === 'chat') as unknown as Array<{ kind: 'chat'; request: { messages: Array<{ role: string; content: string }>; tools?: Array<{ name: string }> } }>;
const mkField = async (name: string, type: string, options?: string[]): Promise<void> => {
  expect((await call('POST', '/custom-fields', T.alice, { name, type, ...(options ? { options } : {}) })).status).toBe(201);
};
const fieldValues = async (contact: string): Promise<Record<string, string | null>> => {
  const rows = (await admin.query(`SELECT d.var_key, v.value_text, v.value_number, v.updated_by FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.definition_id WHERE v.entity_id = $1`, [contact])).rows as Row[];
  return Object.fromEntries(rows.map((r) => [String(r['var_key']), (r['value_text'] ?? r['value_number']) as string | null]));
};
const toolRows = async (conv: string) => (await admin.query(`SELECT * FROM ai_tool_calls WHERE conversation_id = $1 ORDER BY created_at, id`, [conv])).rows as Row[];
/** Estas pruebas no cargan documentos: sin respaldo dos veces seguidas el agente pasa a una persona (otra regla); aquí se reinicia la racha para seguir probando herramientas. */
const keepGoing = (conv: string) => admin.query(`UPDATE ai_conversation_state SET unsupported_streak = 0 WHERE conversation_id = $1`, [conv]);
const taskRows = async () => (await admin.query(`SELECT * FROM tasks ORDER BY created_at, id`)).rows as Row[];
const aiAudit = async (entity: string) => (await admin.query(`SELECT * FROM audit_logs WHERE source = 'ai' AND entity_type = $1 ORDER BY at, id`, [entity])).rows as Row[];
async function setup(patch: Record<string, unknown> = {}): Promise<string> {
  await mkField('Ciudad', 'text');
  await mkField('Interes', 'select', ['Curso de Uñas', 'Curso de Pestañas']);
  await mkField('Edad', 'number');
  return liveAgent({ patch: { capture_fields: ['ciudad', 'interes'], tasks_enabled: true, ...patch } });
}

describe('definiciones de herramientas (puras)', () => {
  const field = (key: string, type: string, options: string[] | null = null) => ({ key, name: key.toUpperCase(), type: type as never, options });
  it('solo ofrece las herramientas permitidas; los campos van como propiedades con su tipo y las opciones como lista cerrada', () => {
    expect(toolDefinitions({ fields: [], tasksEnabled: false, transferEnabled: false })).toEqual([]);
    expect(toolGuidance({ fields: [], tasksEnabled: false, transferEnabled: false })).toBe('');
    const defs = toolDefinitions({ fields: [field('ciudad', 'text'), field('interes', 'select', ['A', 'B']), field('edad', 'number'), field('tags', 'multiselect', ['x']), field('acepta', 'boolean')], tasksEnabled: true, transferEnabled: true });
    expect(defs.map((d) => d.name)).toEqual(['update_contact_fields', 'create_task', 'transfer_to_person']);
    const props = (defs[0]!.parameters as { properties: Record<string, Record<string, unknown>>; additionalProperties: boolean }).properties;
    expect(props['ciudad']).toMatchObject({ type: 'string' });
    expect(props['interes']).toMatchObject({ type: 'string', enum: ['A', 'B'] });
    expect(props['edad']).toMatchObject({ type: 'number' });
    expect(props['tags']).toMatchObject({ type: 'array' });
    expect(props['acepta']).toMatchObject({ type: 'boolean' });
    expect((defs[0]!.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
    expect(toolDefinitions({ fields: [], tasksEnabled: true, transferEnabled: false }).map((d) => d.name)).toEqual(['create_task']);
    const g = toolGuidance({ fields: [field('ciudad', 'text')], tasksEnabled: false, transferEnabled: false });
    expect(g).toContain('HERRAMIENTAS');
    expect(g).toContain('CIUDAD');
    expect(g).not.toContain('tarea');
  });
  it('lee los argumentos como un objeto JSON razonable y rechaza lo demás', () => {
    expect(parseArgs({ arguments: '{"a":1}' })).toEqual({ a: 1 });
    expect(parseArgs({ arguments: '' })).toEqual({});
    for (const bad of ['[1]', '"x"', 'null', '{no json', `{"a":"${'x'.repeat(2100)}"}`]) expect(parseArgs({ arguments: bad }), bad.slice(0, 20)).toBeNull();
  });
});

describe('configuración del agente', () => {
  it('PATCH capture_fields / tasks_enabled: se guardan, se auditan y se devuelven; campos inexistentes, archivados o de otra empresa se rechazan', async () => {
    await mkField('Ciudad', 'text');
    const id = await liveAgent();
    const r = await call('PATCH', `/agents/${id}`, T.alice, { capture_fields: ['ciudad', 'ciudad'], tasks_enabled: true });
    expect(r.status).toBe(200);
    expect(await json<{ capture_fields: string[]; tasks_enabled: boolean }>(r)).toMatchObject({ capture_fields: ['ciudad'], tasks_enabled: true });
    const audits = (await admin.query(`SELECT field FROM audit_logs WHERE entity_id = $1 AND field IN ('capture_fields', 'tasks_enabled')`, [id])).rows.map((x) => x.field);
    expect(audits.sort()).toEqual(['capture_fields', 'tasks_enabled']);
    const bad = await call('PATCH', `/agents/${id}`, T.alice, { capture_fields: ['no_existe'] });
    expect(bad.status).toBe(400);
    expect((await call('PATCH', `/agents/${id}`, T.alice, { capture_fields: Array.from({ length: 11 }, (_, i) => `c${i}`) })).status).toBe(400);
    // otra empresa: no tiene ese campo
    const bAgent = ((await (await call('POST', '/agents', T.bob, { name: 'Beto' })).json()) as { id: string }).id;
    expect((await call('PATCH', `/agents/${bAgent}`, T.bob, { capture_fields: ['ciudad'] })).status).toBe(400);
    // las opciones traen los campos que se pueden permitir
    const o = await json<{ capture_options: Array<{ key: string; name: string; type: string }>; limits: { max_capture_fields: number } }>(await call('GET', '/agents/options', T.alice));
    expect(o.capture_options).toEqual([{ key: 'ciudad', name: 'Ciudad', type: 'text' }]);
    expect(o.limits.max_capture_fields).toBe(10);
  });
});

describe('actualizar campos del contacto', () => {
  it('guarda lo que el cliente dijo (solo campos permitidos), con auditoría de origen IA, registro de la llamada y una nota; el resultado vuelve al modelo', async () => {
    await setup();
    const c = await mkConv();
    await inbound(c.id, 'Estoy en Guayaquil y quiero información del curso de uñas');
    modelCalls([tc('update_contact_fields', { ciudad: 'Guayaquil', interes: 'Curso de Uñas' })]);
    await tick();
    expect(await fieldValues(c.contact)).toEqual({ ciudad: 'Guayaquil', interes: 'Curso de Uñas' });
    expect((await admin.query(`SELECT updated_by FROM custom_field_values WHERE entity_id = $1`, [c.contact])).rows.every((r) => r.updated_by === null)).toBe(true);
    const audit = await aiAudit('contact');
    expect(audit.map((a) => a['field']).sort()).toEqual(['custom.ciudad', 'custom.interes']);
    expect(audit.find((a) => a['field'] === 'custom.ciudad')).toMatchObject({ old_value: null, new_value: 'Guayaquil', source: 'ai' });
    const rows = await toolRows(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'update_contact_fields', outcome: 'done' });
    expect(rows[0]!['args']).toEqual({ ciudad: 'Guayaquil', interes: 'Curso de Uñas' });
    // dos vueltas al modelo; la segunda lleva el resultado de la herramienta; la respuesta sale
    expect(chatCalls()).toHaveLength(2);
    expect(chatCalls()[1]!.request.messages.some((m) => m.role === 'tool' && m.content.startsWith('done: guardado'))).toBe(true);
    expect(chatCalls()[0]!.request.tools?.map((t) => t.name)).toContain('update_contact_fields');
    expect((await aiMessages(c.id)).map((m) => m['body'])).toEqual(['Anotado, ¡gracias!']);
    expect((await notes(c.id)).join('|')).toMatch(/guardó en la ficha: ciudad = Guayaquil/);
    // cada vuelta cobra sus créditos de uso
    expect((await ledger()).filter((l) => l['kind'] === 'use').length).toBeGreaterThanOrEqual(2);
  });

  it('un campo que el agente no tiene permitido, un valor inválido y una herramienta mal formada se rechazan con su motivo y no escriben nada', async () => {
    await setup();
    const c = await mkConv();
    await inbound(c.id, 'Tengo 30 años y vivo en Quito');
    modelCalls([tc('update_contact_fields', { edad: 30, ciudad: 'Quito', interes: 'Otro curso' })]);
    await tick();
    expect(await fieldValues(c.contact)).toEqual({ ciudad: 'Quito' });
    const row = (await toolRows(c.id))[0]!;
    expect(row).toMatchObject({ outcome: 'done' });
    const reply = chatCalls()[1]!.request.messages.find((m) => m.role === 'tool')!.content;
    expect(reply).toContain('edad (no tienes permiso para ese campo)');
    expect(reply).toContain('interes');
    // todo rechazado
    const d = await mkConv();
    await inbound(d.id, 'Tengo 30');
    ai.calls.length = 0;
    modelCalls([tc('update_contact_fields', { edad: 30 })]);
    await tick(new Date(Date.now() + 5000));
    expect(await fieldValues(d.contact)).toEqual({});
    expect((await toolRows(d.id))[0]).toMatchObject({ outcome: 'rejected' });
    // argumentos que no son JSON y herramienta inexistente
    const e = await mkConv();
    await inbound(e.id, 'Hola');
    ai.calls.length = 0;
    modelCalls([tc('update_contact_fields', null, '{no json'), tc('borrar_contacto', { id: 'x' })]);
    await tick(new Date(Date.now() + 10_000));
    const outcomes = (await toolRows(e.id)).map((r) => r['outcome']);
    expect(outcomes).toEqual(['rejected']); // la inexistente no se registra (no es una herramienta)
    const msgs = chatCalls()[1]!.request.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(msgs[0]).toMatch(/argumentos no son válidos/);
    expect(msgs[1]).toMatch(/no existe/);
  });

  it('no pisa lo que escribió una persona, ni vacía campos; sí corrige lo que escribió la propia IA; lo igual no cambia', async () => {
    await setup();
    const c = await mkConv();
    expect((await call('PATCH', `/contacts/${c.contact}`, T.alice, { custom_fields: { ciudad: 'Quito' } })).status).toBe(200);
    await inbound(c.id, 'En realidad estoy en Guayaquil');
    modelCalls([tc('update_contact_fields', { ciudad: 'Guayaquil' })]);
    await tick();
    expect(await fieldValues(c.contact)).toEqual({ ciudad: 'Quito' });
    expect((await toolRows(c.id))[0]).toMatchObject({ outcome: 'rejected' });
    expect(chatCalls()[1]!.request.messages.find((m) => m.role === 'tool')!.content).toContain('escribió una persona');
    expect(await aiAudit('contact')).toHaveLength(0);
    // vaciar no se puede
    const d = await mkConv();
    await inbound(d.id, 'Hola');
    modelCalls([tc('update_contact_fields', { ciudad: '' })]);
    await tick(new Date(Date.now() + 5000));
    expect(await fieldValues(d.contact)).toEqual({});
    expect((await toolRows(d.id))[0]).toMatchObject({ outcome: 'rejected' });
    // la IA corrige lo suyo y repetir el mismo valor no cambia nada
    const e = await mkConv();
    await inbound(e.id, 'Soy de Cuenca');
    modelCalls([tc('update_contact_fields', { ciudad: 'Cuenca' })]);
    await tick(new Date(Date.now() + 10_000));
    await keepGoing(e.id);
    await inbound(e.id, 'Perdón, de Loja', { at: new Date(Date.now() + 11_000) });
    modelCalls([tc('update_contact_fields', { ciudad: 'Loja' })]);
    await tick(new Date(Date.now() + 15_000));
    expect(await fieldValues(e.contact)).toEqual({ ciudad: 'Loja' });
    await keepGoing(e.id);
    await inbound(e.id, 'Sí, Loja', { at: new Date(Date.now() + 16_000) });
    modelCalls([tc('update_contact_fields', { ciudad: 'Loja' })]);
    await tick(new Date(Date.now() + 20_000));
    expect((await toolRows(e.id)).map((r) => r['outcome'])).toEqual(['done', 'done', 'unchanged']);
  });

  it('un contacto que pidió no recibir mensajes no se modifica; un agente sin campos permitidos no recibe la herramienta', async () => {
    await setup();
    const c = await mkConv();
    await admin.query(`UPDATE contacts SET consent = 'revoked' WHERE id = $1`, [c.contact]);
    await inbound(c.id, 'Vivo en Quito');
    modelCalls([tc('update_contact_fields', { ciudad: 'Quito' })]);
    await tick();
    expect(await fieldValues(c.contact)).toEqual({});
    expect((await toolRows(c.id))[0]).toMatchObject({ outcome: 'rejected' });
    // sin campos: el agente solo recibe las demás herramientas
    const id = ((await (await call('GET', '/agents', T.alice)).json()) as { items: Array<{ id: string }> }).items[0]!.id;
    expect((await call('PATCH', `/agents/${id}`, T.alice, { capture_fields: [], tasks_enabled: false, transfer_enabled: false })).status).toBe(200);
    const d = await mkConv();
    await inbound(d.id, 'Hola');
    ai.calls.length = 0;
    ai.chatResult = null;
    await tick(new Date(Date.now() + 5000));
    expect(chatCalls()[0]!.request.tools).toBeUndefined();
  });
});

describe('crear tareas', () => {
  it('crea la tarea para el responsable de la conversación, con la marca de IA, auditoría y registro; no duplica y tiene tope diario', async () => {
    await setup();
    const c = await mkConv({ status: 'pending' }); // responsable: Carolina
    await inbound(c.id, 'Pásame la cotización por favor');
    modelCalls([tc('create_task', { title: 'Enviar cotización del curso', notes: 'Pidió precios del curso de uñas', due_in_days: 2 })], 'Listo, le avisamos al equipo.');
    await tick();
    const rows = await taskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Enviar cotización del curso', assignee_id: IDS.carol, created_by: IDS.carol, contact_id: c.contact, status: 'open' });
    expect(String(rows[0]!['description'])).toContain('Creada por el agente de IA Sofía.');
    const due = new Date(rows[0]!['due_at'] as string).getTime() - Date.now();
    expect(due).toBeGreaterThan(1.9 * 86_400_000);
    expect(due).toBeLessThan(2.1 * 86_400_000);
    expect((await aiAudit('task')).length).toBe(1);
    expect((await toolRows(c.id))[0]).toMatchObject({ tool: 'create_task', outcome: 'done', entity_id: rows[0]!['id'] });
    expect((await notes(c.id)).join('|')).toContain('creó la tarea «Enviar cotización del curso»');
    // la misma tarea otra vez: no se duplica
    await keepGoing(c.id);
    await inbound(c.id, 'Gracias', { at: new Date(Date.now() + 1000) });
    modelCalls([tc('create_task', { title: 'enviar cotización del curso' })]);
    await tick(new Date(Date.now() + 5000));
    expect(await taskRows()).toHaveLength(1);
    expect((await toolRows(c.id)).map((r) => r['outcome'])).toEqual(['done', 'unchanged']);
    // tope de tareas por conversación al día
    for (let i = 0; i < MAX_AI_TASKS_PER_DAY; i++) {
      await keepGoing(c.id);
      await inbound(c.id, `Otra cosa ${i}`, { at: new Date(Date.now() + (10 + i) * 1000) });
      modelCalls([tc('create_task', { title: `Tarea distinta ${i}` })]);
      await tick(new Date(Date.now() + (20 + i * 10) * 1000));
    }
    expect((await taskRows()).length).toBe(MAX_AI_TASKS_PER_DAY);
    expect((await toolRows(c.id)).at(-1)).toMatchObject({ outcome: 'rejected' });
  });

  it('rechaza: tareas apagadas, sin responsable, título vacío o días fuera de rango', async () => {
    const id = await setup({ tasks_enabled: false });
    const a = await mkConv({ status: 'pending' });
    await inbound(a.id, 'Hola');
    modelCalls([tc('create_task', { title: 'X' })]);
    await tick();
    expect(await taskRows()).toHaveLength(0);
    // el modelo no recibió la herramienta, pero aunque la pida el servidor la rechaza
    expect(chatCalls()[0]!.request.tools?.map((t) => t.name) ?? []).not.toContain('create_task');
    expect((await toolRows(a.id))[0]).toMatchObject({ outcome: 'rejected' });
    expect((await call('PATCH', `/agents/${id}`, T.alice, { tasks_enabled: true })).status).toBe(200);
    const nobody = await mkConv(); // sin asignar y contacto sin dueño
    await inbound(nobody.id, 'Llámenme');
    modelCalls([tc('create_task', { title: 'Llamar al cliente' })]);
    await tick(new Date(Date.now() + 5000));
    expect(await taskRows()).toHaveLength(0);
    expect((await toolRows(nobody.id))[0]).toMatchObject({ outcome: 'rejected' });
    const b = await mkConv({ status: 'pending' });
    await inbound(b.id, 'Hola');
    modelCalls([tc('create_task', { title: '   ' }), tc('create_task', { title: 'Algo', due_in_days: 99 }), tc('create_task', { title: 'Algo', due_in_days: 1.5 })]);
    await tick(new Date(Date.now() + 10_000));
    expect(await taskRows()).toHaveLength(0);
    expect((await toolRows(b.id)).map((r) => r['outcome'])).toEqual(['rejected', 'rejected', 'rejected']);
  });
});

describe('pasar a una persona con la herramienta', () => {
  it('el agente decide transferir: contesta, se retira (agent_decision) y deja nota; sin texto propio se envía el aviso fijo', async () => {
    await setup();
    const c = await mkConv({ status: 'pending' });
    await inbound(c.id, 'Necesito algo que no sé explicarte bien');
    modelCalls([tc('transfer_to_person', { reason: 'Pregunta fuera de mis documentos' })], 'Te paso con una persona del equipo.');
    await tick();
    expect(await state(c.id)).toMatchObject({ status: 'handed_off', reason: 'agent_decision' });
    expect((await aiMessages(c.id)).map((m) => m['body'])).toEqual(['Te paso con una persona del equipo.']);
    expect((await toolRows(c.id))[0]).toMatchObject({ tool: 'transfer_to_person', outcome: 'done' });
    // sin texto propio
    const d = await mkConv({ status: 'pending' });
    await inbound(d.id, 'Otra duda');
    modelCalls([tc('transfer_to_person', { reason: 'No sé' })], '');
    await tick(new Date(Date.now() + 5000));
    expect((await aiMessages(d.id)).map((m) => m['body'])).toEqual([HANDOFF_MESSAGE]);
    expect(await state(d.id)).toMatchObject({ status: 'handed_off', reason: 'agent_decision' });
    // ya no contesta más
    await inbound(d.id, 'Hola?', { at: new Date(Date.now() + 6000) });
    expect(await tick(new Date(Date.now() + 8000))).toBe(0);
  });

  it('con una cola de transferencia, una conversación SIN asignar se reparte en esa cola; una que ya tiene responsable no se toca', async () => {
    const id = await setup();
    const q = ((await (await call('POST', '/queues', T.alice, { name: 'Soporte' })).json()) as { id: string }).id;
    expect((await call('PATCH', `/queues/${q}`, T.alice, { distribution_on: true })).status).toBe(200);
    expect((await call('PUT', `/queues/${q}/members`, T.alice, { members: [{ user_id: IDS.carol, active: true, weight: 1 }] })).status).toBe(200);
    expect((await call('PATCH', `/agents/${id}`, T.alice, { transfer_queue_id: q })).status).toBe(200);
    app.get(OrgDirectoryService).invalidate();
    const free = await mkConv(); // sin asignar
    await inbound(free.id, 'Quiero hablar con un asesor');
    await tick();
    const row = (await admin.query(`SELECT status, owner_id, queue_id FROM conversations WHERE id = $1`, [free.id])).rows[0] as Row;
    expect(row).toMatchObject({ status: 'pending', owner_id: IDS.carol, queue_id: q });
    expect(await state(free.id)).toMatchObject({ status: 'handed_off', reason: 'requested' });
    // ya tenía responsable (pendiente de Carolina): no cambia de cola ni de dueño
    const owned = await mkConv({ status: 'pending', owner: IDS.alice });
    await inbound(owned.id, 'Quiero hablar con una persona');
    await tick(new Date(Date.now() + 5000));
    expect((await admin.query(`SELECT owner_id, queue_id FROM conversations WHERE id = $1`, [owned.id])).rows[0]).toMatchObject({ owner_id: IDS.alice, queue_id: null });
  });
});

describe('límites de las vueltas', () => {
  it(`el modelo no puede encadenar herramientas sin fin: ${MAX_TOOL_ROUNDS} vueltas con herramientas y una última sin ellas`, async () => {
    await setup();
    const c = await mkConv({ status: 'pending' });
    await inbound(c.id, 'Hola');
    ai.chatResult = () => ({ toolCalls: [tc('create_task', { title: `Tarea ${++n}` })] });
    await tick();
    const calls = chatCalls();
    expect(calls).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(calls.at(-1)!.request.tools).toBeUndefined();
    expect(calls[0]!.request.tools).toBeDefined();
    expect((await taskRows()).length).toBeLessThanOrEqual(MAX_TOOL_ROUNDS);
  });

  it('solo se atienden las primeras herramientas de cada respuesta', async () => {
    await setup();
    const c = await mkConv({ status: 'pending' });
    await inbound(c.id, 'Hola');
    modelCalls(Array.from({ length: 8 }, (_, i) => tc('update_contact_fields', { ciudad: `Ciudad ${i}` })));
    await tick();
    expect((await toolRows(c.id)).length).toBe(4);
  });
});

describe('simulador de prueba (en seco)', () => {
  it('muestra qué habría hecho el agente con sus herramientas, pero NO escribe nada ni registra llamadas', async () => {
    const id = await setup();
    const c = await mkConv({ status: 'pending' });
    modelCalls([tc('update_contact_fields', { ciudad: 'Guayaquil', edad: 20 }), tc('create_task', { title: 'Llamar', due_in_days: 1 }), tc('transfer_to_person', { reason: 'pide una persona' })], 'Perfecto');
    const r = await call('POST', `/agents/${id}/test`, T.alice, { message: 'Estoy en Guayaquil, llámenme', contact_id: c.contact });
    expect(r.status).toBe(200);
    const body = await json<{ replies: string[]; trace: { tool_calls: Array<{ tool: string; outcome: string; detail: string }> } }>(r);
    expect(body.replies).toEqual(['Perfecto']);
    expect(body.trace.tool_calls.map((t) => `${t.tool}:${t.outcome}`)).toEqual(['update_contact_fields:simulated', 'create_task:simulated', 'transfer_to_person:simulated']);
    expect(body.trace.tool_calls[0]!.detail).toMatch(/guardaría ciudad = Guayaquil/);
    expect(body.trace.tool_calls[0]!.detail).toMatch(/edad \(no tienes permiso/);
    expect(await fieldValues(c.contact)).toEqual({});
    expect(await taskRows()).toHaveLength(0);
    expect(await toolRows(c.id)).toHaveLength(0);
    expect(await aiAudit('contact')).toHaveLength(0);
  });
});

describe('aislamiento A↔B', () => {
  it('las herramientas de la empresa B solo ven y escriben datos de B, y sus llamadas no aparecen en A', async () => {
    await setup();
    // B: su propio campo y agente
    expect((await call('POST', '/custom-fields', T.bob, { name: 'Ciudad', type: 'text' })).status).toBe(201);
    const bId = ((await (await call('POST', '/agents', T.bob, { name: 'Beto' })).json()) as { id: string }).id;
    expect((await call('PATCH', `/agents/${bId}`, T.bob, { personality: 'Amable', objective: 'Ayudar', active: true, capture_fields: ['ciudad'] })).status).toBe(200);
    expect((await call('PUT', `/agents/${bId}/channels`, T.bob, { channel_ids: [channelB] })).status).toBe(200);
    const a = await mkConv({ status: 'pending' });
    const b = await mkConv({ org: ORG_B });
    await inbound(a.id, 'Soy de Quito');
    await inbound(b.id, 'Soy de Cuenca', { org: ORG_B });
    modelCalls([tc('update_contact_fields', { ciudad: 'Cuenca' })]);
    expect(await tick(new Date(), ORG_B)).toBe(1);
    expect(await fieldValues(b.contact)).toEqual({ ciudad: 'Cuenca' });
    expect(await fieldValues(a.contact)).toEqual({});
    expect(await toolRows(a.id)).toHaveLength(0);
    expect((await admin.query(`SELECT organization_id FROM ai_tool_calls`)).rows.map((r) => r.organization_id)).toEqual([ORG_B]);
  });
});
