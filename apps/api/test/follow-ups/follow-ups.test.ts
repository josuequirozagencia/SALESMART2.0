// v11 S5 — Seguimientos automáticos del agente (ADR-68). Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   GET /v1/agents/:id/follow-ups
//   PUT /v1/agents/:id/follow-ups
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AgentRuntimeService, AI_PROVIDER, AiModule, AiProviderError, FakeAiProvider, KnowledgeProcessorService } from '../../src/modules/ai';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { FollowUpRunnerService, FollowUpsModule } from '../../src/modules/follow-ups';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { AiModelPricesService, AiPricingService } from '../../src/modules/platform';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, AiModule, FollowUpsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
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
  await admin.query('TRUNCATE agent_follow_up_runs, agent_follow_up_steps, agent_follow_ups, automations, ai_conversation_state, agent_test_runs, agent_channels, agent_documents, agents, document_chunks, knowledge_documents, messages, conversations, contact_phones, contacts, channel_accounts, ai_holds, ai_ledger, ai_wallets, ai_org_pricing, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
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
// Igual que la tarea periódica real (agent-runtime.job.ts): SIN persona en el contexto. Con una persona (userId) un fallo de producción quedaba escondido: el agente no podía leer al contacto («No tienes permiso»).
const tick = (at: Date = new Date(), org = ORG_A) => TenantContext.run({ organizationId: org }, () => runtime().runDue(at));

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
async function humanReply(conv: string, text = 'Hola, yo te atiendo'): Promise<void> {
  await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at, attempts, next_attempt_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', 'text', $4, 'queued', now(), 0, now())`, [ORG_A, conv, channelA, text]);
}
const messagesOf = async (conv: string) => (await admin.query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sent_at, id`, [conv])).rows as Row[];
const aiMessages = async (conv: string) => (await messagesOf(conv)).filter((m) => m['sender_type'] === 'ai');
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
  ai.requiresCredentials = false;
  ai.tokensPerInput = null;
  ai.chatReply = () => 'Con gusto te ayudo';
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
});


const MINUTE = 60_000;
const runner = () => app.get(FollowUpRunnerService);
/** Una pasada del motor de seguimientos «en» ese instante. */
const followTick = (at: Date, org = ORG_A) => TenantContext.run({ organizationId: org }, () => runner().runDue(at));
const put = (agent: string, body: unknown, token = T.alice) => call('PUT', `/agents/${agent}/follow-ups`, token, body);
const getCfg = (agent: string, token = T.alice) => call('GET', `/agents/${agent}/follow-ups`, token);
const runs = async () => (await admin.query(`SELECT * FROM agent_follow_up_runs ORDER BY created_at, step_position`)).rows as Row[];
const outMsgs = async (conv: string) => (await messagesOf(conv)).filter((m) => m['direction'] === 'out' && m['kind'] === 'text');
const SEQ = { enabled: true, steps: [{ delay_minutes: 5, mode: 'ai' }, { delay_minutes: 60, mode: 'fixed_text', fixed_text: 'Hola {{primer_nombre}}, soy {{mi_nombre}}. ¿Sigues interesado?' }] };
interface Cfg { enabled: boolean; steps: Array<{ position: number; delay_minutes: number; mode: string; fixed_text: string | null; start_automation_id: string | null }>; variables: string[]; automations: Array<{ id: string; name: string }>; summary: { sent: number; skipped: number; cancelled: number; pending: number; reasons: Record<string, number> } }

/** El agente atiende y contesta el primer mensaje del cliente (así arma el paso 1). */
async function armed(over: { cfg?: unknown; agentPatch?: Record<string, unknown> } = {}): Promise<{ agent: string; conv: string; contact: string }> {
  const agent = await liveAgent({ ...(over.agentPatch ? { patch: over.agentPatch } : {}) });
  expect((await put(agent, over.cfg ?? SEQ)).status).toBe(200);
  const c = await mkConv();
  await inbound(c.id, '¿Tienen cita mañana?');
  expect(await tick()).toBe(1);
  expect((await aiMessages(c.id)).length).toBe(1);
  return { agent, conv: c.id, contact: c.contact };
}

describe('configuración de los seguimientos (GET y PUT)', () => {
  it('por omisión está apagado y sin pasos; trae las variables permitidas y las automatizaciones activas', async () => {
    const agent = await liveAgent();
    const r = await getCfg(agent);
    expect(r.status).toBe(200);
    const v = await json<Cfg>(r);
    expect(v).toMatchObject({ enabled: false, steps: [], variables: ['primer_nombre', 'nombre', 'mi_nombre'], automations: [] });
    expect(v.summary).toMatchObject({ sent: 0, skipped: 0, cancelled: 0, pending: 0 });
  });

  it('guarda la secuencia entera, la devuelve en orden y deja auditoría SIN el texto', async () => {
    const agent = await liveAgent();
    const r = await put(agent, SEQ);
    expect(r.status).toBe(200);
    const v = await json<Cfg>(r);
    expect(v.enabled).toBe(true);
    expect(v.steps).toEqual([
      { position: 1, delay_minutes: 5, mode: 'ai', fixed_text: null, start_automation_id: null },
      { position: 2, delay_minutes: 60, mode: 'fixed_text', fixed_text: 'Hola {{primer_nombre}}, soy {{mi_nombre}}. ¿Sigues interesado?', start_automation_id: null },
    ]);
    // reemplazar: queda solo lo nuevo
    const v2 = await json<Cfg>(await put(agent, { enabled: false, steps: [{ delay_minutes: 15, mode: 'ai' }] }));
    expect(v2).toMatchObject({ enabled: false, steps: [{ position: 1, delay_minutes: 15 }] });
    expect(v2.steps).toHaveLength(1);
    const audit = (await admin.query(`SELECT old_value, new_value FROM audit_logs WHERE field = 'follow_ups' ORDER BY at, id`)).rows as Row[];
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('Sigues interesado');
  });

  it('valida en el servidor: hasta 5 pasos, de 5 minutos a 7 días, texto obligatorio con solo las variables permitidas y automatizaciones que existan', async () => {
    const agent = await liveAgent();
    const step = { delay_minutes: 10, mode: 'ai' };
    const bad: Array<[string, unknown]> = [
      ['6 pasos', { enabled: true, steps: Array.from({ length: 6 }, () => step) }],
      ['menos de 5 min', { enabled: true, steps: [{ delay_minutes: 4, mode: 'ai' }] }],
      ['más de 7 días', { enabled: true, steps: [{ delay_minutes: 10_081, mode: 'ai' }] }],
      ['texto fijo sin texto', { enabled: true, steps: [{ delay_minutes: 10, mode: 'fixed_text' }] }],
      ['texto con IA', { enabled: true, steps: [{ delay_minutes: 10, mode: 'ai', fixed_text: 'hola' }] }],
      ['sin mensaje ni automatización', { enabled: true, steps: [{ delay_minutes: 10, mode: 'none' }] }],
      ['variable no permitida', { enabled: true, steps: [{ delay_minutes: 10, mode: 'fixed_text', fixed_text: 'Tu número {{telefono}}' }] }],
      ['campo personalizado', { enabled: true, steps: [{ delay_minutes: 10, mode: 'fixed_text', fixed_text: 'Hola {{contact.ciudad}}' }] }],
      ['automatización inexistente', { enabled: true, steps: [{ delay_minutes: 10, mode: 'none', start_automation_id: '00000000-0000-4000-8000-000000000001' }] }],
      ['campo desconocido', { enabled: true, steps: [{ delay_minutes: 10, mode: 'ai', nope: 1 }] }],
    ];
    for (const [name, body] of bad) expect((await put(agent, body)).status, name).toBe(400);
    expect((await put(agent, { enabled: true, steps: Array.from({ length: 5 }, () => step) })).status).toBe(200);
  });

  it('solo el administrador de la empresa: la asesora recibe 403, sin sesión 401 y un agente de otra empresa 404', async () => {
    const agent = await liveAgent();
    expect((await getCfg(agent, T.carol)).status).toBe(403);
    expect((await put(agent, SEQ, T.carol)).status).toBe(403);
    expect((await call('GET', `/agents/${agent}/follow-ups`)).status).toBe(401);
    expect((await getCfg(agent, T.bob)).status).toBe(404);
    expect((await put(agent, SEQ, T.bob)).status).toBe(404);
    expect((await getCfg('00000000-0000-4000-8000-000000000001')).status).toBe(404);
    expect(await runs()).toEqual([]);
  });
});

describe('la cadena de seguimientos', () => {
  it('cuando el agente responde se programa el paso 1; llega su hora y la IA lo envía como mensaje «ai» (no humano), con nota interna, crédito «follow_up» y el paso 2 armado desde ese envío', async () => {
    const { agent, conv } = await armed();
    const r1 = await runs();
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ agent_id: agent, conversation_id: conv, step_position: 1, status: 'pending' });
    const t0 = new Date();
    // todavía no toca
    expect(await followTick(new Date(t0.getTime() + 2 * MINUTE))).toBe(0);
    expect(await outMsgs(conv)).toHaveLength(1);
    // toca el paso 1
    const t1 = new Date(t0.getTime() + 6 * MINUTE);
    expect(await followTick(t1)).toBe(1);
    const out = await outMsgs(conv);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ sender_type: 'ai', status: 'queued', body: 'Con gusto te ayudo' });
    expect(out[1]!['meta']).toMatchObject({ agent_id: agent, follow_up: 1 });
    expect((await ledger()).some((l) => l['kind'] === 'follow_up')).toBe(true);
    expect((await messagesOf(conv)).some((m) => m['kind'] === 'note' && String(m['body']).includes('Seguimiento 1 enviado por el agente Sofía'))).toBe(true);
    const r2 = await runs();
    expect(r2.map((x) => [x['step_position'], x['status']])).toEqual([[1, 'sent'], [2, 'pending']]);
    // el paso 2 (texto fijo con variables) sale 60 min después del envío del paso 1
    expect(await followTick(new Date(t1.getTime() + 30 * MINUTE))).toBe(0);
    expect(await followTick(new Date(t1.getTime() + 61 * MINUTE))).toBe(1);
    const out2 = await outMsgs(conv);
    expect(out2).toHaveLength(3);
    expect(String(out2[2]!['body'])).toBe('Hola Cliente, soy Sofía. ¿Sigues interesado?');
    expect((await runs()).map((x) => [x['step_position'], x['status']])).toEqual([[1, 'sent'], [2, 'sent']]);
    // no cuenta como respuesta humana
    expect((await messagesOf(conv)).filter((m) => m['sender_type'] === 'human')).toEqual([]);
    // fin de la secuencia: nada más
    expect(await followTick(new Date(t1.getTime() + 600 * MINUTE))).toBe(0);
  });

  it('el cliente responde antes de que toque: el paso se cancela («client_replied») y no se arma otro', async () => {
    const { conv } = await armed();
    await inbound(conv, 'Sí, mañana a las 10', { at: new Date(Date.now() + 1000) });
    await admin.query(`UPDATE conversations SET last_inbound_at = now() + interval '1 second' WHERE id = $1`, [conv]);
    expect(await followTick(new Date(Date.now() + 10 * MINUTE))).toBe(1);
    expect((await runs()).map((x) => [x['step_position'], x['status'], x['reason']])).toEqual([[1, 'cancelled', 'client_replied']]);
    expect(await outMsgs(conv)).toHaveLength(1);
  });

  it('una persona que escribe, que pausa al agente, que finaliza o que cambia el dueño cancela el paso con su motivo', async () => {
    const cases: Array<[string, string, (conv: string) => Promise<void>]> = [
      ['human_intervened', 'persona escribe', async (c) => { await humanReply(c, 'Hola, yo te atiendo'); }],
      ['agent_stopped', 'pausa al agente', async (c) => { expect((await call('POST', `/conversations/${c}/ai/pause`, T.alice)).status).toBe(200); }],
      ['conversation_closed', 'finaliza', async (c) => { await admin.query(`UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [c]); }],
      ['owner_changed', 'cambia el dueño', async (c) => { await admin.query(`UPDATE conversations SET owner_id = $2, assigned_at = now(), status = 'working' WHERE id = $1`, [c, IDS.alice]); }],
      ['consent_revoked', 'revoca consentimiento', async (c) => { await admin.query(`UPDATE contacts SET consent = 'revoked' WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [c]); }],
    ];
    for (const [reason, label, act] of cases) {
      await seed();
      app.get(OrgDirectoryService).invalidate();
      T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
      const { conv } = await armed();
      await act(conv);
      const before = (await outMsgs(conv)).length;
      expect(await followTick(new Date(Date.now() + 10 * MINUTE)), label).toBe(1);
      expect((await runs()).map((x) => [x['status'], x['reason']]), label).toEqual([['cancelled', reason]]);
      expect((await outMsgs(conv)).length, label).toBe(before);
    }
  }, 120_000);

  it('apagar el escenario, quitar el paso o apagar al agente cancela lo que estaba programado', async () => {
    const a = await armed();
    expect((await put(a.agent, { enabled: false, steps: SEQ.steps })).status).toBe(200);
    expect(await followTick(new Date(Date.now() + 10 * MINUTE))).toBe(1);
    expect((await runs()).map((x) => x['reason'])).toEqual(['disabled']);
    await seed();
    app.get(OrgDirectoryService).invalidate();
    T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
    const b = await armed();
    expect((await put(b.agent, { enabled: true, steps: [] })).status).toBe(200);
    expect(await followTick(new Date(Date.now() + 10 * MINUTE))).toBe(1);
    expect((await runs()).map((x) => x['reason'])).toEqual(['step_removed']);
    await seed();
    app.get(OrgDirectoryService).invalidate();
    T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
    const c = await armed();
    expect((await call('PATCH', `/agents/${c.agent}`, T.alice, { active: false })).status).toBe(200);
    expect(await followTick(new Date(Date.now() + 10 * MINUTE))).toBe(1);
    expect((await runs()).map((x) => x['reason'])).toEqual(['agent_unavailable']);
  });

  it('fuera de las 24 h de WhatsApp oficial no se envía texto libre: el paso se omite («window_closed») y la cadena termina', async () => {
    const { conv } = await armed();
    expect(await followTick(new Date(Date.now() + 30 * 3_600_000))).toBe(1);
    expect((await runs()).map((x) => [x['step_position'], x['status'], x['reason']])).toEqual([[1, 'skipped', 'window_closed']]);
    expect(await outMsgs(conv)).toHaveLength(1);
  });

  it('sin créditos el paso se omite («no_credits»), no se cobra nada, la cadena termina y el agente NO se pausa', async () => {
    const { conv } = await armed();
    await admin.query(`UPDATE ai_wallets SET balance_cache = 0 WHERE organization_id = $1`, [ORG_A]);
    expect(await followTick(new Date(Date.now() + 10 * MINUTE))).toBe(1);
    expect((await runs()).map((x) => [x['status'], x['reason']])).toEqual([['skipped', 'no_credits']]);
    expect((await ledger()).filter((l) => l['kind'] === 'follow_up')).toEqual([]);
    expect(await state(conv)).toMatchObject({ status: 'active' });
  });

  it('el tope de 200 envíos de seguimiento al día por empresa: llegado, el paso se omite («daily_limit»)', async () => {
    const { agent, conv } = await armed();
    await admin.query(`INSERT INTO agent_follow_up_runs(id, organization_id, agent_id, conversation_id, chain_inbound_at, anchor_at, step_position, due_at, status, processed_at) SELECT gen_random_uuid(), $1, $2, $3, now() - (g || ' days')::interval - interval '30 days', now(), 1, now(), 'sent', now() FROM generate_series(1, 200) g`, [ORG_A, agent, conv]);
    expect(await followTick(new Date(Date.now() + 10 * MINUTE))).toBe(1);
    const mine = (await runs()).find((x) => x['status'] === 'skipped');
    expect(mine).toMatchObject({ reason: 'daily_limit' });
  });

  it('un mensaje del cliente gana UNA cadena: terminada la secuencia no se rearma sola, y tras otro mensaje del cliente con respuesta del agente nace una nueva (la anterior pendiente queda reemplazada)', async () => {
    const { conv } = await armed({ cfg: { enabled: true, steps: [{ delay_minutes: 5, mode: 'fixed_text', fixed_text: 'Seguimos por aquí' }] } });
    const t1 = new Date(Date.now() + 6 * MINUTE);
    expect(await followTick(t1)).toBe(1);
    expect((await runs()).map((x) => x['status'])).toEqual(['sent']);
    // otra respuesta del agente al MISMO mensaje del cliente no arma otra cadena
    await tick(new Date(t1.getTime() + MINUTE));
    expect(await runs()).toHaveLength(1);
    // el cliente vuelve a escribir y el agente contesta: cadena nueva
    await admin.query(`UPDATE ai_conversation_state SET unsupported_streak = 0 WHERE conversation_id = $1`, [conv]); // el agente de prueba no tiene documentos: sin esto, dos respuestas «sin respaldo» lo pasan a una persona
    await inbound(conv, 'Una duda más', { at: new Date(Date.now() + 30_000) });
    await admin.query(`UPDATE conversations SET last_inbound_at = now() + interval '30 seconds' WHERE id = $1`, [conv]);
    expect(await tick(new Date(Date.now() + 40_000))).toBe(1);
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all.map((x) => x['status'])).toEqual(['sent', 'pending']);
    // y solo hay UN paso pendiente por conversación (índice único parcial)
    await expect(admin.query(`INSERT INTO agent_follow_up_runs(id, organization_id, agent_id, conversation_id, chain_inbound_at, anchor_at, step_position, due_at, status) SELECT gen_random_uuid(), organization_id, agent_id, conversation_id, now(), now(), 1, now(), 'pending' FROM agent_follow_up_runs WHERE status = 'pending' LIMIT 1`)).rejects.toThrow(/agent_follow_up_runs_one_pending_uq/);
  });

  it('un paso puede iniciar una automatización activa de la empresa (sin mensaje); si no está activa, queda dicho en la nota y el seguimiento igual se resuelve', async () => {
    const agent = await liveAgent();
    const created = await call('POST', '/automations', T.alice, { name: 'Bienvenida', trigger: { type: 'contact_created', filter: {} }, conditions: [], actions: [{ type: 'create_task', title: 'Llamar al cliente', due_in_hours: 24, assignee: 'owner' }] });
    expect(created.status).toBe(201);
    const autoId = (await json<{ id: string }>(created)).id;
    expect((await call('POST', `/automations/${autoId}/activate`, T.alice)).status).toBe(200);
    expect(((await json<Cfg>(await getCfg(agent))).automations).map((a) => a.id)).toEqual([autoId]);
    expect((await put(agent, { enabled: true, steps: [{ delay_minutes: 5, mode: 'none', start_automation_id: autoId }] })).status).toBe(200);
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    expect(await tick()).toBe(1);
    expect(await followTick(new Date(Date.now() + 6 * MINUTE))).toBe(1);
    expect((await runs()).map((x) => [x['status'], x['reason']])).toEqual([['sent', null]]);
    expect(await outMsgs(c.id)).toHaveLength(1); // solo la respuesta del agente: el paso no mandó mensaje
    expect((await admin.query(`SELECT 1 FROM automation_runs WHERE automation_id = $1`, [autoId])).rows).toHaveLength(1);
    expect((await messagesOf(c.id)).some((m) => m['kind'] === 'note' && String(m['body']).includes('se inició «Bienvenida»'))).toBe(true);
  });

  it('aislamiento A↔B: la pasada de la empresa B no toca lo de A', async () => {
    const { conv } = await armed();
    expect(await followTick(new Date(Date.now() + 10 * MINUTE), ORG_B)).toBe(0);
    expect((await runs()).map((x) => x['status'])).toEqual(['pending']);
    expect(await outMsgs(conv)).toHaveLength(1);
    expect(await followTick(new Date(Date.now() + 10 * MINUTE), ORG_A)).toBe(1);
  });

  it('si el modelo falla de forma pasajera el paso se reintenta; si falla de otro modo se omite («ai_unavailable») y sigue el siguiente', async () => {
    await armed();
    ai.failNext(new AiProviderError('boom', false));
    const t = new Date(Date.now() + 6 * MINUTE);
    expect(await followTick(t)).toBe(1);
    const r = await runs();
    expect(r.map((x) => [x['step_position'], x['status'], x['reason']])).toEqual([[1, 'skipped', 'ai_unavailable'], [2, 'pending', null]]);
  });
});
