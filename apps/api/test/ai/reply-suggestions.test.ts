// v11 S4 — Sugerencia de respuesta para la persona que atiende (ADR-61). Ruta cubierta (el registro de endpoints exige que este archivo la escriba tal cual):
//   POST /v1/conversations/:id/ai/suggest
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AI_PROVIDER, AiModule, AiProviderError, FakeAiProvider, KnowledgeProcessorService } from '../../src/modules/ai';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { AiLimitsService, AiModelPricesService, AiPricingService } from '../../src/modules/platform';
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
const MIN = 60_000;

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
  await admin.query('TRUNCATE ai_suggestion_runs, ai_conversation_state, agent_test_runs, agent_channels, agent_documents, agents, document_chunks, knowledge_documents, messages, conversations, contact_phones, contacts, channel_accounts, ai_holds, ai_ledger, ai_wallets, ai_org_pricing, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
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
const state = async (conv: string) => ((await admin.query(`SELECT * FROM ai_conversation_state WHERE conversation_id = $1`, [conv])).rows[0] ?? null) as Row | null;
const chats = () => ai.calls.filter((c) => c.kind === 'chat');
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
  await admin.query('UPDATE ai_limits SET tests_per_day = 100, suggestions_per_day = 50, follow_ups_per_day = 200');
  app.get(AiLimitsService).invalidate();
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


const suggest = (token: string | undefined, conv: string) => call('POST', `/conversations/${conv}/ai/suggest`, token);
interface Suggestion { text: string; agent: { id: string; name: string }; credits_used: number; remaining_today: number }
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const runs = async () => (await admin.query(`SELECT * FROM ai_suggestion_runs ORDER BY created_at`)).rows as Row[];
const internalNote = (conv: string, text: string) =>
  admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'system', 'note', $4, 'internal', now())`, [ORG_A, conv, channelA, text]);

describe('sugerir una respuesta (v11 S4)', () => {
  it('con las sugerencias activadas devuelve un borrador, gasta créditos de tipo «suggest», guarda solo metadatos y NO envía nada', async () => {
    const agent = await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, '¿A qué hora abren?');
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBe(200);
    const s = await json<Suggestion>(r);
    expect(s).toMatchObject({ text: 'Con gusto te ayudo', agent: { id: agent, name: 'Sofía' }, remaining_today: 49 });
    expect(s.credits_used).toBeGreaterThan(0);
    // no se envió nada: ningún mensaje saliente nuevo
    expect((await messagesOf(c.id)).filter((m) => m['direction'] === 'out')).toEqual([]);
    // créditos: movimientos de tipo suggest
    expect((await ledger()).filter((l) => l['kind'] === 'suggest').length).toBeGreaterThan(0);
    expect((await ledger()).filter((l) => l['kind'] === 'use')).toEqual([]);
    // metadatos sin texto
    const rs = await runs();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ organization_id: ORG_A, agent_id: agent, conversation_id: c.id, user_id: IDS.carol });
    expect(Object.keys(rs[0]!).filter((k) => /text|body|content|message/.test(k))).toEqual([]);
    // el agente no cambió: no hay estado del agente en esa conversación
    expect(await state(c.id)).toBeNull();
    // se llamó al modelo SIN herramientas
    expect(chats()).toHaveLength(1);
    expect(chats()[0]!.kind === 'chat' ? chats()[0]!.request.tools ?? [] : null).toEqual([]);
  });

  it('funciona con el agente pausado y no lo reanuda ni lo pausa', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola, ¿tienen cita?');
    expect((await call('POST', `/conversations/${c.id}/ai/pause`, T.carol)).status).toBe(200);
    const before = await state(c.id);
    expect(before).toMatchObject({ status: 'paused', reason: 'manual' });
    expect((await suggest(T.carol, c.id)).status).toBe(200);
    expect(await state(c.id)).toMatchObject({ status: 'paused', reason: 'manual' });
  });

  it('por omisión está apagado: 409 SUGGESTIONS_DISABLED, sin llamar al modelo ni gastar créditos', async () => {
    await liveAgent();
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola');
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('SUGGESTIONS_DISABLED');
    expect(chats()).toHaveLength(0);
    expect(await ledger()).toEqual([]);
    expect(await runs()).toEqual([]);
  });

  it('sin agente en la conexión: 409 NO_AGENT', async () => {
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola');
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('NO_AGENT');
  });

  it('las notas internas NO entran al contexto del modelo, y lo que contesta es lo último que escribió el cliente', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Primera pregunta', { at: new Date(Date.now() - 5 * MIN) });
    await humanReply(c.id, 'Respuesta de una persona');
    await internalNote(c.id, 'SECRETO-INTERNO no debe salir');
    await inbound(c.id, '¿Y el precio del corte?', { at: new Date(Date.now() + 2000) }); // la respuesta humana se fecha con el reloj de la base: la pregunta va claramente después
    expect((await suggest(T.carol, c.id)).status).toBe(200);
    const req = chats()[0]!.kind === 'chat' ? chats()[0]!.request : null;
    const all = JSON.stringify(req?.messages ?? []);
    expect(all).not.toContain('SECRETO-INTERNO');
    expect(all).toContain('¿Y el precio del corte?');
    expect(all).toContain('Respuesta de una persona');
  });

  it('sin un mensaje del cliente sin responder: 409 NOTHING_TO_ANSWER', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola', { at: new Date(Date.now() - 5 * MIN) });
    await humanReply(c.id, 'Hola, ¿en qué te ayudo?');
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('NOTHING_TO_ANSWER');
    expect(chats()).toHaveLength(0);
  });

  it('solo quien puede responder esa conversación la pide: una ajena es 404, una finalizada 409 y sin sesión 401', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const others = await mkConv({ status: 'working', owner: IDS.alice });
    const closed = await mkConv({ status: 'closed', owner: IDS.carol });
    await inbound(others.id, 'Hola');
    await inbound(closed.id, 'Hola');
    expect((await suggest(T.carol, others.id)).status).toBe(404); // de otra persona: no la ve
    expect((await suggest(T.carol, '00000000-0000-4000-8000-000000000001')).status).toBe(404);
    const rc = await suggest(T.carol, closed.id);
    expect(rc.status).toBe(409);
    expect(await code(rc)).toBe('CONVERSATION_CLOSED');
    expect((await suggest(undefined, others.id)).status).toBe(401);
    expect(chats()).toHaveLength(0);
    expect(await runs()).toEqual([]);
  });

  it('fuera de las 24 h de WhatsApp oficial no se ofrece: 409 WINDOW_CLOSED', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola', { at: new Date(Date.now() - 30 * 3_600_000) });
    await admin.query(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [c.id]);
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('WINDOW_CLOSED');
    expect(chats()).toHaveLength(0);
  });

  it('sin créditos: 409 AI_NO_CREDITS, sin sugerencia ni registro', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    await admin.query(`INSERT INTO ai_wallets(id, organization_id, balance_cache) VALUES (gen_random_uuid(), $1, 0) ON CONFLICT DO NOTHING`, [ORG_A]).catch(() => undefined);
    await admin.query(`UPDATE ai_wallets SET balance_cache = 0 WHERE organization_id = $1`, [ORG_A]);
    await admin.query(`UPDATE trial_config SET welcome_credits = 0`);
    app.get(OrgDirectoryService).invalidate();
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola');
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('AI_NO_CREDITS');
    expect(await runs()).toEqual([]);
  });

  it('si el modelo falla no se cobra ni se registra y el error se explica', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola');
    ai.failNext(new AiProviderError('boom', false));
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect((await ledger()).filter((l) => l['kind'] === 'suggest')).toEqual([]);
    expect(await runs()).toEqual([]);
  });

  it('el tope de 50 al día por empresa: la 51.ª da 409 SUGGESTION_LIMIT sin gastar nada más', async () => {
    const agent = await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola');
    await admin.query(`INSERT INTO ai_suggestion_runs(id, organization_id, agent_id, conversation_id, user_id, grounded) SELECT gen_random_uuid(), $1, $2, $3, $4, false FROM generate_series(1, 50)`, [ORG_A, agent, c.id, IDS.carol]);
    const r = await suggest(T.carol, c.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('SUGGESTION_LIMIT');
    expect(chats()).toHaveLength(0);
    // las de hace más de 24 h no cuentan
    await admin.query(`UPDATE ai_suggestion_runs SET created_at = now() - interval '25 hours'`);
    expect((await suggest(T.carol, c.id)).status).toBe(200);
  });

  it('el Súper Admin puede cambiar el tope de sugerencias: con 2 la tercera da 409 con el número nuevo en el mensaje', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(c.id, 'Hola');
    await admin.query('UPDATE ai_limits SET suggestions_per_day = 2');
    app.get(AiLimitsService).invalidate();
    const first = await suggest(T.carol, c.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ remaining_today: 1 });
    expect((await suggest(T.carol, c.id)).status).toBe(200);
    const over = await suggest(T.carol, c.id);
    expect(over.status).toBe(409);
    expect(await json(over)).toMatchObject({ error: { code: 'SUGGESTION_LIMIT', message: expect.stringContaining('máximo de 2') } });
  });

  it('aislamiento A↔B: la empresa B no puede pedir sugerencias de una conversación de A (404) y sus límites y registros son aparte', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const a = await mkConv({ status: 'working', owner: IDS.carol });
    await inbound(a.id, 'Hola');
    expect((await suggest(T.bob, a.id)).status).toBe(404);
    expect(chats()).toHaveLength(0);
    expect(await runs()).toEqual([]);
    expect((await suggest(T.carol, a.id)).status).toBe(200);
    const rs = await runs();
    expect(rs.every((x) => x['organization_id'] === ORG_A)).toBe(true);
  });

  it('el estado del agente (GET /ai) dice si las sugerencias están activadas', async () => {
    await liveAgent({ patch: { suggestions_enabled: true } });
    const c = await mkConv({ status: 'working', owner: IDS.carol });
    const r = await call('GET', `/conversations/${c.id}/ai`, T.carol);
    expect((await json<{ agent: { suggestions_enabled: boolean } }>(r)).agent.suggestions_enabled).toBe(true);
  });
});
