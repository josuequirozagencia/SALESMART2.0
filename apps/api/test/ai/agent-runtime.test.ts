// M8.5 — Agente de IA en vivo en el Inbox (ADR-53; F17). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/conversations/:id/ai
//   POST /v1/conversations/:id/ai/pause
//   POST /v1/conversations/:id/ai/resume
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AGENT_FRESH_MS, AgentRuntimeService, AI_PROVIDER, AiModule, AiProviderError, asksForPerson, FakeAiProvider, HANDOFF_MESSAGE, KnowledgeProcessorService, MAX_AGENT_TURNS } from '../../src/modules/ai';
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
  await admin.query('TRUNCATE ai_conversation_state, agent_test_runs, agent_channels, agent_documents, agents, document_chunks, knowledge_documents, messages, conversations, contact_phones, contacts, channel_accounts, ai_holds, ai_ledger, ai_wallets, ai_org_pricing, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
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
async function humanReply(conv: string, text = 'Hola, yo te atiendo'): Promise<void> {
  await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at, attempts, next_attempt_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', 'text', $4, 'queued', now(), 0, now())`, [ORG_A, conv, channelA, text]);
}
const messagesOf = async (conv: string) => (await admin.query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sent_at, id`, [conv])).rows as Row[];
const aiMessages = async (conv: string) => (await messagesOf(conv)).filter((m) => m['sender_type'] === 'ai');
const notes = async (conv: string) => (await messagesOf(conv)).filter((m) => m['kind'] === 'note').map((m) => String(m['body']));
const state = async (conv: string) => ((await admin.query(`SELECT * FROM ai_conversation_state WHERE conversation_id = $1`, [conv])).rows[0] ?? null) as Row | null;
const chats = () => ai.calls.filter((c) => c.kind === 'chat');
const ledger = async (org = ORG_A) => (await admin.query(`SELECT * FROM ai_ledger WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Row[];
interface Status { agent: { id: string; name: string } | null; state: string; reason: string | null; can_control: boolean }

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

describe('reglas de pase a una persona (puras)', () => {
  it('detecta cuando el cliente pide una persona, con o sin acentos, y no se confunde con una consulta normal', () => {
    for (const t of ['Quiero hablar con un asesor', 'quiero hablar con una persona', 'pásame con un humano', 'No quiero hablar con un robot', 'comunícame con alguien del equipo', 'asesor', 'Necesito un agente humano']) expect(asksForPerson(t), t).toBe(true);
    for (const t of ['¿A qué hora abren?', 'Cuánto cuesta el corte', 'Mi asesor me dijo que viniera el sábado', 'Hola']) expect(asksForPerson(t), t).toBe(false);
  });
});

describe('atender conversaciones nuevas', () => {
  it('contesta lo que escribe el cliente en una conexión con agente activo: mensaje `ai` en cola, créditos de uso y estado al día; no repite sin mensajes nuevos', async () => {
    const agent = await liveAgent({ docs: true });
    const c = await mkConv();
    await inbound(c.id, '¿Cuál es el horario de atención?');
    expect(await tick()).toBe(1);
    const out = await aiMessages(c.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ direction: 'out', kind: 'text', status: 'queued', body: 'Con gusto te ayudo', sender_type: 'ai' });
    expect(out[0]!['meta']).toMatchObject({ agent_id: agent });
    expect(chats()).toHaveLength(1);
    expect((await ledger()).filter((l) => l['kind'] === 'use').length).toBeGreaterThan(0);
    expect(await state(c.id)).toMatchObject({ status: 'active', reason: null, turns: 1, attempts: 0, unsupported_streak: 0 });
    // sin nada nuevo no hace nada
    expect(await tick()).toBe(0);
    expect(await aiMessages(c.id)).toHaveLength(1);
    // un mensaje nuevo se contesta
    await inbound(c.id, 'Gracias, ¿y el horario de los sábados?');
    expect(await tick(new Date(Date.now() + 5000))).toBe(1);
    expect(await aiMessages(c.id)).toHaveLength(2);
    expect(await state(c.id)).toMatchObject({ turns: 2 });
  });

  it('el historial que ve el modelo incluye lo anterior; las notas internas no llegan al modelo', async () => {
    await liveAgent({ docs: true });
    const c = await mkConv();
    await inbound(c.id, 'Hola, buenas', { at: new Date(Date.now() - 30 * MIN) });
    await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'system', 'note', 'NOTA SECRETA INTERNA', 'internal', now() - interval '20 minutes')`, [ORG_A, c.id, channelA]);
    await state(c.id);
    await inbound(c.id, '¿A qué hora abren?');
    await tick();
    const sent = JSON.stringify(chats()[0]);
    expect(sent).toContain('¿A qué hora abren?');
    expect(sent).not.toContain('NOTA SECRETA');
  });

  it('no contesta: agente apagado, conexión sin agente, conversación finalizada, mensajes de antes de asignar al agente ni mensajes de hace más de una hora', async () => {
    const off = await liveAgent({ docs: false, patch: { active: false } });
    const c1 = await mkConv();
    await inbound(c1.id, 'Hola');
    expect(await tick()).toBe(0);
    await call('PATCH', `/agents/${off}`, T.alice, { active: true });
    // cerrada
    const closed = await mkConv({ status: 'closed' });
    await inbound(closed.id, 'Hola otra vez');
    // vieja
    const stale = await mkConv();
    await inbound(stale.id, 'Mensaje viejo', { at: new Date(Date.now() - AGENT_FRESH_MS - 5 * MIN) });
    // el mensaje de c1 (anterior a activar el agente en la conexión) sí es de ahora: se contesta; los otros no
    const done = await tick();
    expect(done).toBe(1);
    expect(await aiMessages(closed.id)).toHaveLength(0);
    expect(await aiMessages(stale.id)).toHaveLength(0);
    // sin agente en la conexión de B no pasa nada aunque haya mensajes
    const b = await mkConv({ org: ORG_B });
    await inbound(b.id, 'Hola B', { org: ORG_B });
    expect(await tick(new Date(), ORG_B)).toBe(0);
    expect(await aiMessages(b.id)).toHaveLength(0);
  });

  it('los mensajes anteriores a la asignación del agente a la conexión no se contestan', async () => {
    const c = await mkConv();
    await inbound(c.id, 'Hola, estoy esperando', { at: new Date(Date.now() - 2 * MIN) });
    await liveAgent();
    expect(await tick()).toBe(0);
    expect(await aiMessages(c.id)).toHaveLength(0);
  });

  it('en una conversación pendiente de un asesor el agente contesta mientras la persona no haya escrito; una ya aceptada (en trabajo) no la toca', async () => {
    await liveAgent();
    const pending = await mkConv({ status: 'pending' });
    const working = await mkConv({ status: 'working' });
    await inbound(pending.id, 'Hola');
    await inbound(working.id, 'Hola');
    expect(await tick()).toBe(1);
    expect(await aiMessages(pending.id)).toHaveLength(1);
    expect(await aiMessages(working.id)).toHaveLength(0);
  });
});

describe('cuando una persona interviene', () => {
  it('un mensaje de una persona pausa al agente (con nota) y ya no contesta aunque el cliente siga escribiendo', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    await tick();
    expect(await aiMessages(c.id)).toHaveLength(1);
    await humanReply(c.id);
    await inbound(c.id, 'Gracias');
    expect(await tick(new Date(Date.now() + 5000))).toBe(0);
    expect(await state(c.id)).toMatchObject({ status: 'paused', reason: 'human_message' });
    expect(await aiMessages(c.id)).toHaveLength(1);
    expect((await notes(c.id)).join('|')).toMatch(/Sofía/);
    const audit = (await admin.query(`SELECT * FROM audit_logs WHERE entity_id = $1 AND field = 'ai_agent'`, [c.id])).rows as Row[];
    expect(audit.length).toBeGreaterThan(0);
  });

  it('aceptar/tomar la conversación (deja de estar sin asignar o pendiente) también pausa al agente', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    await tick();
    await admin.query(`UPDATE conversations SET status = 'working', owner_id = $2, assigned_at = now() WHERE id = $1`, [c.id, IDS.carol]);
    await inbound(c.id, 'Sigo aquí');
    expect(await tick(new Date(Date.now() + 5000))).toBe(0);
    expect(await state(c.id)).toMatchObject({ status: 'paused', reason: 'human_took' });
    expect(await aiMessages(c.id)).toHaveLength(1);
  });

  it('si una persona escribe mientras el agente piensa, NO se envía la respuesta y el agente se pausa', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    ai.chatReply = () => {
      // la persona responde justo mientras el modelo está generando
      void admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at, attempts, next_attempt_at) VALUES (gen_random_uuid(), $1, $2, $3, 'out', 'human', 'text', 'Yo te atiendo', 'queued', now(), 0, now())`, [ORG_A, c.id, channelA]);
      return 'Respuesta del agente';
    };
    // esperamos a que el insert de la persona se complete antes de que la tarea decida enviar
    const orig = ai.chat.bind(ai);
    ai.chat = async (cred, req) => {
      const r = await orig(cred, req);
      await new Promise((res) => setTimeout(res, 150));
      return r;
    };
    await tick();
    expect(await aiMessages(c.id)).toHaveLength(0);
    expect(await state(c.id)).toMatchObject({ status: 'paused', reason: 'human_message' });
  });
});

describe('pasar a una persona', () => {
  it('si el cliente la pide, se le avisa, el agente se retira (nota «requested») y no llama al modelo', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Quiero hablar con un asesor por favor');
    await tick();
    const out = await aiMessages(c.id);
    expect(out.map((m) => m['body'])).toEqual([HANDOFF_MESSAGE]);
    expect(chats()).toHaveLength(0);
    expect(await state(c.id)).toMatchObject({ status: 'handed_off', reason: 'requested' });
    expect((await notes(c.id)).length).toBe(1);
    // ya no contesta más
    await inbound(c.id, 'Hola?');
    expect(await tick(new Date(Date.now() + 5000))).toBe(0);
  });

  it('con «pasar a una persona» apagado, el agente sigue contestando aunque el cliente la pida', async () => {
    await liveAgent({ patch: { transfer_enabled: false } });
    const c = await mkConv();
    await inbound(c.id, 'Quiero hablar con un asesor');
    await tick();
    expect(chats()).toHaveLength(1);
    expect(await state(c.id)).toMatchObject({ status: 'active' });
  });

  it('un mensaje que no es texto (imagen, audio) pasa a una persona sin responder', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, null, { kind: 'image' });
    await tick();
    expect(await state(c.id)).toMatchObject({ status: 'handed_off', reason: 'unsupported_media' });
    expect(await aiMessages(c.id)).toHaveLength(0);
    expect(chats()).toHaveLength(0);
  });

  it(`al llegar a ${MAX_AGENT_TURNS} respuestas seguidas pasa a una persona`, async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    await tick();
    await admin.query(`UPDATE ai_conversation_state SET turns = $2 WHERE conversation_id = $1`, [c.id, MAX_AGENT_TURNS]);
    await inbound(c.id, 'Una más');
    await tick(new Date(Date.now() + 5000));
    expect(await state(c.id)).toMatchObject({ status: 'handed_off', reason: 'turn_limit' });
    expect(await aiMessages(c.id)).toHaveLength(1);
  });

  it('sin respaldo en los documentos dos veces seguidas pasa a una persona; con respaldo la racha se reinicia', async () => {
    await liveAgent({ docs: true });
    const c = await mkConv();
    await inbound(c.id, 'Cuéntame sobre la garantía de los productos importados');
    await tick();
    expect(await state(c.id)).toMatchObject({ status: 'active', unsupported_streak: 1 });
    await inbound(c.id, 'Y sobre los repuestos de motocicleta');
    await tick(new Date(Date.now() + 5000));
    expect(await state(c.id)).toMatchObject({ status: 'handed_off', reason: 'no_support' });
    expect(await aiMessages(c.id)).toHaveLength(2); // contestó las dos (sin inventar datos) y luego pasó
    // con respaldo se reinicia
    const d = await mkConv();
    await inbound(d.id, 'Cuéntame sobre la garantía de los productos importados');
    await tick(new Date(Date.now() + 10_000));
    await inbound(d.id, 'horario de atención lunes a viernes');
    await tick(new Date(Date.now() + 15_000));
    expect(await state(d.id)).toMatchObject({ status: 'active', unsupported_streak: 0 });
  });
});

describe('créditos y errores de la IA', () => {
  it('sin créditos pausa al agente con su nota y no envía nada', async () => {
    await admin.query(`UPDATE trial_config SET welcome_credits = 0`);
    app.get(OrgDirectoryService).invalidate();
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    await tick();
    expect(await state(c.id)).toMatchObject({ status: 'paused', reason: 'no_credits' });
    expect(await aiMessages(c.id)).toHaveLength(0);
    expect((await notes(c.id)).length).toBe(1);
  });

  it('un fallo pasajero reintenta con espera creciente; la IA sin configurar espera sin gastar intentos; a los 5 fallos pasa a una persona', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    const t0 = new Date();
    ai.failNext(new AiProviderError('ocupado', true));
    await tick(t0);
    let s = (await state(c.id))!;
    expect(s).toMatchObject({ status: 'active', attempts: 1 });
    expect(new Date(s['next_attempt_at'] as string).getTime()).toBeGreaterThan(t0.getTime());
    expect(await aiMessages(c.id)).toHaveLength(0);
    // todavía no toca
    expect(await tick(new Date(t0.getTime() + 1000))).toBe(0);
    // sin clave: no cuenta intento
    ai.requiresCredentials = true;
    await tick(new Date(t0.getTime() + 2 * MIN));
    s = (await state(c.id))!;
    expect(s['attempts']).toBe(1);
    ai.requiresCredentials = false;
    // 4 fallos más → pasa a una persona
    let at = t0.getTime() + 5 * MIN; // todo dentro de la hora de frescura del mensaje
    for (let i = 0; i < 4; i++) {
      ai.failNext(new AiProviderError('ocupado', true));
      await tick(new Date(at));
      at += 5 * MIN;
    }
    expect(await state(c.id)).toMatchObject({ status: 'handed_off', reason: 'ai_error' });
    expect(await aiMessages(c.id)).toHaveLength(0);
  });

  it('un reintento exitoso contesta y deja los intentos en cero', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    const t0 = new Date();
    ai.failNext(new AiProviderError('ocupado', true));
    await tick(t0);
    await tick(new Date(t0.getTime() + 5 * MIN));
    expect(await aiMessages(c.id)).toHaveLength(1);
    expect(await state(c.id)).toMatchObject({ status: 'active', attempts: 0 });
  });
});

describe('concurrencia y aislamiento', () => {
  it('dos pasadas simultáneas no contestan dos veces la misma conversación', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    await Promise.all([tick(), tick(), tick()]);
    expect(await aiMessages(c.id)).toHaveLength(1);
    expect(chats()).toHaveLength(1);
  });

  it('la pasada de una empresa no atiende conversaciones de otra', async () => {
    await liveAgent();
    const bAgent = await liveAgent({ token: T.bob, channel: channelB });
    expect(bAgent).toBeTruthy();
    const a = await mkConv();
    const b = await mkConv({ org: ORG_B });
    await inbound(a.id, 'Hola A');
    await inbound(b.id, 'Hola B', { org: ORG_B });
    expect(await tick(new Date(), ORG_B)).toBe(1);
    expect(await aiMessages(a.id)).toHaveLength(0);
    expect(await aiMessages(b.id)).toHaveLength(1);
    expect((await ledger(ORG_A)).filter((l) => l['kind'] === 'use')).toHaveLength(0);
    expect((await ledger(ORG_B)).filter((l) => l['kind'] === 'use').length).toBeGreaterThan(0);
  });
});

describe('estado, pausar y reanudar desde la bandeja', () => {
  it('GET /conversations/:id/ai: sin sesión 401; otra empresa 404; el asesor sin ver todo no ve una conversación sin asignar (404)', async () => {
    await liveAgent();
    const c = await mkConv();
    expect((await call('GET', `/conversations/${c.id}/ai`)).status).toBe(401);
    expect((await call('GET', `/conversations/${c.id}/ai`, T.bob)).status).toBe(404);
    expect((await call('GET', `/conversations/${c.id}/ai`, T.carol)).status).toBe(404);
    const r = await call('GET', `/conversations/${c.id}/ai`, T.alice);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await json<Status>(r)).toMatchObject({ agent: { name: 'Sofía' }, state: 'active', reason: null, can_control: true });
  });

  it('una conversación en manos de una persona sin que el agente haya intervenido figura «idle»; sin agente en la conexión, sin control', async () => {
    const c = await mkConv({ status: 'working' });
    expect(await json<Status>(await call('GET', `/conversations/${c.id}/ai`, T.alice))).toMatchObject({ agent: null, state: 'idle', can_control: false });
    await liveAgent();
    expect(await json<Status>(await call('GET', `/conversations/${c.id}/ai`, T.alice))).toMatchObject({ state: 'idle', can_control: true });
  });

  it('pausar a mano: el agente deja de contestar y queda nota y auditoría; pausar de nuevo no duplica', async () => {
    await liveAgent();
    const c = await mkConv({ status: 'pending' });
    const r = await call('POST', `/conversations/${c.id}/ai/pause`, T.carol);
    expect(r.status).toBe(200);
    expect(await json<Status>(r)).toMatchObject({ state: 'paused', reason: 'manual' });
    await inbound(c.id, 'Hola');
    expect(await tick()).toBe(0);
    expect(await aiMessages(c.id)).toHaveLength(0);
    const n = (await notes(c.id)).length;
    await call('POST', `/conversations/${c.id}/ai/pause`, T.carol);
    expect((await notes(c.id)).length).toBe(n);
    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND field = 'ai_agent'`, [c.id])).rows.length).toBe(1);
  });

  it('reanudar: contesta solo lo que el cliente escriba desde ahora, no lo anterior; reinicia contadores', async () => {
    await liveAgent();
    const c = await mkConv({ status: 'pending' });
    await inbound(c.id, 'Mensaje de antes', { at: new Date(Date.now() - 2 * MIN) });
    await call('POST', `/conversations/${c.id}/ai/pause`, T.alice);
    await admin.query(`UPDATE ai_conversation_state SET turns = 7, unsupported_streak = 1 WHERE conversation_id = $1`, [c.id]);
    const r = await call('POST', `/conversations/${c.id}/ai/resume`, T.alice);
    expect(r.status).toBe(200);
    expect(await json<Status>(r)).toMatchObject({ state: 'active', reason: null });
    expect(await state(c.id)).toMatchObject({ turns: 0, unsupported_streak: 0, attempts: 0 });
    expect(await tick()).toBe(0); // lo de antes no se contesta
    await inbound(c.id, 'Ahora sí, hola', { at: new Date(Date.now() + 1000) });
    expect(await tick(new Date(Date.now() + 5000))).toBe(1);
    expect(await aiMessages(c.id)).toHaveLength(1);
  });

  it('reanudar tras un mensaje de una persona: solo cuentan los mensajes humanos posteriores a la reanudación', async () => {
    await liveAgent();
    const c = await mkConv();
    await inbound(c.id, 'Hola');
    await tick();
    await humanReply(c.id);
    await tick(new Date(Date.now() + 2000));
    expect(await state(c.id)).toMatchObject({ status: 'paused', reason: 'human_message' });
    await call('POST', `/conversations/${c.id}/ai/resume`, T.alice);
    await inbound(c.id, 'Otra pregunta', { at: new Date(Date.now() + 3000) });
    expect(await tick(new Date(Date.now() + 8000))).toBe(1);
    expect(await state(c.id)).toMatchObject({ status: 'active' });
    expect(await aiMessages(c.id)).toHaveLength(2);
  });

  it('409 sin agente en la conexión o con la conversación finalizada; 404 de otra empresa; sin permiso de responder, 403', async () => {
    const c = await mkConv({ status: 'pending' });
    expect((await call('POST', `/conversations/${c.id}/ai/pause`, T.alice)).status).toBe(409);
    expect((await call('POST', `/conversations/${c.id}/ai/resume`, T.alice)).status).toBe(409);
    await liveAgent();
    expect((await call('POST', `/conversations/${c.id}/ai/pause`, T.bob)).status).toBe(404);
    expect((await call('POST', `/conversations/${c.id}/ai/resume`, T.bob)).status).toBe(404);
    const closed = await mkConv({ status: 'closed' });
    expect((await call('POST', `/conversations/${closed.id}/ai/pause`, T.alice)).status).toBe(409);
    expect((await call('POST', `/conversations/${c.id}/ai/pause`)).status).toBe(401);
  });
});
