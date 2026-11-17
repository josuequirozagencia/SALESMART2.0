// v17 · 17.1 — Campañas masivas: modelo, permisos y audiencia, SIN enviar (ADR-72). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/campaigns/access
//   GET /v1/campaigns/settings
//   PUT /v1/campaigns/settings
//   POST /v1/campaigns/:id/launch
//   POST /v1/campaigns/:id/pause
//   POST /v1/campaigns/:id/resume
//   POST /v1/campaigns/:id/cancel
//   GET /v1/campaigns/options
//   GET /v1/campaigns/channels/:channelId/templates
//   POST /v1/campaigns/preview
//   POST /v1/campaigns/audience
//   GET /v1/campaigns/advisor-limits
//   PUT /v1/campaigns/advisor-limits/:userId
//   POST /v1/campaigns
//   GET /v1/campaigns
//   GET /v1/campaigns/:id
//   PATCH /v1/campaigns/:id
//   POST /v1/campaigns/:id/duplicate
//   GET /v1/campaigns/:id/preview
//   GET /v1/campaigns/summary
//   GET /v1/campaigns/:id/results
//   POST /v1/campaigns/:id/export
//   POST /v1/campaigns/variants
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { AI_PROVIDER, AiProviderError, FakeAiProvider } from '../../src/modules/ai';
import { CampaignResponsesService, CampaignSenderService, CampaignsModule } from '../../src/modules/campaigns';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { ConversationsModule, ConversationsService, type NormalizedMessage } from '../../src/modules/conversations';
import { OrganizationsModule } from '../../src/modules/organizations';
import { TemplatesModule } from '../../src/modules/templates';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ConversationsModule, ChannelsModule, TemplatesModule, CampaignsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A con campañas (se le conceden)
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A SIN campañas
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob' | 'root', string>;
let officialA = '';
let officialB = '';
let qrAdmin = ''; // chip QR creado por la administradora
let qrCarol = ''; // chip QR creado por Carolina
let tplA = '';
let tplB = '';
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'AI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', AI_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ai_holds, ai_ledger, ai_wallets, campaign_recipients, campaign_advisor_limits, campaign_settings, campaigns, message_templates, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, qr_accounts, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, custom_field_values, custom_field_definitions, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, plans, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  // Al administrador del cliente le llega todo; a Carolina el administrador le concede «ver sus campañas» y «enviar campañas» (por omisión el asesor no tiene ninguno)
  const m = (await admin.query(`SELECT id FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [IDS.carol, ORG_A])).rows[0].id as string;
  await admin.query(`INSERT INTO member_permissions(id, membership_id, permission_key, effect) VALUES (gen_random_uuid(), $1, 'campaigns.read', 'grant'), (gen_random_uuid(), $1, 'campaigns.send', 'grant')`, [m]);
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
let keySeq = 0;
const key = (): string => `k-${Date.now()}-${(keySeq += 1)}-${randomBytes(3).toString('hex')}`;
const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
async function connect(token: string, phoneId: string, name: string, waba: string): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: waba, phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
async function tplOf(token: string, channel: string, name: string): Promise<{ id: string; variables: Array<{ id: string }> }> {
  expect((await call('POST', `/channels/${channel}/templates/sync`, token)).status).toBe(200);
  const list = await ok<{ items: Array<{ id: string; name: string; language: string; variables: Array<{ id: string }> }> }>(await call('GET', `/channels/${channel}/templates`, token));
  return list.items.find((t) => t.name === name && t.language === 'es')!;
}
async function qrChannel(org: string, name: string, createdBy: string): Promise<string> {
  const id = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, is_official, name, created_by) VALUES (gen_random_uuid(), $1, 'evolution', false, $2, $3) RETURNING id`, [org, name, createdBy])).rows[0].id as string;
  await admin.query(`INSERT INTO qr_accounts(organization_id, channel_account_id, instance_name, state, first_connected_at) VALUES ($1, $2, $3, 'open', now() - interval '10 days')`, [org, id, `inst-${randomBytes(4).toString('hex')}`]);
  return id;
}

let phoneSeq = 0;
async function mkContact(o: { org?: string; owner?: string | null; name?: string; consent?: 'unknown' | 'granted' | 'revoked'; phone?: string | null } = {}): Promise<string> {
  phoneSeq += 1;
  const org = o.org ?? ORG_A;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id, consent) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [org, o.name ?? `Marcela Paredes ${phoneSeq}`, o.owner === undefined ? IDS.carol : o.owner, o.consent ?? 'granted'])).rows[0].id as string;
  const phone = o.phone === undefined ? `+59398810${String(phoneSeq).padStart(4, '0')}` : o.phone;
  if (phone) await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return contact;
}

interface Camp {
  id: string; name: string; status: string; mode: 'template' | 'text'; channel: { id: string; name: string; kind: string } | null; template_id: string | null; template_params: Record<string, string>; body: string | null;
  audience: Record<string, unknown>; include_unknown_consent: boolean; scheduled_at: string | null; gap_seconds: number; daily_cap: number; created_by: { id: string; name: string }; can_edit: boolean;
  counts: { total: number; sent: number; delivered: number; read: number; replied: number; failed: number; skipped: number };
  status_reason: string | null; can_pause: boolean; can_resume: boolean; can_cancel: boolean;
}
interface Preview {
  campaign_id: string;
  audience: { in_scope: number; out_of_scope: number; eligible: number; skipped: { revoked: number; excluded: number; no_phone: number; no_consent: number; duplicate: number }; sample: Array<{ id: string; name: string }> };
  limits: { channel_kind: string; daily_cap: number; channel_cap: number; advisor_cap: number | null; min_gap_seconds: number } | null;
  estimate: { days: number; first_day_minutes: number } | null;
  message: { text: string; missing: string[]; contact: { id: string; name: string } } | null;
  warnings: string[];
}

const textBody = (over: Record<string, unknown> = {}) => ({ name: 'Recordatorio de cupos', channel_id: qrAdmin, mode: 'text', body: 'Hola {{primer_nombre}}, tenemos cupos para esta semana.', audience: { source: 'all' }, gap_seconds: 60, daily_cap: 50, ...over });
const tplBody = (over: Record<string, unknown> = {}) => ({ name: 'Seguimiento oficial', channel_id: officialA, mode: 'template', template_id: tplA, template_params: { 'body:1': '{{primer_nombre}}', 'body:2': 'el viernes', 'body:3': '10:00' }, audience: { source: 'all' }, gap_seconds: 10, daily_cap: 100, ...over });
const create = (token: string, body: unknown, k: string | null = key()) => call('POST', '/campaigns', token, body, k ? { 'idempotency-key': k } : {});
const mk = async (token: string, body: unknown): Promise<Camp> => ok<Camp>(await create(token, body), 201);
const preview = async (token: string, id: string): Promise<Preview> => ok<Preview>(await call('GET', `/campaigns/${id}/preview`, token));
const audit = async (id: string) => (await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'campaign' AND entity_id = $1 ORDER BY at, id`, [id])).rows as Array<{ field: string | null; new_value: Record<string, unknown> | null }>;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
  officialA = await connect(T.alice, '1090123456789', 'Ventas', '1234567890123');
  officialB = await connect(T.bob, '1090123456780', 'Soporte', '1234567890124');
  qrAdmin = await qrChannel(ORG_A, 'Chip administración', IDS.alice);
  qrCarol = await qrChannel(ORG_A, 'Chip de Carolina', IDS.carol);
  tplA = (await tplOf(T.alice, officialA, 'recordatorio_cita')).id;
  tplB = (await tplOf(T.bob, officialB, 'recordatorio_cita')).id;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('permisos y plan', () => {
  it('sin sesión 401; la plataforma 403; una asesora sin campañas 403 en TODAS las rutas; el tope por asesor exige administrar al equipo', async () => {
    const c = await mk(T.alice, textBody());
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/campaigns/options'], ['GET', '/campaigns/advisor-limits'], ['PUT', `/campaigns/advisor-limits/${IDS.carol}`, { daily_cap: 10 }], ['POST', '/campaigns', textBody()], ['GET', '/campaigns'],
      ['GET', `/campaigns/${c.id}`], ['PATCH', `/campaigns/${c.id}`, { name: 'x' }], ['POST', `/campaigns/${c.id}/duplicate`], ['GET', `/campaigns/${c.id}/preview`],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
      expect((await call(m, p, T.eve, b, { 'idempotency-key': key() })).status, `${m} ${p} asesora sin campañas`).toBe(403);
    }
    // Carolina tiene campañas pero NO administra al equipo: no fija topes
    expect((await call('GET', '/campaigns/advisor-limits', T.carol)).status).toBe(403);
    expect((await call('PUT', `/campaigns/advisor-limits/${IDS.carol}`, T.carol, { daily_cap: 10 })).status).toBe(403);
  });

  it('la función «Campañas» del plan se exige: plan sin ella ⇒ 403 PLAN_FEATURE_DISABLED en todo; plan con ella o sin plan (prueba gratis) ⇒ pasa', async () => {
    expect((await call('GET', '/campaigns', T.alice)).status).toBe(200); // sin plan = prueba gratis: todo habilitado
    const off = (await admin.query(`INSERT INTO plans(id, name, features) VALUES (gen_random_uuid(), 'Básico', '{"campaigns": false, "kanban": true}') RETURNING id`)).rows[0].id as string;
    await admin.query(`UPDATE organizations SET plan_id = $1 WHERE id = $2`, [off, ORG_A]);
    for (const [m, p, b] of [['GET', '/campaigns'], ['GET', '/campaigns/options'], ['POST', '/campaigns', textBody()], ['GET', '/campaigns/advisor-limits']] as Array<[string, string, unknown?]>) {
      const r = await call(m, p, T.alice, b, { 'idempotency-key': key() });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(await code(r)).toBe('PLAN_FEATURE_DISABLED');
    }
    await admin.query(`UPDATE plans SET features = '{"campaigns": true}' WHERE id = $1`, [off]);
    expect((await call('GET', '/campaigns', T.alice)).status).toBe(200);
    // el plan de A no afecta a B
    expect((await call('GET', '/campaigns', T.bob)).status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('crear borradores', () => {
  it('crea un borrador por WhatsApp oficial (plantilla) y otro por QR (texto), con Idempotency-Key: repetirla devuelve el mismo; la llave de otra persona es 409; sin llave 400', async () => {
    const k = key();
    const first = await ok<Camp>(await create(T.alice, tplBody(), k), 201);
    expect(first).toMatchObject({ status: 'draft', mode: 'template', channel: { id: officialA, kind: 'official' }, template_id: tplA, can_edit: true, created_by: { id: IDS.alice, name: 'Alicia Torres' }, counts: { total: 0 } });
    const again = await ok<Camp>(await create(T.alice, tplBody(), k), 200);
    expect(again.id).toBe(first.id);
    expect((await admin.query(`SELECT count(*)::int AS n FROM campaigns`)).rows[0].n).toBe(1);
    const stolen = await create(T.carol, textBody({ channel_id: qrCarol }), k);
    expect(stolen.status).toBe(409);
    expect(await code(stolen)).toBe('IDEMPOTENCY_KEY_IN_USE');
    const qr = await mk(T.alice, textBody());
    expect(qr).toMatchObject({ mode: 'text', channel: { id: qrAdmin, kind: 'qr' }, body: 'Hola {{primer_nombre}}, tenemos cupos para esta semana.' });
    const nokey = await create(T.alice, textBody(), null);
    expect(nokey.status).toBe(400);
  });

  it('auditoría: queda quién, cuándo y la forma (ids, conteos y NOMBRES de variables), nunca el texto del mensaje', async () => {
    const c = await mk(T.alice, textBody({ body: 'Hola {{primer_nombre}}: promo secreta de $99', audience: { source: 'all', excluded_contact_ids: [NOBODY] } }));
    const rows = await audit(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.new_value).toMatchObject({ status: 'draft', mode: 'text', audience_source: 'all', excluded_count: 1, include_unknown_consent: false, variables: ['primer_nombre'] });
    expect(JSON.stringify(rows)).not.toContain('promo secreta');
  });

  it('reglas: modo y conexión coinciden, pausa mínima (45 s en QR, 5 s oficial), tope diario de la conexión (el 70 % del calentamiento en QR), variables permitidas y datos de la plantilla', async () => {
    const bad = async (over: Record<string, unknown>, base: 'text' | 'tpl', path: string, expected: string) => {
      const r = await create(T.alice, base === 'text' ? textBody(over) : tplBody(over));
      expect(r.status, `${path}`).toBe(400);
      const d = (await json<{ error: { details: Array<{ path: string; code: string }> } }>(r)).error.details;
      expect(d.some((x) => x.path === path && x.code === expected), JSON.stringify(d)).toBe(true);
    };
    await bad({ mode: 'template', template_id: tplA, body: undefined }, 'text', 'mode', 'mode_channel_mismatch'); // QR con plantilla
    await bad({ mode: 'text', template_id: undefined, template_params: undefined, body: 'Hola' }, 'tpl', 'mode', 'mode_channel_mismatch'); // oficial con texto libre
    await bad({ gap_seconds: 44 }, 'text', 'gap_seconds', 'gap_too_short');
    expect((await create(T.alice, tplBody({ gap_seconds: 4 }))).status).toBe(400); // por debajo de los 5 s mínimos
    await bad({ gap_seconds: 5, daily_cap: 1001 }, 'tpl', 'daily_cap', 'cap_exceeded');
    // chip de 10 días de calentamiento = 250 al día; la campaña puede usar el 70 % = 175
    await bad({ daily_cap: 176 }, 'text', 'daily_cap', 'cap_exceeded');
    await bad({ body: 'Hola {{telefono}}' }, 'text', 'body', 'unknown_variable'); // variable de las respuestas rápidas que no aplica a campañas
    await bad({ body: 'Hola {{contact.no_existe}}' }, 'text', 'body', 'unknown_variable');
    await bad({ template_params: { 'body:1': '{{primer_nombre}}' } }, 'tpl', 'template_params.body:2', 'required');
    await bad({ template_params: { 'body:1': 'a', 'body:2': 'b', 'body:3': 'c', 'body:9': 'd' } }, 'tpl', 'template_params.body:9', 'unknown_param');
    await bad({ channel_id: NOBODY }, 'text', 'channel_id', 'channel_unavailable');
    await bad({ audience: { source: 'list', list_id: NOBODY } }, 'text', 'audience.list_id', 'list_not_found');
    await bad({ scheduled_at: new Date(Date.now() - 3600_000).toISOString() }, 'text', 'scheduled_at', 'in_the_past');
    // un campo personalizado vigente SÍ se puede usar
    expect((await call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' })).status).toBe(201);
    expect((await create(T.alice, textBody({ body: 'Hola {{nombre}} de {{contact.ciudad}}' }))).status).toBe(201);
    // una plantilla que no es de esa conexión no existe
    expect((await create(T.alice, tplBody({ template_id: tplB }))).status).toBe(404);
  });

  it('«incluir sin consentimiento definido» solo lo declara el administrador (403 CONSENT_DECLARATION_FORBIDDEN para el asesor) y queda en la auditoría', async () => {
    const r = await create(T.carol, textBody({ channel_id: qrCarol, include_unknown_consent: true }));
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('CONSENT_DECLARATION_FORBIDDEN');
    const c = await mk(T.alice, textBody({ include_unknown_consent: true }));
    expect(c.include_unknown_consent).toBe(true);
    expect((await audit(c.id))[0]!.new_value).toMatchObject({ include_unknown_consent: true });
  });

  it('un asesor usa las conexiones oficiales y SOLO el QR que él creó: el QR del administrador no es suyo; ve su tope diario en las opciones', async () => {
    expect((await create(T.carol, textBody({ channel_id: qrAdmin }))).status).toBe(400);
    const own = await mk(T.carol, textBody({ channel_id: qrCarol }));
    expect(own.created_by.id).toBe(IDS.carol);
    expect((await mk(T.carol, tplBody())).channel?.kind).toBe('official');
    const opts = await ok<{ channels: Array<{ id: string; kind: string }>; limits: { advisor_daily_cap: number | null; official_daily_cap: number; qr_min_gap_seconds: number } }>(await call('GET', '/campaigns/options', T.carol));
    expect(opts.channels.map((c) => c.id).sort()).toEqual([officialA, qrCarol].sort());
    expect(opts.limits).toMatchObject({ advisor_daily_cap: null, official_daily_cap: 1000, qr_min_gap_seconds: 45 });
    const adm = await ok<{ channels: Array<{ id: string }> }>(await call('GET', '/campaigns/options', T.alice));
    expect(adm.channels.map((c) => c.id).sort()).toEqual([officialA, qrAdmin, qrCarol].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('ver, editar y duplicar', () => {
  it('el asesor solo ve las suyas (404 uniforme sobre las ajenas); el administrador ve todas y filtra con mine/status; paginación por cursor', async () => {
    const a1 = await mk(T.alice, textBody({ name: 'De Alicia' }));
    const c1 = await mk(T.carol, textBody({ name: 'De Carolina', channel_id: qrCarol }));
    expect((await ok<{ items: Camp[] }>(await call('GET', '/campaigns', T.carol))).items.map((c) => c.id)).toEqual([c1.id]);
    expect((await call('GET', `/campaigns/${a1.id}`, T.carol)).status).toBe(404);
    expect((await call('GET', `/campaigns/${NOBODY}`, T.carol)).status).toBe(404); // igual que si no existiera
    expect((await ok<{ items: Camp[] }>(await call('GET', '/campaigns', T.alice))).items.map((c) => c.name).sort()).toEqual(['De Alicia', 'De Carolina']);
    expect((await ok<{ items: Camp[] }>(await call('GET', '/campaigns?mine=true', T.alice))).items.map((c) => c.id)).toEqual([a1.id]);
    expect((await ok<{ items: Camp[] }>(await call('GET', '/campaigns?status=paused', T.alice))).items).toEqual([]);
    const p1 = await ok<{ items: Camp[]; next_cursor: string | null }>(await call('GET', '/campaigns?limit=1', T.alice));
    expect(p1.items.map((c) => c.id)).toEqual([c1.id]); // la más reciente primero
    const p2 = await ok<{ items: Camp[]; next_cursor: string | null }>(await call('GET', `/campaigns?limit=1&cursor=${p1.next_cursor}`, T.alice));
    expect(p2.items.map((c) => c.id)).toEqual([a1.id]);
    expect(p2.next_cursor).toBeNull();
    expect((await call('GET', '/campaigns?cursor=basura', T.alice)).status).toBe(400);
  });

  it('editar: solo un borrador y solo quien lo creó (el administrador no edita la de otro: 404); se vuelve a validar el conjunto; en otro estado ⇒ 409', async () => {
    const c = await mk(T.carol, textBody({ channel_id: qrCarol }));
    const up = await ok<Camp>(await call('PATCH', `/campaigns/${c.id}`, T.carol, { name: 'Nuevo nombre', body: 'Hola {{nombre}}' }));
    expect(up).toMatchObject({ name: 'Nuevo nombre', body: 'Hola {{nombre}}' });
    expect((await audit(c.id)).map((r) => r.field)).toEqual([null, 'edited']);
    expect((await call('PATCH', `/campaigns/${c.id}`, T.carol, { gap_seconds: 10 })).status).toBe(400); // la pausa mínima del QR sigue valiendo
    expect((await call('PATCH', `/campaigns/${c.id}`, T.alice, { name: 'hackeo' })).status).toBe(404);
    expect((await call('PATCH', `/campaigns/${c.id}`, T.carol, {})).status).toBe(400);
    expect((await call('PATCH', `/campaigns/${c.id}`, T.carol, { status: 'running' })).status).toBe(400); // el estado no se edita a mano
    await admin.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [c.id]);
    const r = await call('PATCH', `/campaigns/${c.id}`, T.carol, { name: 'tarde' });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('CAMPAIGN_NOT_EDITABLE');
  });

  it('duplicar: un borrador nuevo (copia, sin programación) con su propia Idempotency-Key; repetirla devuelve el mismo', async () => {
    const src = await mk(T.alice, textBody({ name: 'Original', scheduled_at: new Date(Date.now() + 86_400_000).toISOString() }));
    const k = key();
    const dup = await ok<Camp>(await call('POST', `/campaigns/${src.id}/duplicate`, T.alice, undefined, { 'idempotency-key': k }), 201);
    expect(dup).toMatchObject({ name: 'Original (copia)', status: 'draft', scheduled_at: null, body: src.body });
    expect(dup.id).not.toBe(src.id);
    expect((await ok<Camp>(await call('POST', `/campaigns/${src.id}/duplicate`, T.alice, undefined, { 'idempotency-key': k }), 200)).id).toBe(dup.id);
    expect((await call('POST', `/campaigns/${src.id}/duplicate`, T.alice)).status).toBe(400); // sin llave
    expect((await call('POST', `/campaigns/${src.id}/duplicate`, T.carol, undefined, { 'idempotency-key': key() })).status).toBe(404); // ajena
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('aislamiento A↔B', () => {
  it('B no ve, edita, duplica ni previsualiza las campañas de A (404), no usa sus conexiones ni plantillas, y su lista no incluye nada de A', async () => {
    const a = await mk(T.alice, textBody());
    const b = await mk(T.bob, tplBody({ channel_id: officialB, template_id: tplB }));
    expect((await ok<{ items: Camp[] }>(await call('GET', '/campaigns', T.bob))).items.map((c) => c.id)).toEqual([b.id]);
    for (const [m, p, body] of [['GET', `/campaigns/${a.id}`], ['PATCH', `/campaigns/${a.id}`, { name: 'x' }], ['POST', `/campaigns/${a.id}/duplicate`], ['GET', `/campaigns/${a.id}/preview`]] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, T.bob, body, { 'idempotency-key': key() })).status, `${m} ${p}`).toBe(404);
    }
    for (const [m, p, body] of [['GET', `/campaigns/${b.id}`], ['PATCH', `/campaigns/${b.id}`, { name: 'x' }], ['POST', `/campaigns/${b.id}/duplicate`], ['GET', `/campaigns/${b.id}/preview`]] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, T.alice, body, { 'idempotency-key': key() })).status, `${m} ${p}`).toBe(404);
    }
    expect((await create(T.bob, textBody({ channel_id: qrAdmin }))).status).toBe(400); // el chip de A no existe para B
    expect((await create(T.bob, tplBody({ channel_id: officialA, template_id: tplA }))).status).toBe(400);
    expect((await create(T.alice, tplBody({ channel_id: officialB, template_id: tplB }))).status).toBe(400);
    const optsB = await ok<{ channels: Array<{ id: string }> }>(await call('GET', '/campaigns/options', T.bob));
    expect(optsB.channels.map((c) => c.id)).toEqual([officialB]);
    // los topes por asesor tampoco cruzan: Bob no puede fijarle uno a una asesora de A
    expect((await call('PUT', `/campaigns/advisor-limits/${IDS.carol}`, T.bob, { daily_cap: 5 })).status).toBe(404);
    // ni la audiencia: los contactos de B nunca entran a una campaña de A
    await mkContact({ org: ORG_B, owner: IDS.bob, name: 'Cliente de B' });
    const aOwn = await mkContact({ owner: IDS.alice, name: 'Cliente de A' });
    const pv = await preview(T.alice, a.id);
    expect(pv.audience.sample.map((s) => s.name)).toEqual(['Cliente de A']);
    expect(pv.audience.sample[0]!.id).toBe(aOwn);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('vista previa de la audiencia', () => {
  it('cuenta a quién se escribe y a quién no, con el motivo; un contacto revocado NUNCA entra, ni incluyendo los sin consentimiento ni sin desmarcarlo', async () => {
    const ok1 = await mkContact({ owner: IDS.alice, name: 'Ana Lema', consent: 'granted' });
    await mkContact({ owner: IDS.alice, name: 'Beto Vera', consent: 'granted' });
    await mkContact({ owner: IDS.alice, name: 'Sin permiso', consent: 'unknown' });
    const revoked = await mkContact({ owner: IDS.alice, name: 'Pidió baja', consent: 'revoked' });
    await mkContact({ owner: IDS.alice, name: 'Sin teléfono', consent: 'granted', phone: null });
    const manual = await mkContact({ owner: IDS.alice, name: 'Desmarcado', consent: 'granted' });
    const c = await mk(T.alice, textBody({ audience: { source: 'all', excluded_contact_ids: [manual, revoked] } }));
    const p = await preview(T.alice, c.id);
    expect(p.audience).toMatchObject({ in_scope: 6, out_of_scope: 0, eligible: 2, skipped: { revoked: 1, excluded: 1, no_phone: 1, no_consent: 1, duplicate: 0 } });
    expect(p.audience.sample.map((s) => s.name)).toEqual(['Ana Lema', 'Beto Vera']);
    expect(p.audience.sample.map((s) => s.id)).not.toContain(revoked);
    // el administrador declara permiso para los «sin definir»: entran; el revocado sigue fuera aunque nadie lo desmarque
    const c2 = await mk(T.alice, textBody({ include_unknown_consent: true, audience: { source: 'all' } }));
    const p2 = await preview(T.alice, c2.id);
    expect(p2.audience.eligible).toBe(4);
    expect(p2.audience.skipped).toMatchObject({ revoked: 1, no_consent: 0, no_phone: 1 });
    expect(p2.audience.sample.map((s) => s.id)).not.toContain(revoked);
    expect(p2.warnings).toContain('unknown_consent_included');
    expect(ok1).toBeTruthy();
  });

  it('el asesor arma la audiencia SOLO con sus contactos (el resto de la empresa se cuenta como «sin acceso» y no se ve); el administrador la de toda la base', async () => {
    await mkContact({ owner: IDS.carol, name: 'De Carolina 1' });
    await mkContact({ owner: IDS.carol, name: 'De Carolina 2' });
    await mkContact({ owner: IDS.eve, name: 'De Eva' });
    await mkContact({ owner: null, name: 'Sin asignar' });
    const c = await mk(T.carol, textBody({ channel_id: qrCarol }));
    const p = await preview(T.carol, c.id);
    expect(p.audience).toMatchObject({ in_scope: 2, out_of_scope: 2, eligible: 2 });
    expect(p.audience.sample.map((s) => s.name).sort()).toEqual(['De Carolina 1', 'De Carolina 2']);
    const adm = await mk(T.alice, textBody());
    expect((await preview(T.alice, adm.id)).audience).toMatchObject({ in_scope: 4, out_of_scope: 0, eligible: 4 });
  });

  it('listas y filtros: una lista fija o los filtros guardados; la lista tiene que ser tuya o estar compartida', async () => {
    const a = await mkContact({ owner: IDS.alice, name: 'En la lista', consent: 'granted' });
    await mkContact({ owner: IDS.alice, name: 'Fuera de la lista', consent: 'granted' });
    await mkContact({ owner: IDS.alice, name: 'Sin definir', consent: 'unknown' });
    const list = await ok<{ id: string }>(await call('POST', '/contact-lists', T.alice, { name: 'Interesados', kind: 'fixed' }), 201);
    await ok(await call('POST', `/contact-lists/${list.id}/members`, T.alice, { contact_ids: [a] }));
    const fixed = await mk(T.alice, textBody({ audience: { source: 'list', list_id: list.id } }));
    expect((await preview(T.alice, fixed.id)).audience).toMatchObject({ eligible: 1, in_scope: 1 });
    const filtered = await mk(T.alice, textBody({ audience: { source: 'filters', filters: { consent: 'granted' } } }));
    expect((await preview(T.alice, filtered.id)).audience).toMatchObject({ eligible: 2, in_scope: 2 });
    // la lista personal de Alicia no la usa Carolina
    expect((await create(T.carol, textBody({ channel_id: qrCarol, audience: { source: 'list', list_id: list.id } }))).status).toBe(400);
    expect((await create(T.alice, textBody({ audience: { source: 'all', list_id: list.id } }))).status).toBe(400);
  });

  it('mensaje con un contacto real: variables resueltas; el dato que falta se avisa y no se manda la llave cruda como si fuera dato; plantilla armada con sus valores', async () => {
    const f = await ok<{ key: string }>(await call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' }), 201);
    const withCity = await mkContact({ owner: IDS.alice, name: 'Lucía Mora Paz' });
    await ok(await call('PATCH', `/contacts/${withCity}`, T.alice, { custom_fields: { [f.key]: 'Quito' } }));
    const text = await mk(T.alice, textBody({ body: 'Hola {{primer_nombre}} de {{contact.ciudad}}, ¿te reservo?' }));
    const p = await preview(T.alice, text.id);
    expect(p.message).toMatchObject({ text: 'Hola Lucía de Quito, ¿te reservo?', missing: [], contact: { id: withCity, name: 'Lucía Mora Paz' } });
    await admin.query(`DELETE FROM custom_field_values WHERE entity_id = $1`, [withCity]);
    const p2 = await preview(T.alice, text.id);
    expect(p2.message!.missing).toEqual([`contact.${f.key}`]);
    const tpl = await mk(T.alice, tplBody());
    const pt = await preview(T.alice, tpl.id);
    expect(pt.message!.text).toContain('Lucía');
    expect(pt.message!.text).toContain('el viernes');
    expect(pt.warnings).toContain('official_marketing_cost');
  });

  it('límites y duración: el tope efectivo es el mínimo entre la campaña, el del asesor y el de la conexión (QR: 70 % del cupo del calentamiento); «se enviará en N días»; avisos de riesgo', async () => {
    for (let i = 0; i < 5; i += 1) await mkContact({ owner: IDS.carol });
    const qr = await mk(T.carol, textBody({ channel_id: qrCarol, daily_cap: 175, gap_seconds: 60 }));
    let p = await preview(T.carol, qr.id);
    expect(p.limits).toMatchObject({ channel_kind: 'qr', daily_cap: 175, channel_cap: 175, advisor_cap: null, min_gap_seconds: 45 });
    expect(p.estimate).toEqual({ days: 1, first_day_minutes: 5 });
    expect(p.warnings).toContain('qr_unofficial_risk');
    // el administrador le fija un tope de 2 al día: la vista previa lo aplica y dice que tardará 3 días
    await ok(await call('PUT', `/campaigns/advisor-limits/${IDS.carol}`, T.alice, { daily_cap: 2 }));
    p = await preview(T.carol, qr.id);
    expect(p.limits).toMatchObject({ daily_cap: 2, advisor_cap: 2 });
    expect(p.estimate!.days).toBe(3);
    expect(p.warnings).toContain('spans_days');
    // y ya no puede crear ni editar campañas por encima de su tope
    const over = await create(T.carol, textBody({ channel_id: qrCarol, daily_cap: 3 }));
    expect(over.status).toBe(400);
    expect((await json<{ error: { details: Array<{ code: string; message: string }> } }>(over)).error.details[0]).toMatchObject({ code: 'cap_exceeded', message: expect.stringContaining('tu administrador') });
    expect((await call('PATCH', `/campaigns/${qr.id}`, T.carol, { daily_cap: 3 })).status).toBe(400);
  });

  it('la vista previa es solo del creador (el administrador no ve la audiencia armada con el alcance de una asesora: 404) y no escribe nada', async () => {
    await mkContact({ owner: IDS.carol });
    const c = await mk(T.carol, textBody({ channel_id: qrCarol }));
    expect((await call('GET', `/campaigns/${c.id}/preview`, T.alice)).status).toBe(404);
    const before = (await admin.query(`SELECT (SELECT count(*)::int FROM audit_logs) AS a, (SELECT count(*)::int FROM campaign_recipients) AS r, (SELECT count(*)::int FROM messages) AS m`)).rows[0] as { a: number; r: number; m: number };
    await preview(T.carol, c.id);
    const after = (await admin.query(`SELECT (SELECT count(*)::int FROM audit_logs) AS a, (SELECT count(*)::int FROM campaign_recipients) AS r, (SELECT count(*)::int FROM messages) AS m`)).rows[0] as { a: number; r: number; m: number };
    expect(after).toEqual(before);
    expect(after.r).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('tope diario por asesor', () => {
  it('quien administra al equipo lo fija y lo cambia (con auditoría); solo a personas de SU empresa; valores válidos', async () => {
    expect((await ok<{ items: unknown[] }>(await call('GET', '/campaigns/advisor-limits', T.alice))).items).toEqual([]);
    const set = await ok<{ user_id: string; daily_cap: number }>(await call('PUT', `/campaigns/advisor-limits/${IDS.carol}`, T.alice, { daily_cap: 80 }));
    expect(set).toMatchObject({ user_id: IDS.carol, daily_cap: 80 });
    await ok(await call('PUT', `/campaigns/advisor-limits/${IDS.carol}`, T.alice, { daily_cap: 60 }));
    expect((await ok<{ items: Array<{ user_id: string; daily_cap: number }> }>(await call('GET', '/campaigns/advisor-limits', T.alice))).items).toMatchObject([{ user_id: IDS.carol, daily_cap: 60 }]);
    const log = (await admin.query(`SELECT old_value, new_value FROM audit_logs WHERE entity_type = 'campaign_advisor_limit' AND entity_id = $1 ORDER BY at, id`, [IDS.carol])).rows;
    expect(log.map((r) => [r.old_value, r.new_value])).toEqual([[null, 80], [80, 60]]);
    for (const bad of [{ daily_cap: 0 }, { daily_cap: 10001 }, { daily_cap: 1.5 }, { daily_cap: 10, extra: 1 }, {}]) expect((await call('PUT', `/campaigns/advisor-limits/${IDS.carol}`, T.alice, bad)).status).toBe(400);
    expect((await call('PUT', `/campaigns/advisor-limits/${IDS.bob}`, T.alice, { daily_cap: 10 })).status).toBe(404); // una persona de otra empresa
    expect((await call('PUT', `/campaigns/advisor-limits/${NOBODY}`, T.alice, { daily_cap: 10 })).status).toBe(404);
    // Bob (otra empresa) no ve los topes de A
    expect((await ok<{ items: unknown[] }>(await call('GET', '/campaigns/advisor-limits', T.bob))).items).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('rutas de apoyo de la pantalla (17.2)', () => {
  it('acceso: cada persona ve lo que puede hacer y si su plan lo incluye, sin datos de la empresa; la plataforma 403', async () => {
    expect(await ok(await call('GET', '/campaigns/access', T.alice))).toEqual({ plan_enabled: true, read: true, send: true, view_all: true, manage_limits: true, manage_settings: true, cancel_others: true });
    expect(await ok(await call('GET', '/campaigns/access', T.carol))).toEqual({ plan_enabled: true, read: true, send: true, view_all: false, manage_limits: false, manage_settings: false, cancel_others: false });
    expect(await ok(await call('GET', '/campaigns/access', T.eve))).toEqual({ plan_enabled: true, read: false, send: false, view_all: false, manage_limits: false, manage_settings: false, cancel_others: false });
    const off = (await admin.query(`INSERT INTO plans(id, name, features) VALUES (gen_random_uuid(), 'Básico', '{"campaigns": false}') RETURNING id`)).rows[0].id as string;
    await admin.query(`UPDATE organizations SET plan_id = $1 WHERE id = $2`, [off, ORG_A]);
    expect((await ok<{ plan_enabled: boolean }>(await call('GET', '/campaigns/access', T.alice))).plan_enabled).toBe(false); // el menú puede mostrar la sección bloqueada
    expect((await ok<{ plan_enabled: boolean }>(await call('GET', '/campaigns/access', T.bob))).plan_enabled).toBe(true); // B no depende del plan de A
    expect((await call('GET', '/campaigns/access', undefined)).status).toBe(401);
    expect((await call('GET', '/campaigns/access', T.root)).status).toBe(403);
  });

  it('plantillas: solo las enviables de una conexión OFICIAL que la persona puede usar, con sus variables; un QR, una conexión de otra empresa o sin permiso no existen', async () => {
    const t = await ok<{ items: Array<{ id: string; name: string; sendable: boolean; variables: Array<{ id: string }> }> }>(await call('GET', `/campaigns/channels/${officialA}/templates`, T.carol));
    expect(t.items.length).toBeGreaterThan(0);
    expect(t.items.every((x) => x.sendable)).toBe(true);
    expect(t.items.find((x) => x.id === tplA)!.variables.map((v) => v.id)).toEqual(['body:1', 'body:2', 'body:3']);
    expect((await call('GET', `/campaigns/channels/${qrAdmin}/templates`, T.alice)).status).toBe(404);
    expect((await call('GET', `/campaigns/channels/${officialB}/templates`, T.alice)).status).toBe(404);
    expect((await call('GET', `/campaigns/channels/${officialA}/templates`, T.bob)).status).toBe(404);
    expect((await call('GET', `/campaigns/channels/${NOBODY}/templates`, T.alice)).status).toBe(404);
    expect((await call('GET', `/campaigns/channels/${officialA}/templates`, T.eve)).status).toBe(403);
  });

  it('vista previa en vivo: con solo la audiencia cuenta; con la conexión suma límites; con el mensaje, el ejemplo real; no guarda nada y respeta el alcance, el consentimiento y la empresa', async () => {
    await mkContact({ owner: IDS.carol, name: 'Lucía Mora' });
    await mkContact({ owner: IDS.carol, name: 'Baja', consent: 'revoked' });
    await mkContact({ owner: IDS.eve, name: 'De Eva' });
    await mkContact({ org: ORG_B, owner: IDS.bob, name: 'De B' });
    const live = (token: string, body: unknown) => call('POST', '/campaigns/preview', token, body);
    const only = await ok<Preview>(await live(T.carol, { audience: { source: 'all' } }));
    expect(only).toMatchObject({ campaign_id: null, limits: null, estimate: null, message: null, audience: { in_scope: 2, out_of_scope: 1, eligible: 1, skipped: { revoked: 1 } } });
    const withChannel = await ok<Preview>(await live(T.carol, { audience: { source: 'all' }, channel_id: qrCarol, gap_seconds: 60, daily_cap: 100, mode: 'text', body: 'Hola {{primer_nombre}}' }));
    expect(withChannel.limits).toMatchObject({ channel_kind: 'qr', daily_cap: 100, min_gap_seconds: 45 });
    expect(withChannel.message).toMatchObject({ text: 'Hola Lucía', missing: [] });
    expect(withChannel.warnings).toContain('qr_unofficial_risk');
    // una conexión que no puede usar no es un error: simplemente no hay límites
    expect((await ok<Preview>(await live(T.carol, { audience: { source: 'all' }, channel_id: qrAdmin }))).limits).toBeNull();
    // plantilla oficial con sus valores
    const tpl = await ok<Preview>(await live(T.carol, { audience: { source: 'all' }, channel_id: officialA, mode: 'template', template_id: tplA, template_params: { 'body:1': '{{primer_nombre}}', 'body:2': 'el viernes', 'body:3': '10:00' } }));
    expect(tpl.message!.text).toContain('Lucía');
    expect(tpl.warnings).toContain('official_marketing_cost');
    // reglas: el asesor no declara permiso; sin audiencia 400; lista ajena 404; no se guardó nada
    expect((await live(T.carol, { audience: { source: 'all' }, include_unknown_consent: true })).status).toBe(403);
    expect((await live(T.carol, {})).status).toBe(400);
    expect((await live(T.carol, { audience: { source: 'list', list_id: NOBODY } })).status).toBe(404);
    expect((await live(T.eve, { audience: { source: 'all' } })).status).toBe(403);
    expect((await live(T.root, { audience: { source: 'all' } })).status).toBe(403);
    expect((await admin.query(`SELECT (SELECT count(*)::int FROM campaigns) AS c, (SELECT count(*)::int FROM audit_logs WHERE entity_type = 'campaign') AS a`)).rows[0]).toEqual({ c: 0, a: 0 });
    // B solo cuenta lo suyo
    expect((await ok<Preview>(await live(T.bob, { audience: { source: 'all' } }))).audience).toMatchObject({ in_scope: 1, eligible: 1 });
  });

  it('lista de destinatarios: cada contacto con su estado (se escribe, baja, sin teléfono, sin consentimiento, desmarcado), por páginas; el asesor solo ve los suyos', async () => {
    const a = await mkContact({ owner: IDS.alice, name: 'A Ana' });
    await mkContact({ owner: IDS.alice, name: 'B Beto', consent: 'revoked' });
    await mkContact({ owner: IDS.alice, name: 'C Cata', phone: null });
    await mkContact({ owner: IDS.alice, name: 'D Dani', consent: 'unknown' });
    const e = await mkContact({ owner: IDS.alice, name: 'E Eli' });
    await mkContact({ owner: IDS.eve, name: 'F de Eva' });
    const list = (token: string, body: unknown) => call('POST', '/campaigns/audience', token, body);
    interface Page { items: Array<{ id: string; name: string; phone: string | null; state: string }>; total: number; next_cursor: string | null }
    const p1 = await ok<Page>(await list(T.alice, { audience: { source: 'all', excluded_contact_ids: [e] }, limit: 4 }));
    expect(p1.total).toBe(6);
    expect(p1.items.map((x) => [x.name, x.state])).toEqual([['A Ana', 'eligible'], ['B Beto', 'revoked'], ['C Cata', 'no_phone'], ['D Dani', 'no_consent']]);
    expect(p1.items[0]!.id).toBe(a);
    const p2 = await ok<Page>(await list(T.alice, { audience: { source: 'all', excluded_contact_ids: [e] }, limit: 4, cursor: p1.next_cursor }));
    expect(p2.items.map((x) => [x.name, x.state])).toEqual([['E Eli', 'excluded'], ['F de Eva', 'eligible']]);
    expect(p2.next_cursor).toBeNull();
    // declarando permiso, los «sin definir» entran
    const decl = await ok<Page>(await list(T.alice, { audience: { source: 'all' }, include_unknown_consent: true, limit: 10 }));
    expect(decl.items.find((x) => x.name === 'D Dani')!.state).toBe('eligible');
    // la asesora solo ve los suyos (ninguno tiene) y no puede declarar permiso; cursor inválido 400
    expect((await ok<Page>(await list(T.carol, { audience: { source: 'all' } }))).total).toBe(0);
    expect((await list(T.carol, { audience: { source: 'all' }, include_unknown_consent: true })).status).toBe(403);
    expect((await list(T.alice, { audience: { source: 'all' }, cursor: 'zzz' })).status).toBe(400);
    expect((await ok<Page>(await list(T.bob, { audience: { source: 'all' } }))).total).toBe(0); // B no ve nada de A
    expect((await list(T.eve, { audience: { source: 'all' } })).status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('envío por WhatsApp oficial (17.3)', () => {
  const sender = (): CampaignSenderService => app.get(CampaignSenderService);
  /** Una pasada de la tarea de envío para la empresa A, «ahora + offset». */
  const tick = (offsetMs = 1000, org = ORG_A): Promise<number> => TenantContext.run({ organizationId: org }, () => sender().runDue(new Date(Date.now() + offsetMs)));
  const launch = (token: string, id: string, k: string | null = key()) => call('POST', `/campaigns/${id}/launch`, token, undefined, k ? { 'idempotency-key': k } : {});
  const act = (token: string, id: string, what: 'pause' | 'resume' | 'cancel') => call('POST', `/campaigns/${id}/${what}`, token);
  const recipients = async (id: string) => (await admin.query(`SELECT r.status, r.skip_reason, r.error, r.phone, r.message_id, r.conversation_id, c.name FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.campaign_id = $1 ORDER BY c.name`, [id])).rows as Array<{ status: string; skip_reason: string | null; error: string | null; phone: string | null; message_id: string | null; conversation_id: string | null; name: string }>;
  const byName = (rows: Awaited<ReturnType<typeof recipients>>, name: string) => rows.find((r) => r.name === name)!;
  const dbCamp = async (id: string) => (await admin.query(`SELECT status, status_reason, launched_at, next_send_at, finished_at FROM campaigns WHERE id = $1`, [id])).rows[0] as { status: string; status_reason: string | null; launched_at: Date | null; next_send_at: Date | null; finished_at: Date | null };
  const messagesOf = async (id: string) => (await admin.query(`SELECT m.id, m.sender_type, m.kind, m.direction, m.status, m.body, m.conversation_id, c.name AS contact FROM messages m JOIN conversations v ON v.id = m.conversation_id JOIN contacts c ON c.id = v.contact_id WHERE m.id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [id])).rows as Array<{ id: string; sender_type: string; kind: string; direction: string; status: string; body: string; conversation_id: string; contact: string }>;
  const people = async (names: string[], over: Parameters<typeof mkContact>[0] = {}) => { for (const n of names) await mkContact({ owner: IDS.alice, name: n, ...over }); };

  it('lanzar congela la audiencia (destinatarios y omitidos con su motivo), es idempotente y solo lo hace quien la creó; sin llave 400; por QR todavía no', async () => {
    await people(['Ana', 'Beto']);
    await mkContact({ owner: IDS.alice, name: 'Baja', consent: 'revoked' });
    await mkContact({ owner: IDS.alice, name: 'Sin permiso', consent: 'unknown' });
    const c = await mk(T.alice, tplBody());
    expect((await launch(T.alice, c.id, null)).status).toBe(400);
    expect((await launch(T.carol, c.id)).status).toBe(404); // ajena
    expect((await launch(T.bob, c.id)).status).toBe(404); // otra empresa
    const k = key();
    const first = await ok<Camp>(await launch(T.alice, c.id, k), 201);
    expect(first).toMatchObject({ status: 'running', counts: { total: 4, skipped: 2 }, can_edit: false, can_pause: true, can_resume: false, can_cancel: true });
    const rows = await recipients(c.id);
    expect(rows.map((r) => [r.name, r.status, r.skip_reason])).toEqual([['Ana', 'pending', null], ['Baja', 'skipped', 'revoked'], ['Beto', 'pending', null], ['Sin permiso', 'skipped', 'no_consent']]);
    expect(byName(rows, 'Ana').phone).toMatch(/^\+5939881/);
    // repetirlo: la misma campaña, sin congelar de nuevo (aunque aparezcan contactos nuevos)
    await mkContact({ owner: IDS.alice, name: 'Llegó después' });
    const again = await ok<Camp>(await launch(T.alice, c.id, k), 200);
    expect(again.id).toBe(c.id);
    expect((await recipients(c.id)).length).toBe(4);
    // ya no se edita
    expect((await call('PATCH', `/campaigns/${c.id}`, T.alice, { name: 'tarde' })).status).toBe(409);
    expect((await admin.query(`SELECT field FROM audit_logs WHERE entity_type = 'campaign' AND entity_id = $1 ORDER BY at, id`, [c.id])).rows.map((r) => r.field)).toEqual([null, 'launched']);
    // por QR hace falta aceptar el aviso de riesgo (17.4); sin destinatarios no se lanza
    const qr = await mk(T.alice, textBody());
    const r = await launch(T.alice, qr.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('QR_RISK_NOT_ACCEPTED');
    const empty = await mk(T.carol, tplBody({ name: 'Vacía' }));
    const r2 = await launch(T.carol, empty.id);
    expect(r2.status).toBe(409);
    expect(await code(r2)).toBe('NO_RECIPIENTS');
  });

  it('un mensaje por pasada respetando la pausa; no más de 2 en camino; la conversación se abre o se reutiliza con su responsable, sin Lead ni reparto; al final la campaña termina', async () => {
    const [a, b, d] = [await mkContact({ owner: IDS.carol, name: 'Ana' }), await mkContact({ owner: null, name: 'Beto' }), await mkContact({ owner: IDS.carol, name: 'Dani' })];
    // Dani ya tiene una conversación abierta en esa conexión: se reutiliza
    const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now(), 0, '593988100001') RETURNING id`, [ORG_A, d, officialA, IDS.carol])).rows[0].id as string;
    const c = await mk(T.alice, tplBody({ gap_seconds: 10, daily_cap: 100 }));
    await ok(await launch(T.alice, c.id), 201);
    expect(await tick(1000)).toBeGreaterThan(0);
    let rows = await recipients(c.id);
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
    expect(await tick(2000)).toBe(0); // la pausa de 10 s no pasó
    expect((await dbCamp(c.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now() + 5000);
    await tick(12_000);
    expect((await recipients(c.id)).filter((r) => r.status === 'queued')).toHaveLength(2);
    await tick(24_000); // ya hay 2 en camino: no sale otro hasta que salgan
    expect((await recipients(c.id)).filter((r) => r.status === 'queued')).toHaveLength(2);
    await admin.query(`UPDATE messages SET status = 'sent' WHERE id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [c.id]);
    await tick(26_000); // pone al día los estados y, como ya no hay mensajes en camino, sale el tercero
    await tick(40_000);
    rows = await recipients(c.id);
    expect(rows.map((r) => r.status).sort()).toEqual(['queued', 'sent', 'sent']);
    await admin.query(`UPDATE messages SET status = 'sent' WHERE id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [c.id]);
    await tick(60_000);
    await tick(80_000);
    expect((await dbCamp(c.id)).status).toBe('completed');
    expect((await dbCamp(c.id)).finished_at).not.toBeNull();
    // los mensajes: de campaña, plantilla, saliente, en la conversación de cada contacto
    const msgs = await messagesOf(c.id);
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => m.sender_type === 'campaign' && m.kind === 'template' && m.direction === 'out')).toBe(true);
    expect(msgs.find((m) => m.contact === 'Ana')!.body).toContain('Ana');
    // conversaciones: Ana nueva «pendiente» para su responsable; Beto sin responsable → quien creó la campaña; Dani reutiliza la suya
    const convs = (await admin.query(`SELECT c.name, v.id, v.status, v.owner_id FROM conversations v JOIN contacts c ON c.id = v.contact_id ORDER BY c.name`)).rows as Array<{ name: string; id: string; status: string; owner_id: string | null }>;
    expect(convs).toHaveLength(3);
    expect(convs.find((x) => x.name === 'Ana')).toMatchObject({ status: 'pending', owner_id: IDS.carol });
    expect(convs.find((x) => x.name === 'Beto')).toMatchObject({ status: 'pending', owner_id: IDS.alice });
    expect(convs.find((x) => x.name === 'Dani')).toMatchObject({ id: conv, status: 'working', owner_id: IDS.carol });
    // sin reparto, sin Lead, sin cronómetro de respuesta
    expect((await admin.query(`SELECT count(*)::int AS n FROM contact_tags`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM response_timers`)).rows[0].n).toBe(0);
    expect([a, b].length).toBe(2);
  });

  it('un contacto que pidió la baja DESPUÉS de lanzar jamás recibe el mensaje; el dato que falta descarta solo a ese contacto', async () => {
    const f = await ok<{ key: string }>(await call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' }), 201);
    const con = await mkContact({ owner: IDS.alice, name: 'Con ciudad' });
    await ok(await call('PATCH', `/contacts/${con}`, T.alice, { custom_fields: { [f.key]: 'Quito' } }));
    const sin = await mkContact({ owner: IDS.alice, name: 'Sin ciudad' });
    const baja = await mkContact({ owner: IDS.alice, name: 'Pidió baja luego' });
    const c = await mk(T.alice, tplBody({ gap_seconds: 5, template_params: { 'body:1': '{{primer_nombre}}', 'body:2': '{{contact.ciudad}}', 'body:3': '10:00' } }));
    await ok(await launch(T.alice, c.id), 201);
    await admin.query(`UPDATE contacts SET consent = 'revoked' WHERE id = $1`, [baja]);
    for (let i = 1; i <= 8; i += 1) {
      await admin.query(`UPDATE messages SET status = 'sent' WHERE id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [c.id]);
      await tick(i * 6000);
    }
    const rows = await recipients(c.id);
    expect(byName(rows, 'Pidió baja luego')).toMatchObject({ status: 'skipped', skip_reason: 'revoked', message_id: null });
    expect(byName(rows, 'Sin ciudad')).toMatchObject({ status: 'skipped', skip_reason: 'missing_variable', message_id: null });
    expect(byName(rows, 'Con ciudad').status).toBe('sent');
    const msgs = await messagesOf(c.id);
    expect(msgs.map((m) => m.contact)).toEqual(['Con ciudad']);
    expect(msgs[0]!.body).toContain('Quito');
    expect(sin && baja).toBeTruthy();
    expect((await dbCamp(c.id)).status).toBe('completed');
  });

  it('topes diarios: el de la campaña, el del asesor y el de la empresa (configurable); alcanzado uno, espera sin enviar', async () => {
    await people(['A1', 'A2', 'A3']);
    const c = await mk(T.alice, tplBody({ gap_seconds: 5, daily_cap: 1 }));
    await ok(await launch(T.alice, c.id), 201);
    await tick(1000);
    await admin.query(`UPDATE messages SET status = 'sent' WHERE id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [c.id]);
    await tick(8000);
    await tick(20_000);
    expect((await recipients(c.id)).filter((r) => r.message_id).length).toBe(1); // el tope de la campaña es 1 al día
    expect((await dbCamp(c.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now() + 8 * 60_000); // vuelve a mirar en ~10 min
    // el tope de la EMPRESA se configura y se aplica entre campañas: 2 al día en total
    expect((await call('PUT', '/campaigns/settings', T.carol, { official_daily_cap: 2 })).status).toBe(403);
    expect(await ok(await call('PUT', '/campaigns/settings', T.alice, { official_daily_cap: 2 }))).toMatchObject({ official_daily_cap: 2, default_cap: 1000 });
    expect(await ok(await call('GET', '/campaigns/settings', T.alice))).toMatchObject({ official_daily_cap: 2 });
    for (const bad of [{ official_daily_cap: 0 }, { official_daily_cap: 100001 }, { official_daily_cap: 1.5 }, {}]) expect((await call('PUT', '/campaigns/settings', T.alice, bad)).status).toBe(400);
    const d = await mk(T.alice, tplBody({ name: 'Otra', gap_seconds: 5, daily_cap: 2 }));
    await ok(await launch(T.alice, d.id), 201);
    for (let i = 1; i <= 6; i += 1) {
      await admin.query(`UPDATE messages SET status = 'sent' WHERE status = 'queued'`);
      await tick(i * 7000 + 30_000);
    }
    expect((await recipients(d.id)).filter((r) => r.message_id).length).toBe(1); // 1 de la primera + 1 de esta = 2 en la conexión
    expect((await ok<{ limits: { official_daily_cap: number } }>(await call('GET', '/campaigns/options', T.alice))).limits.official_daily_cap).toBe(2);
    // el tope del ASESOR cuenta todas sus campañas
    await admin.query(`UPDATE campaigns SET next_send_at = NULL`);
    await call('PUT', '/campaigns/settings', T.alice, { official_daily_cap: 1000 });
    await ok(await call('PUT', `/campaigns/advisor-limits/${IDS.alice}`, T.alice, { daily_cap: 2 }));
    await tick(120_000);
    expect((await recipients(d.id)).filter((r) => r.message_id).length).toBe(1); // alice ya mandó 2 hoy
    const audit = (await admin.query(`SELECT old_value, new_value FROM audit_logs WHERE entity_type = 'campaign_settings' ORDER BY at, id`)).rows;
    expect(audit.map((r) => [r.old_value, r.new_value])).toEqual([[null, 2], [2, 1000]]);
  });

  it('los estados salen de los mensajes (en cola → enviado → entregado → leído), nunca retroceden, y los totales de la campaña son acumulados; un fallo del contacto no frena la campaña', async () => {
    await people(['Ana', 'Beto', 'Cata']);
    const c = await mk(T.alice, tplBody({ gap_seconds: 5 }));
    await ok(await launch(T.alice, c.id), 201);
    await tick(1000);
    await tick(7000);
    let rows = await recipients(c.id);
    const [m1, m2] = rows.filter((r) => r.message_id).map((r) => r.message_id!);
    await admin.query(`UPDATE messages SET status = 'read', delivered_at = now(), read_at = now() WHERE id = $1`, [m1]);
    await admin.query(`UPDATE messages SET status = 'failed', error = 'WhatsApp no pudo entregar el mensaje a este número', meta = meta || '{"error_code":"recipient_invalid"}'::jsonb WHERE id = $1`, [m2]);
    await tick(14_000);
    rows = await recipients(c.id);
    expect(rows.find((r) => r.message_id === m1)!.status).toBe('read');
    expect(rows.find((r) => r.message_id === m2)).toMatchObject({ status: 'failed', error: 'WhatsApp no pudo entregar el mensaje a este número' });
    expect((await dbCamp(c.id)).status).toBe('running'); // el problema fue del número, no de la conexión
    await admin.query(`UPDATE messages SET status = 'sent' WHERE id = $1`, [m1]); // un aviso atrasado no baja el estado
    await tick(21_000);
    expect((await recipients(c.id)).find((r) => r.message_id === m1)!.status).toBe('read');
    const v = await ok<Camp>(await call('GET', `/campaigns/${c.id}`, T.alice));
    expect(v.counts).toMatchObject({ total: 3, sent: 1, delivered: 1, read: 1, failed: 1 }); // acumulados: el leído cuenta como entregado y enviado; el que sigue «en cola» y el fallido no
    expect((await admin.query(`SELECT delivered_at IS NOT NULL AS d, read_at IS NOT NULL AS r FROM campaign_recipients WHERE message_id = $1`, [m1])).rows[0]).toEqual({ d: true, r: true });
  });

  it('un fallo de la conexión o del límite de WhatsApp PAUSA la campaña con su motivo; reanudarla la hace seguir; si la conexión se apaga o la plantilla deja de estar aprobada, también se pausa', async () => {
    await people(['Ana', 'Beto', 'Cata', 'Dani']);
    const c = await mk(T.alice, tplBody({ gap_seconds: 5 }));
    await ok(await launch(T.alice, c.id), 201);
    await tick(1000);
    const first = (await recipients(c.id)).find((r) => r.message_id)!;
    await admin.query(`UPDATE messages SET status = 'failed', error = 'WhatsApp limitó los envíos', meta = meta || '{"error_code":"rate_limited"}'::jsonb WHERE id = $1`, [first.message_id]);
    await tick(8000);
    expect(await dbCamp(c.id)).toMatchObject({ status: 'paused', status_reason: expect.stringContaining('limitó los envíos') });
    expect(await tick(20_000)).toBe(0); // pausada: no sale nada
    const paused = await ok<Camp>(await call('GET', `/campaigns/${c.id}`, T.alice));
    expect(paused).toMatchObject({ status: 'paused', can_resume: true, can_pause: false });
    expect(paused.status_reason).toContain('limitó');
    expect(await ok<Camp>(await act(T.alice, c.id, 'resume'))).toMatchObject({ status: 'running', status_reason: null });
    await tick(30_000);
    expect((await recipients(c.id)).filter((r) => r.message_id).length).toBe(2);
    // la conexión se desactiva
    await admin.query(`UPDATE channel_accounts SET status = 'disabled' WHERE id = $1`, [officialA]);
    await tick(40_000);
    expect(await dbCamp(c.id)).toMatchObject({ status: 'paused', status_reason: expect.stringContaining('conexión') });
    await admin.query(`UPDATE channel_accounts SET status = 'active' WHERE id = $1`, [officialA]);
    await ok(await act(T.alice, c.id, 'resume'));
    // la plantilla deja de estar aprobada
    await admin.query(`UPDATE message_templates SET status = 'paused', sendable = false, unsupported_reason = 'Meta la pausó' WHERE id = $1`, [tplA]);
    await tick(60_000);
    expect(await dbCamp(c.id)).toMatchObject({ status: 'paused', status_reason: expect.stringContaining('plantilla') });
  });

  it('pausar, reanudar y cancelar: el estado importa (409), quien la creó o quien tiene campaigns.cancel (el administrador) puede, un asesor no toca las ajenas (404); cancelar deja lo pendiente como omitido y no sale nada más', async () => {
    await people(['Ana', 'Beto', 'Cata']);
    await mkContact({ owner: IDS.carol, name: 'De Carolina' });
    await mkContact({ owner: IDS.carol, name: 'De Carolina 2' });
    const mine = await mk(T.carol, tplBody({ name: 'De Carolina', gap_seconds: 5 }));
    const others = await mk(T.alice, tplBody({ name: 'De Alicia', gap_seconds: 5 }));
    await ok(await launch(T.carol, mine.id), 201);
    await ok(await launch(T.alice, others.id), 201);
    await ok(await act(T.alice, others.id, 'pause')); // la de Alicia no debe enviar nada mientras se prueban las demás cosas
    for (const w of ['pause', 'resume', 'cancel'] as const) {
      expect((await act(T.bob, mine.id, w)).status, `B ${w}`).toBe(404);
      expect((await act(T.eve, mine.id, w)).status, `sin permiso ${w}`).toBe(403);
      expect((await act(T.carol, others.id, w)).status, `ajena ${w}`).toBe(404);
    }
    expect((await act(T.carol, mine.id, 'resume')).status).toBe(409); // no está pausada
    expect(await ok<Camp>(await act(T.carol, mine.id, 'pause'))).toMatchObject({ status: 'paused', status_reason: 'Pausada a mano' });
    expect((await act(T.carol, mine.id, 'pause')).status).toBe(409);
    expect(await tick(5000)).toBeGreaterThanOrEqual(0);
    expect((await recipients(mine.id)).filter((r) => r.message_id)).toHaveLength(0); // pausada: no sale
    // el administrador (campaigns.cancel) puede con la de Carolina
    expect(await ok<Camp>(await act(T.alice, mine.id, 'resume'))).toMatchObject({ status: 'running' });
    await tick(8000);
    expect((await recipients(mine.id)).filter((r) => r.message_id)).toHaveLength(1);
    // a mitad: lo ya enviado queda y lo pendiente se cancela
    await ok(await act(T.carol, mine.id, 'cancel'));
    expect((await recipients(mine.id)).map((r) => r.status)).toEqual(['queued', 'skipped']);
    const done = await ok<Camp>(await act(T.alice, others.id, 'cancel'));
    expect(done).toMatchObject({ status: 'cancelled', can_cancel: false, can_pause: false });
    const rows = await recipients(others.id);
    expect(rows.every((r) => r.status === 'skipped' && r.skip_reason === 'cancelled')).toBe(true);
    await tick(20_000);
    expect((await messagesOf(others.id)).length).toBe(0);
    expect((await messagesOf(mine.id)).length).toBe(1); // y a la cancelada no le sale nada más
    expect((await act(T.alice, others.id, 'cancel')).status).toBe(409);
    expect((await dbCamp(others.id)).finished_at).not.toBeNull();
    const log = (await admin.query(`SELECT field FROM audit_logs WHERE entity_type = 'campaign' AND entity_id = $1 ORDER BY at, id`, [mine.id])).rows.map((r) => r.field);
    expect(log).toEqual([null, 'launched', 'paused', 'resumed', 'cancelled']);
  });

  it('programar: no sale nada antes de su hora; al llegar la hora pasa a «en curso» y envía', async () => {
    await people(['Ana', 'Beto']);
    const c = await mk(T.alice, tplBody({ gap_seconds: 5, scheduled_at: new Date(Date.now() + 3 * 3600_000).toISOString() }));
    const l = await ok<Camp>(await launch(T.alice, c.id), 201);
    expect(l.status).toBe('scheduled');
    expect(l.can_pause).toBe(true);
    await tick(10_000);
    expect(await messagesOf(c.id)).toHaveLength(0);
    await admin.query(`UPDATE campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [c.id]);
    await tick(10_000);
    expect((await dbCamp(c.id)).status).toBe('running');
    await tick(20_000);
    expect((await messagesOf(c.id)).length).toBeGreaterThan(0);
  });

  it('dos pasadas a la vez (dos instancias) no duplican el mensaje de ningún contacto', async () => {
    await people(['Ana', 'Beto', 'Cata', 'Dani', 'Eli']);
    const c = await mk(T.alice, tplBody({ gap_seconds: 5 }));
    await ok(await launch(T.alice, c.id), 201);
    await Promise.all([tick(1000), tick(1000), tick(1000), tick(1000)]);
    const msgs = await messagesOf(c.id);
    expect(msgs).toHaveLength(1);
    expect(new Set(msgs.map((m) => m.contact)).size).toBe(msgs.length);
    await admin.query(`UPDATE messages SET status = 'sent' WHERE id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [c.id]);
    for (let i = 1; i <= 12; i += 1) {
      await Promise.all([tick(i * 6000), tick(i * 6000)]);
      await admin.query(`UPDATE messages SET status = 'sent' WHERE id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [c.id]);
    }
    const all = await messagesOf(c.id);
    expect(all).toHaveLength(5);
    expect(new Set(all.map((m) => m.contact)).size).toBe(5); // uno por contacto: ninguno duplicado
    expect((await dbCamp(c.id)).status).toBe('completed');
  });

  it('A↔B: la tarea de una empresa no toca las campañas de otra; la empresa B envía por su propia conexión', async () => {
    await people(['De A']);
    await mkContact({ org: ORG_B, owner: IDS.bob, name: 'De B' });
    const a = await mk(T.alice, tplBody({ gap_seconds: 5 }));
    const b = await mk(T.bob, tplBody({ channel_id: officialB, template_id: tplB, gap_seconds: 5 }));
    await ok(await launch(T.alice, a.id), 201);
    await ok(await launch(T.bob, b.id), 201);
    await tick(1000, ORG_A);
    expect(await messagesOf(a.id)).toHaveLength(1);
    expect(await messagesOf(b.id)).toHaveLength(0); // B todavía no tuvo su pasada
    await tick(1000, ORG_B);
    const mb = await messagesOf(b.id);
    expect(mb).toHaveLength(1);
    expect(mb[0]!.contact).toBe('De B');
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.organization_id = $1 AND m.sender_type = 'campaign'`, [ORG_B])).rows[0].n).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('envío por WhatsApp QR (17.4)', () => {
  const sender = (): CampaignSenderService => app.get(CampaignSenderService);
  const tick = (offsetMs = 1000, org = ORG_A): Promise<number> => TenantContext.run({ organizationId: org }, () => sender().runDue(new Date(Date.now() + offsetMs)));
  const launchQr = (token: string, id: string, body?: unknown) => call('POST', `/campaigns/${id}/launch`, token, body, { 'idempotency-key': key() });
  const act = (token: string, id: string, what: 'pause' | 'resume' | 'cancel') => call('POST', `/campaigns/${id}/${what}`, token);
  const recipients = async (id: string) => (await admin.query(`SELECT r.status, r.skip_reason, r.error, r.message_id, c.name FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.campaign_id = $1 ORDER BY c.name`, [id])).rows as Array<{ status: string; skip_reason: string | null; error: string | null; message_id: string | null; name: string }>;
  const dbCamp = async (id: string) => (await admin.query(`SELECT status, status_reason, next_send_at FROM campaigns WHERE id = $1`, [id])).rows[0] as { status: string; status_reason: string | null; next_send_at: Date | null };
  const messagesOf = async (id: string) => (await admin.query(`SELECT m.id, m.sender_type, m.kind, m.direction, m.status, m.body, c.name AS contact FROM messages m JOIN conversations v ON v.id = m.conversation_id JOIN contacts c ON c.id = v.contact_id WHERE m.id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1) ORDER BY m.sent_at, m.id`, [id])).rows as Array<{ id: string; sender_type: string; kind: string; direction: string; status: string; body: string; contact: string }>;
  const markSent = (): Promise<unknown> => admin.query(`UPDATE messages SET status = 'sent' WHERE status = 'queued' AND sender_type = 'campaign'`);
  const people = async (names: string[], over: Parameters<typeof mkContact>[0] = {}) => { for (const n of names) await mkContact({ owner: IDS.alice, name: n, ...over }); };

  it('lanzar por QR exige aceptar el aviso de riesgo y una sesión conectada; queda registrado en la auditoría', async () => {
    await people(['Ana', 'Beto']);
    const c = await mk(T.alice, textBody({ gap_seconds: 45 }));
    const noRisk = await launchQr(T.alice, c.id);
    expect(noRisk.status).toBe(409);
    expect(await code(noRisk)).toBe('QR_RISK_NOT_ACCEPTED');
    expect((await launchQr(T.alice, c.id, { accept_qr_risk: false })).status).toBe(409);
    expect((await launchQr(T.alice, c.id, { otra: true })).status).toBe(400); // cuerpo estricto
    await admin.query(`UPDATE qr_accounts SET state = 'closed' WHERE channel_account_id = $1`, [qrAdmin]);
    const down = await launchQr(T.alice, c.id, { accept_qr_risk: true });
    expect(down.status).toBe(409);
    expect(await code(down)).toBe('QR_SESSION_DOWN');
    await admin.query(`UPDATE qr_accounts SET state = 'open' WHERE channel_account_id = $1`, [qrAdmin]);
    const ok1 = await ok<Camp>(await launchQr(T.alice, c.id, { accept_qr_risk: true }), 201);
    expect(ok1).toMatchObject({ status: 'running', mode: 'text', counts: { total: 2 } });
    const log = (await admin.query(`SELECT field, new_value FROM audit_logs WHERE entity_type = 'campaign' AND entity_id = $1 AND field = 'launched'`, [c.id])).rows[0] as { new_value: Record<string, unknown> };
    expect(log.new_value).toMatchObject({ status: 'running', recipients: 2, qr_risk_accepted: true });
    expect(JSON.stringify(log.new_value)).not.toContain('Hola'); // nunca el texto
    // una campaña oficial no necesita el aviso (lo sigue aceptando sin cuerpo)
    const off = await mk(T.alice, tplBody({ name: 'Oficial' }));
    expect((await launchQr(T.alice, off.id)).status).toBe(201);
  });

  it('el texto sale de a UNO con la pausa mínima de 45 s, personalizado por contacto, abriendo su conversación con su responsable, sin plantilla, sin reparto, sin Lead; la baja posterior y el dato que falta se descartan', async () => {
    const f = await ok<{ key: string }>(await call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' }), 201);
    const ana = await mkContact({ owner: IDS.carol, name: 'Ana Lema' });
    const beto = await mkContact({ owner: null, name: 'Beto Vera' });
    const sinCiudad = await mkContact({ owner: IDS.alice, name: 'Sin Ciudad' });
    const baja = await mkContact({ owner: IDS.alice, name: 'Pidió Baja' });
    for (const id of [ana, beto, baja]) await ok(await call('PATCH', `/contacts/${id}`, T.alice, { custom_fields: { [f.key]: 'Quito' } }));
    const c = await mk(T.alice, textBody({ gap_seconds: 45, daily_cap: 50, body: 'Hola {{primer_nombre}} de {{contact.ciudad}}, ¿te reservo un cupo?' }));
    await ok(await launchQr(T.alice, c.id, { accept_qr_risk: true }), 201);
    await admin.query(`UPDATE contacts SET consent = 'revoked' WHERE id = $1`, [baja]); // pide la baja DESPUÉS de lanzar
    expect(await tick(1000)).toBeGreaterThan(0);
    expect((await messagesOf(c.id)).length).toBe(1);
    expect(await tick(20_000)).toBe(0); // la pausa de 45 s no pasó
    expect((await dbCamp(c.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now() + 40_000);
    await markSent();
    for (let i = 2; i <= 6; i += 1) {
      await tick(i * 50_000);
      await markSent();
    }
    const rows = await recipients(c.id);
    expect(rows.find((r) => r.name === 'Pidió Baja')).toMatchObject({ status: 'skipped', skip_reason: 'revoked', message_id: null });
    expect(rows.find((r) => r.name === 'Sin Ciudad')).toMatchObject({ status: 'skipped', skip_reason: 'missing_variable', message_id: null });
    expect(sinCiudad).toBeTruthy();
    expect((await dbCamp(c.id)).status).toBe('completed');
    const msgs = await messagesOf(c.id);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.kind === 'text' && m.direction === 'out' && m.sender_type === 'campaign')).toBe(true);
    expect(msgs.map((m) => m.body).sort()).toEqual(['Hola Ana de Quito, ¿te reservo un cupo?', 'Hola Beto de Quito, ¿te reservo un cupo?']);
    // conversaciones: nuevas y «pendientes» para su responsable (Ana: Carolina; Beto sin responsable: quien creó la campaña); sin Lead, sin reparto, sin cronómetros
    const convs = (await admin.query(`SELECT c.name, v.status, v.owner_id, a.provider FROM conversations v JOIN contacts c ON c.id = v.contact_id JOIN channel_accounts a ON a.id = v.channel_account_id ORDER BY c.name`)).rows as Array<{ name: string; status: string; owner_id: string; provider: string }>;
    expect(convs).toEqual([{ name: 'Ana Lema', status: 'pending', owner_id: IDS.carol, provider: 'evolution' }, { name: 'Beto Vera', status: 'pending', owner_id: IDS.alice, provider: 'evolution' }]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM contact_tags`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM response_timers`)).rows[0].n).toBe(0);
  });

  it('si la sesión se cae, la campaña se PAUSA con aviso y no se envía por otro canal; al volver a conectar y reanudar sigue; un mensaje que falló por la sesión también la pausa', async () => {
    await people(['Ana', 'Beto', 'Cata', 'Dani']);
    const c = await mk(T.alice, textBody({ gap_seconds: 45 }));
    await ok(await launchQr(T.alice, c.id, { accept_qr_risk: true }), 201);
    await tick(1000);
    await markSent();
    await admin.query(`UPDATE qr_accounts SET state = 'closed' WHERE channel_account_id = $1`, [qrAdmin]);
    await tick(50_000);
    expect(await dbCamp(c.id)).toMatchObject({ status: 'paused', status_reason: expect.stringContaining('sesión') });
    expect((await messagesOf(c.id)).length).toBe(1); // nada salió con la sesión caída
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages m JOIN channel_accounts a ON a.id = m.channel_account_id WHERE a.provider <> 'evolution' AND m.sender_type = 'campaign'`)).rows[0].n).toBe(0); // y nunca por otra vía
    await admin.query(`UPDATE qr_accounts SET state = 'open' WHERE channel_account_id = $1`, [qrAdmin]);
    expect(await ok<Camp>(await act(T.alice, c.id, 'resume'))).toMatchObject({ status: 'running' });
    await tick(100_000);
    expect((await messagesOf(c.id)).length).toBe(2);
    // el despachador da por fallido un mensaje tras 24 h de sesión caída: esa causa también pausa la campaña
    const last = (await messagesOf(c.id)).at(-1)!;
    await admin.query(`UPDATE messages SET status = 'failed', error = 'La sesión de WhatsApp por QR estuvo caída más de 24 horas', meta = meta || '{"error_code":"qr_session_down"}'::jsonb WHERE id = $1`, [last.id]);
    await tick(110_000);
    expect(await dbCamp(c.id)).toMatchObject({ status: 'paused', status_reason: expect.stringContaining('se cayó') });
  });

  it('una campaña por QR nunca usa más del 70 % del cupo del calentamiento del día (el resto queda para las conversaciones): entre dos campañas en el mismo chip, 14 de 20', async () => {
    await admin.query(`UPDATE qr_accounts SET first_connected_at = now() WHERE channel_account_id = $1`, [qrAdmin]); // chip recién conectado: 20 al día → 14 para campañas
    for (let i = 1; i <= 12; i += 1) await mkContact({ owner: IDS.alice, name: `Contacto ${String(i).padStart(2, '0')}` });
    const a = await mk(T.alice, textBody({ name: 'Primera', gap_seconds: 45, daily_cap: 10 }));
    const b = await mk(T.alice, textBody({ name: 'Segunda', gap_seconds: 45, daily_cap: 10 }));
    expect((await create(T.alice, textBody({ name: 'Pasada de tope', daily_cap: 15 }))).status).toBe(400); // ni siquiera se puede pedir más de 14
    await ok(await launchQr(T.alice, a.id, { accept_qr_risk: true }), 201);
    await ok(await launchQr(T.alice, b.id, { accept_qr_risk: true }), 201);
    for (let i = 1; i <= 40; i += 1) {
      await tick(i * 50_000);
      await markSent();
    }
    const na = (await messagesOf(a.id)).length;
    const nb = (await messagesOf(b.id)).length;
    expect(na + nb).toBe(14); // el 70 % de 20
    expect(Math.max(na, nb)).toBeLessThanOrEqual(10); // y cada una, su propio tope
    expect(sender()).toBeTruthy();
  });

  it('A↔B y asesor: la campaña de B por su chip no toca a A; el asesor solo lanza por el chip que él creó', async () => {
    await mkContact({ owner: IDS.carol, name: 'De Carolina' });
    await mkContact({ org: ORG_B, owner: IDS.bob, name: 'De B' });
    const qrB = await qrChannel(ORG_B, 'Chip de B', IDS.bob);
    const own = await mk(T.carol, textBody({ channel_id: qrCarol, gap_seconds: 45 }));
    const b = await mk(T.bob, textBody({ channel_id: qrB, gap_seconds: 45 }));
    expect((await launchQr(T.carol, own.id, { accept_qr_risk: true })).status).toBe(201);
    expect((await launchQr(T.bob, own.id, { accept_qr_risk: true })).status).toBe(404); // de otra empresa
    expect((await launchQr(T.bob, b.id, { accept_qr_risk: true })).status).toBe(201);
    await tick(1000, ORG_A);
    expect((await messagesOf(own.id)).map((m) => m.contact)).toEqual(['De Carolina']);
    expect(await messagesOf(b.id)).toHaveLength(0); // B todavía no tuvo su pasada
    await tick(1000, ORG_B);
    expect((await messagesOf(b.id)).map((m) => m.contact)).toEqual(['De B']);
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.organization_id = $1 AND m.sender_type = 'campaign'`, [ORG_A])).rows[0].n).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('resultados, CSV y baja por palabra clave (17.5)', () => {
  const sender = (): CampaignSenderService => app.get(CampaignSenderService);
  const tick = (offsetMs = 1000, org = ORG_A): Promise<number> => TenantContext.run({ organizationId: org }, () => sender().runDue(new Date(Date.now() + offsetMs)));
  const launchQr = (token: string, id: string) => call('POST', `/campaigns/${id}/launch`, token, { accept_qr_risk: true }, { 'idempotency-key': key() });
  const recipients = async (id: string) => (await admin.query(`SELECT r.status, r.skip_reason, r.message_id, r.conversation_id, r.replied_at, r.opted_out_at, r.contact_id, c.name FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.campaign_id = $1 ORDER BY c.name`, [id])).rows as Array<{ status: string; skip_reason: string | null; message_id: string | null; conversation_id: string | null; replied_at: Date | null; opted_out_at: Date | null; contact_id: string; name: string }>;
  const byName = (rows: Awaited<ReturnType<typeof recipients>>, name: string) => rows.find((r) => r.name === name)!;
  /** Envía todo lo que la campaña tiene pendiente (las pasadas de la tarea) y deja los mensajes como «enviados» hace una hora. */
  async function sendAll(id: string, rounds = 8): Promise<void> {
    for (let i = 1; i <= rounds; i += 1) {
      await tick(i * 50_000);
      await admin.query(`UPDATE messages SET status = 'sent', sent_at = now() - interval '1 hour' WHERE status = 'queued' AND sender_type = 'campaign'`);
    }
    await tick((rounds + 1) * 50_000); // la última pasada pone al día los estados
    expect((await admin.query(`SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id])).rows[0].n).toBe(0);
  }
  /** Un mensaje REAL del cliente por el chip QR (el mismo camino que usa el webhook): corre el reparto de siempre y avisa a los oyentes. */
  let seq = 0;
  async function inbound(contactId: string, channel: string, text: string | null, over: Partial<NormalizedMessage> = {}): Promise<void> {
    const phone = (await admin.query(`SELECT e164 FROM contact_phones WHERE contact_id = $1`, [contactId])).rows[0].e164 as string;
    seq += 1;
    const m: NormalizedMessage = { externalId: `ext-in-${Date.now()}-${seq}`, from: phone, fromRaw: phone.slice(1), profileName: null, kind: 'text', text, media: null, extra: {}, sentAt: new Date(), ...over };
    await TenantContext.run({ organizationId: ORG_A }, () => app.get(Database).withTenant((tx) => app.get(ConversationsService).ingestInbound(tx, channel, m, { now: new Date(), timeZone: 'America/Guayaquil', assignable: new Set([IDS.alice]) })));
  }
  const results = (token: string, id: string, qs = '') => call('GET', `/campaigns/${id}/results${qs}`, token);
  const people = async (names: string[], over: Parameters<typeof mkContact>[0] = {}) => {
    const ids: string[] = [];
    for (const n of names) ids.push(await mkContact({ owner: IDS.alice, name: n, ...over }));
    return ids;
  };

  interface Results {
    campaign: Camp;
    summary: { recipients: number; sent: number; delivered: number; read: number; replied: number; failed: number; skipped: number; waiting: number; skipped_by_reason: Record<string, number>; opted_out: number; delivery_rate: number | null; reply_rate: number | null };
    items: Array<{ id: string; contact: { id: string; name: string }; phone: string | null; status: string; skip_reason: string | null; error: string | null; sent_at: string | null; replied_at: string | null; opted_out_at: string | null }>;
    next_cursor: string | null;
  }

  it('responder dentro de las 72 h marca «respondió» (la primera vez, en cada campaña); fuera de la ventana, por otra conexión o a un mensaje que no salió, no cuenta', async () => {
    const [ana, beto, cata] = await people(['Ana', 'Beto', 'Cata']);
    const c = await mk(T.alice, textBody({ gap_seconds: 45, daily_cap: 50 }));
    await ok(await launchQr(T.alice, c.id), 201);
    await sendAll(c.id);
    const rows0 = await recipients(c.id);
    expect(rows0.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    // Beto: su mensaje salió hace 80 h (fuera de la ventana)
    await admin.query(`UPDATE messages SET sent_at = now() - interval '80 hours' WHERE id = $1`, [byName(rows0, 'Beto').message_id]);
    await inbound(ana!, qrAdmin, 'Sí, me interesa');
    await inbound(beto!, qrAdmin, 'Hola, ahora sí');
    // Cata responde por OTRA conexión (el chip de Carolina): no es respuesta a esta campaña
    await inbound(cata!, qrCarol, 'Hola desde otro número');
    let rows = await recipients(c.id);
    expect(byName(rows, 'Ana')).toMatchObject({ status: 'replied' });
    expect(byName(rows, 'Ana').replied_at).not.toBeNull();
    expect(byName(rows, 'Beto').status).toBe('sent');
    expect(byName(rows, 'Cata').status).toBe('sent');
    // una segunda respuesta no cambia la fecha de la primera
    const first = byName(rows, 'Ana').replied_at!.getTime();
    await inbound(ana!, qrAdmin, 'Otra pregunta');
    rows = await recipients(c.id);
    expect(byName(rows, 'Ana').replied_at!.getTime()).toBe(first);
    // el estado de entrega que llega tarde no baja a quien ya respondió
    await tick(600_000);
    expect(byName(await recipients(c.id), 'Ana').status).toBe('replied');
    const v = await ok<Camp>(await call('GET', `/campaigns/${c.id}`, T.alice));
    expect(v.counts).toMatchObject({ total: 3, sent: 3, delivered: 1, read: 1, replied: 1 }); // acumulados
  });

  it('«BAJA», «STOP»… (el mensaje entero) tras una campaña: el contacto queda «No contactar», lo pendiente en cualquier campaña se descarta y hay una nota interna; una frase parecida no revoca', async () => {
    const [ana, beto, cata, dani] = await people(['Ana', 'Beto', 'Cata', 'Dani']);
    const c = await mk(T.alice, textBody({ gap_seconds: 45, daily_cap: 50 }));
    await ok(await launchQr(T.alice, c.id), 201);
    await sendAll(c.id);
    // Ana está además en OTRA campaña que aún no sale (pendiente): ya no le llegará
    const other = await mk(T.alice, textBody({ name: 'Otra campaña', audience: { source: 'all', excluded_contact_ids: [beto, cata, dani] } }));
    await ok(await launchQr(T.alice, other.id), 201);
    await inbound(ana!, qrAdmin, '¡BAJA!');
    await inbound(beto!, qrAdmin, 'quiero dar de baja mi plan'); // no es una baja de mensajes
    await inbound(cata!, qrAdmin, 'Cancelar mi cita por favor'); // tampoco
    await inbound(dani!, qrAdmin, 'No más', { kind: 'image' }); // una imagen no es una petición escrita
    const consent = async (id: string) => (await admin.query(`SELECT consent FROM contacts WHERE id = $1`, [id])).rows[0].consent as string;
    expect(await consent(ana!)).toBe('revoked');
    for (const id of [beto, cata, dani]) expect(await consent(id!)).toBe('granted');
    const rows = await recipients(c.id);
    expect(byName(rows, 'Ana')).toMatchObject({ status: 'replied' });
    expect(byName(rows, 'Ana').opted_out_at).not.toBeNull();
    expect(byName(rows, 'Beto').opted_out_at).toBeNull();
    expect(byName(await recipients(other.id), 'Ana')).toMatchObject({ status: 'skipped', skip_reason: 'revoked' });
    // la nota interna queda en la conversación (una sola) y la auditoría registra el cambio de consentimiento con su origen
    const notes = (await admin.query(`SELECT body, status, sender_type, kind FROM messages WHERE conversation_id = $1 AND kind = 'note'`, [byName(rows, 'Ana').conversation_id])).rows as Array<{ body: string; status: string; sender_type: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ status: 'internal', sender_type: 'system' });
    expect(notes[0]!.body).toContain('pidió la baja');
    const log = (await admin.query(`SELECT old_value, new_value, source FROM audit_logs WHERE entity_type = 'contact' AND entity_id = $1 AND field = 'consent'`, [ana])).rows as Array<{ old_value: string; new_value: string; source: string }>;
    expect(log).toEqual([{ old_value: 'granted', new_value: 'revoked', source: 'automation' }]);
    expect((await audit(c.id)).some((a) => a.field === 'opt_out')).toBe(true);
    // volver a pedirla no repite la nota ni cambia nada
    await inbound(ana!, qrAdmin, 'STOP');
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND kind = 'note'`, [byName(rows, 'Ana').conversation_id])).rows[0].n).toBe(1);
    // una campaña nueva a toda la base ya no incluye a Ana
    const next = await mk(T.alice, textBody({ name: 'Después' }));
    const p = await preview(T.alice, next.id);
    expect(p.audience.skipped.revoked).toBe(1);
  });

  it('una baja fuera de las 72 h, o de alguien que nunca recibió una campaña, no revoca; un fallo al anotar nunca impide guardar el mensaje del cliente', async () => {
    const [ana, zeta] = await people(['Ana', 'Zeta']);
    const c = await mk(T.alice, textBody({ gap_seconds: 45, daily_cap: 50, audience: { source: 'all', excluded_contact_ids: [zeta] } }));
    await ok(await launchQr(T.alice, c.id), 201);
    await sendAll(c.id);
    await admin.query(`UPDATE messages SET sent_at = now() - interval '100 hours' WHERE sender_type = 'campaign'`);
    await inbound(ana!, qrAdmin, 'BAJA'); // la campaña le llegó hace más de 72 h: es solo un mensaje más
    await inbound(zeta!, qrAdmin, 'BAJA'); // nunca recibió una campaña
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE consent = 'revoked'`)).rows[0].n).toBe(0);
    expect(byName(await recipients(c.id), 'Ana').status).toBe('sent');
    // un fallo del oyente (aquí, un contacto con un identificador roto) se traga y el mensaje del cliente se guarda igual
    const svc = app.get(CampaignResponsesService);
    const conv = byName(await recipients(c.id), 'Ana').conversation_id!;
    const after = await TenantContext.run({ organizationId: ORG_A }, () =>
      app.get(Database).withTenant(async (tx) => {
        await svc.onEvent(tx, { type: 'message_received', contactId: 'no-es-un-uuid', key: 'k', channelId: qrAdmin, conversationId: conv, kind: 'text', messageId: 'tampoco' });
        return (await tx.execute(sql`SELECT 1 AS ok`)).rows[0];
      }),
    );
    expect(after).toEqual({ ok: 1 }); // la transacción sigue sana
  });

  it('el informe: totales acumulados, tasas, omitidos por motivo y cada destinatario con su estado, por páginas y por estado; el asesor ve solo lo suyo; otra empresa no existe', async () => {
    const [ana] = await people(['Ana', 'Beto', 'Cata', 'Dani']);
    await mkContact({ owner: IDS.alice, name: 'Eli', consent: 'revoked' });
    await mkContact({ owner: IDS.alice, name: 'Fer', phone: null });
    const c = await mk(T.alice, textBody({ gap_seconds: 45, daily_cap: 50 }));
    await ok(await launchQr(T.alice, c.id), 201);
    await sendAll(c.id);
    const rows = await recipients(c.id);
    await admin.query(`UPDATE messages SET status = 'read', delivered_at = now(), read_at = now() WHERE id = $1`, [byName(rows, 'Ana').message_id]);
    await admin.query(`UPDATE messages SET status = 'delivered', delivered_at = now() WHERE id = $1`, [byName(rows, 'Beto').message_id]);
    await admin.query(`UPDATE messages SET status = 'failed', error = 'WhatsApp no pudo entregar el mensaje a este número', meta = meta || '{"error_code":"recipient_invalid"}'::jsonb WHERE id = $1`, [byName(rows, 'Cata').message_id]);
    await tick(900_000);
    await inbound(ana!, qrAdmin, 'Me interesa');
    const r = await ok<Results>(await results(T.alice, c.id));
    expect(r.campaign).toMatchObject({ id: c.id, name: 'Recordatorio de cupos' });
    expect(r.summary).toEqual({ recipients: 6, sent: 3, delivered: 2, read: 1, replied: 1, failed: 1, skipped: 2, waiting: 0, skipped_by_reason: { revoked: 1, no_phone: 1 }, opted_out: 0, delivery_rate: 0.667, reply_rate: 0.333 });
    expect(r.items.map((i) => [i.contact.name, i.status])).toEqual(expect.arrayContaining([['Ana', 'replied'], ['Beto', 'delivered'], ['Cata', 'failed'], ['Dani', 'sent'], ['Eli', 'skipped'], ['Fer', 'skipped']]));
    expect(r.items.find((i) => i.contact.name === 'Eli')).toMatchObject({ skip_reason: 'revoked', sent_at: null });
    expect(r.items.find((i) => i.contact.name === 'Cata')!.error).toBe('WhatsApp no pudo entregar el mensaje a este número');
    // por estado y por páginas (sin repetir ni saltar)
    const failed = await ok<Results>(await results(T.alice, c.id, '?status=failed'));
    expect(failed.items.map((i) => i.contact.name)).toEqual(['Cata']);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      const page: Results = await ok<Results>(await results(T.alice, c.id, `?limit=4${cursor ? `&cursor=${cursor}` : ''}`));
      seen.push(...page.items.map((x) => x.contact.name));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(['Ana', 'Beto', 'Cata', 'Dani', 'Eli', 'Fer']);
    expect((await results(T.alice, c.id, '?status=nada')).status).toBe(400);
    expect((await results(T.alice, c.id, '?cursor=@@@')).status).toBe(400);
    // quién ve qué: Carolina (con campañas) NO ve la del administrador; la suya sí
    expect((await results(T.carol, c.id)).status).toBe(404);
    const mine = await mk(T.carol, textBody({ name: 'De Carolina', channel_id: qrCarol }));
    expect((await results(T.carol, mine.id)).status).toBe(200);
    expect((await results(T.alice, mine.id)).status).toBe(200); // el administrador ve todas
    // otra empresa, sin permiso y sin sesión
    expect((await results(T.bob, c.id)).status).toBe(404);
    expect((await results(T.eve, c.id)).status).toBe(403);
    expect((await results(T.root, c.id)).status).toBe(403);
    expect((await call('GET', `/campaigns/${c.id}/results`)).status).toBe(401);
    expect((await results(T.alice, NOBODY)).status).toBe(404);
  });

  it('CSV: BOM, encabezados en español, una fila por destinatario, celdas con fórmulas neutralizadas y estados en español; queda auditado sin nombres ni teléfonos; solo de campañas que ves', async () => {
    const [ana] = await people(['=SUMA(A1)', 'Beto']);
    await mkContact({ owner: IDS.alice, name: 'Eli', consent: 'revoked' });
    const c = await mk(T.alice, textBody({ name: 'Campaña de Noviembre', gap_seconds: 45, daily_cap: 50 }));
    await ok(await launchQr(T.alice, c.id), 201);
    await sendAll(c.id);
    await inbound(ana!, qrAdmin, 'Hola');
    const r = await call('POST', `/campaigns/${c.id}/export`, T.alice);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="campana-campana-de-noviembre-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers.get('x-export-count')).toBe('3');
    // `fetch().text()` quita el BOM al decodificar: se leen los bytes crudos para comprobarlo
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, '');
    expect(text.startsWith('Contacto,Teléfono,Estado,Motivo de omisión,En cola,Enviado,Entregado,Leído,Respondió,Falló,Error,Pidió la baja,Versión\r\n')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.includes('SUMA'))!.startsWith("'=SUMA(A1),")).toBe(true); // la fórmula no se ejecuta al abrir el archivo
    expect(lines.find((l) => l.includes('SUMA'))).toContain('Respondió');
    expect(lines.find((l) => l.startsWith('Beto'))).toContain('Enviado');
    expect(lines.find((l) => l.startsWith('Eli'))).toContain('Omitido,No contactar');
    // auditoría: quién descargó y cuántas filas; nunca nombres ni teléfonos
    const log = (await audit(c.id)).find((a) => a.field === 'exported')!;
    expect(log.new_value).toMatchObject({ count: 3, by: IDS.alice });
    expect(JSON.stringify(log.new_value)).not.toMatch(/Beto|\+593/);
    // Carolina no puede bajar la de otra persona; otra empresa, sin permiso y sin sesión tampoco
    expect((await call('POST', `/campaigns/${c.id}/export`, T.carol)).status).toBe(404);
    expect((await call('POST', `/campaigns/${c.id}/export`, T.bob)).status).toBe(404);
    expect((await call('POST', `/campaigns/${c.id}/export`, T.eve)).status).toBe(403);
    expect((await call('POST', `/campaigns/${c.id}/export`, T.root)).status).toBe(403);
    expect((await call('POST', `/campaigns/${c.id}/export`)).status).toBe(401);
    const mine = await mk(T.carol, textBody({ name: 'De Carolina', channel_id: qrCarol }));
    expect((await call('POST', `/campaigns/${mine.id}/export`, T.carol)).status).toBe(200);
  });

  it('resumen del periodo para Analítica: campañas lanzadas en el periodo con lo que dieron; el asesor solo las suyas, el administrador todas; una empresa no suma a otra; el plan se exige', async () => {
    const [ana] = await people(['Ana', 'Beto']);
    const c = await mk(T.alice, textBody({ gap_seconds: 45, daily_cap: 50 }));
    await ok(await launchQr(T.alice, c.id), 201);
    await sendAll(c.id);
    await inbound(ana!, qrAdmin, 'BAJA');
    await mk(T.alice, textBody({ name: 'Borrador sin lanzar' })); // un borrador no cuenta
    const s = await ok<{ campaigns: number; recipients: number; sent: number; delivered: number; replied: number; failed: number; skipped: number; opted_out: number; delivery_rate: number | null; reply_rate: number | null; scope: string }>(await call('GET', '/campaigns/summary', T.alice));
    expect(s).toMatchObject({ campaigns: 1, recipients: 2, sent: 2, replied: 1, opted_out: 1, scope: 'all', reply_rate: 0.5 });
    // el asesor ve su alcance: lo suyo (nada); otra empresa, nada
    expect(await ok(await call('GET', '/campaigns/summary', T.carol))).toMatchObject({ campaigns: 0, recipients: 0, scope: 'own', delivery_rate: null, reply_rate: null });
    expect(await ok(await call('GET', '/campaigns/summary', T.bob))).toMatchObject({ campaigns: 0, recipients: 0 });
    // un periodo anterior a su lanzamiento no la incluye; uno inválido es 400
    const past = await ok<{ campaigns: number }>(await call('GET', '/campaigns/summary?from=2020-01-01T00:00:00Z&to=2020-02-01T00:00:00Z', T.alice));
    expect(past.campaigns).toBe(0);
    expect((await call('GET', '/campaigns/summary?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', T.alice)).status).toBe(400);
    expect((await call('GET', '/campaigns/summary?from=2019-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', T.alice)).status).toBe(400);
    expect((await call('GET', '/campaigns/summary', T.eve)).status).toBe(403);
    expect((await call('GET', '/campaigns/summary', T.root)).status).toBe(403);
    expect((await call('GET', '/campaigns/summary')).status).toBe(401);
    const off = (await admin.query(`INSERT INTO plans(id, name, features) VALUES (gen_random_uuid(), 'Básico', '{"campaigns": false}') RETURNING id`)).rows[0].id as string;
    await admin.query(`UPDATE organizations SET plan_id = $1 WHERE id = $2`, [off, ORG_A]);
    const blocked = await call('GET', '/campaigns/summary', T.alice);
    expect(blocked.status).toBe(403);
    expect(await code(blocked)).toBe('PLAN_FEATURE_DISABLED');
    expect((await results(T.alice, c.id)).status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('variantes del mensaje con IA (solo QR)', () => {
  const sender = (): CampaignSenderService => app.get(CampaignSenderService);
  const tick = (offsetMs = 1000, org = ORG_A): Promise<number> => TenantContext.run({ organizationId: org }, () => sender().runDue(new Date(Date.now() + offsetMs)));
  const gen = (token: string | undefined, body: unknown) => call('POST', '/campaigns/variants', token, body);
  const ORIGINAL = 'Hola {{primer_nombre}}, tenemos cupos desde las 10:00 esta semana.';
  const GOOD = ['Buen día {{primer_nombre}}, esta semana hay cupos desde las 10:00.', '{{primer_nombre}}, te cuento que desde las 10:00 tenemos cupos esta semana.', 'Qué tal {{primer_nombre}}: abrimos cupos esta semana, desde las 10:00.'];
  const ledgerRows = async (org = ORG_A) => (await admin.query(`SELECT kind, credits FROM ai_ledger WHERE organization_id = $1 AND kind = 'variants' ORDER BY created_at, id`, [org])).rows as Array<{ kind: string; credits: number }>;
  const chats = () => (app.get<FakeAiProvider>(AI_PROVIDER)).calls.filter((c) => c.kind === 'chat') as Array<{ kind: 'chat'; request: { model: string; messages: Array<{ role: string; content: string }>; temperature: number; maxTokens: number } }>;
  const aiFake = (): FakeAiProvider => app.get<FakeAiProvider>(AI_PROVIDER);

  beforeEach(() => {
    aiFake().calls.length = 0;
    aiFake().clearFailures();
    aiFake().chatReply = () => JSON.stringify([...GOOD, 'Hola {{primer_nombre}}, cupos desde las 18:30', 'Hola {{nombre}}, cupos desde las 10:00', GOOD[0]]);
  });

  interface Gen { variants: string[]; requested: number; rejected: number; credits_used: number; remaining_today: number }

  it('genera versiones con la clave de la plataforma y los créditos de la empresa; descarta las que cambian variables, inventan números o repiten; no guarda nada; queda en el libro como «variants»', async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM campaigns`)).rows[0].n as number;
    const g = await ok<Gen>(await gen(T.alice, { text: ORIGINAL, count: 5 }));
    expect(g.variants).toEqual(GOOD); // las tres buenas, en orden; se cayeron: la que inventa «18:30», la que cambia la variable y la repetida
    expect(g).toMatchObject({ requested: 5, rejected: 3, remaining_today: 19 });
    expect(g.credits_used).toBeGreaterThan(0);
    const rows = await ledgerRows();
    expect(rows).toEqual([{ kind: 'variants', credits: -g.credits_used }]);
    // el modelo recibió las reglas fijas y el texto original como DATOS; ninguna clave de empresa
    const call = chats()[0]!.request;
    expect(call.messages[0]!.content).toContain('Conserva TAL CUAL cada variable');
    expect(call.messages[0]!.content).toContain('5 versiones');
    expect(call.messages[1]!.content).toContain(ORIGINAL);
    expect(call.temperature).toBeGreaterThan(0.5);
    // nada se guardó: las versiones solo viven en el navegador hasta que se guarda la campaña
    expect((await admin.query(`SELECT count(*)::int AS n FROM campaigns`)).rows[0].n).toBe(before);
  });

  it('valida lo que se pide, respeta los permisos, el plan y la empresa; sin créditos, con el tope diario o si la IA falla, no cobra de más', async () => {
    expect((await gen(T.alice, { text: ORIGINAL, count: 0 })).status).toBe(400);
    expect((await gen(T.alice, { text: ORIGINAL, count: 11 })).status).toBe(400);
    expect((await gen(T.alice, { text: '   ', count: 3 })).status).toBe(400);
    expect((await gen(T.alice, { text: 'x'.repeat(1001), count: 3 })).status).toBe(400);
    expect((await gen(T.alice, { text: ORIGINAL, count: 3, extra: 1 })).status).toBe(400);
    expect((await gen(undefined, { text: ORIGINAL, count: 3 })).status).toBe(401);
    expect((await gen(T.root, { text: ORIGINAL, count: 3 })).status).toBe(403);
    expect((await gen(T.eve, { text: ORIGINAL, count: 3 })).status).toBe(403); // sin permiso de campañas
    expect(await ledgerRows()).toEqual([]);
    // la IA falla: se libera la reserva y no se cobra nada
    aiFake().failNext(new AiProviderError('caída', true));
    const down = await gen(T.alice, { text: ORIGINAL, count: 3 });
    expect([502, 503]).toContain(down.status);
    expect(await ledgerRows()).toEqual([]);
    expect((await admin.query(`SELECT status FROM ai_holds WHERE kind = 'variants'`)).rows).toEqual([{ status: 'released' }]);
    // el modelo no entrega nada utilizable: se avisa (el uso ya ocurrió, se cobra)
    aiFake().chatReply = () => 'Lo siento, no puedo ayudar con eso';
    const none = await gen(T.alice, { text: ORIGINAL, count: 3 });
    expect(none.status).toBe(409);
    expect(await code(none)).toBe('VARIANTS_NONE_VALID');
    expect((await ledgerRows()).length).toBe(1);
    // el tope diario por empresa (20 pedidos en 24 h)
    for (let i = 0; i < 19; i += 1) await admin.query(`INSERT INTO ai_ledger(id, organization_id, kind, credits, balance_after) VALUES (gen_random_uuid(), $1, 'variants', -1, 100)`, [ORG_A]);
    const limit = await gen(T.alice, { text: ORIGINAL, count: 3 });
    expect(limit.status).toBe(409);
    expect(await code(limit)).toBe('VARIANTS_DAILY_LIMIT');
    // sin créditos suficientes
    await admin.query(`INSERT INTO ai_wallets(id, organization_id, balance_cache) VALUES (gen_random_uuid(), $1, 0)`, [ORG_B]);
    aiFake().chatReply = () => JSON.stringify(GOOD);
    const poor = await gen(T.bob, { text: ORIGINAL, count: 3 });
    expect(poor.status).toBe(409);
    expect(await code(poor)).toBe('AI_NO_CREDITS');
    // un plan sin «Campañas» no la ofrece
    const off = (await admin.query(`INSERT INTO plans(id, name, features) VALUES (gen_random_uuid(), 'Básico', '{"campaigns": false}') RETURNING id`)).rows[0].id as string;
    await admin.query(`UPDATE organizations SET plan_id = $1 WHERE id = $2`, [off, ORG_A]);
    expect(await code(await gen(T.alice, { text: ORIGINAL, count: 3 }))).toBe('PLAN_FEATURE_DISABLED');
  });

  it('A↔B: lo que se gasta sale del monedero de SU empresa', async () => {
    aiFake().chatReply = () => JSON.stringify(GOOD);
    const g = await ok<Gen>(await gen(T.bob, { text: ORIGINAL, count: 3 }));
    expect(g.variants).toHaveLength(3);
    expect((await ledgerRows(ORG_B)).length).toBe(1);
    expect(await ledgerRows(ORG_A)).toEqual([]);
  });

  it('las versiones se guardan con la campaña por QR (hasta 10, solo texto libre, variables válidas, ninguna repetida); no van en plantillas; copiar la campaña las copia; la auditoría solo cuenta', async () => {
    const c = await mk(T.alice, textBody({ body: ORIGINAL, body_variants: GOOD }));
    expect((c as unknown as { body_variants: string[] }).body_variants).toEqual(GOOD);
    const again = await ok<Camp>(await call('GET', `/campaigns/${c.id}`, T.alice));
    expect((again as unknown as { body_variants: string[] }).body_variants).toEqual(GOOD);
    // editar las versiones
    const edited = await ok<Camp>(await call('PATCH', `/campaigns/${c.id}`, T.alice, { body_variants: [GOOD[0]] }));
    expect((edited as unknown as { body_variants: string[] }).body_variants).toEqual([GOOD[0]]);
    // reglas
    const bad = async (over: Record<string, unknown>) => create(T.alice, textBody({ body: ORIGINAL, ...over }));
    expect((await bad({ body_variants: Array.from({ length: 11 }, (_, i) => `Versión número ${i} {{primer_nombre}}`) })).status).toBe(400);
    expect((await bad({ body_variants: ['Hola {{precio_secreto}}'] })).status).toBe(400); // variable desconocida
    const dup = await bad({ body_variants: [ORIGINAL.toUpperCase(), GOOD[0]] }); // igual al principal (sin importar mayúsculas)
    expect(dup.status).toBe(400);
    expect(JSON.stringify(await dup.json())).toContain('duplicate_variant');
    expect((await bad({ body_variants: ['  '] })).status).toBe(400);
    const tpl = await create(T.alice, tplBody({ body_variants: ['Otra versión'] }));
    expect(tpl.status).toBe(400); // por WhatsApp oficial las versiones no existen
    // copiar la campaña copia las versiones
    const copy = await ok<Camp>(await call('POST', `/campaigns/${c.id}/duplicate`, T.alice, undefined, { 'idempotency-key': key() }), 201);
    expect((copy as unknown as { body_variants: string[] }).body_variants).toEqual([GOOD[0]]);
    // auditoría: solo cuántas versiones, nunca el texto
    const log = (await audit(c.id)).find((a) => a.new_value && 'variants' in a.new_value)!;
    expect(log.new_value).toMatchObject({ variants: 3 });
    expect(JSON.stringify(await audit(c.id))).not.toContain('Buen día');
  });

  it('cada destinatario recibe UNA versión (estable por su id), con sus datos; la versión queda registrada y se ve en el informe y el CSV; sin versiones no se registra nada', async () => {
    const names = ['Ana', 'Beto', 'Cata', 'Dani', 'Eli', 'Fer', 'Gabi', 'Hugo'];
    for (const n of names) await mkContact({ owner: IDS.alice, name: n });
    const c = await mk(T.alice, textBody({ body: ORIGINAL, body_variants: GOOD, gap_seconds: 45, daily_cap: 50 }));
    await ok(await call('POST', `/campaigns/${c.id}/launch`, T.alice, { accept_qr_risk: true }, { 'idempotency-key': key() }), 201);
    for (let i = 1; i <= 12; i += 1) {
      await tick(i * 50_000);
      await admin.query(`UPDATE messages SET status = 'sent' WHERE status = 'queued' AND sender_type = 'campaign'`);
    }
    const rows = (await admin.query(`SELECT r.variant_index AS v, m.body, c.name FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = $1`, [c.id])).rows as Array<{ v: number; body: string; name: string }>;
    expect(rows).toHaveLength(8);
    const pool = [ORIGINAL, ...GOOD];
    for (const r of rows) expect(r.body).toBe(pool[r.v]!.replace('{{primer_nombre}}', r.name)); // la versión elegida, con el nombre de ese contacto
    expect(new Set(rows.map((r) => r.v)).size).toBeGreaterThan(1); // no todos reciben lo mismo
    // el informe y el CSV dicen qué versión recibió cada quien (1 = el mensaje principal)
    const res = await ok<{ items: Array<{ contact: { name: string }; variant: number | null }> }>(await call('GET', `/campaigns/${c.id}/results`, T.alice));
    for (const i of res.items) expect(i.variant).toBe(rows.find((r) => r.name === i.contact.name)!.v + 1);
    const csv = await (await call('POST', `/campaigns/${c.id}/export`, T.alice)).text();
    expect(csv.split('\r\n')[0]).toMatch(/Pidió la baja,Versión$/);
  });
});
