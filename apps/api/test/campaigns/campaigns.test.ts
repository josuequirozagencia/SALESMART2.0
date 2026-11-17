// v17 · 17.1 — Campañas masivas: modelo, permisos y audiencia, SIN enviar (ADR-72). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/campaigns/access
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
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { CampaignsModule } from '../../src/modules/campaigns';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { OrganizationsModule } from '../../src/modules/organizations';
import { TemplatesModule } from '../../src/modules/templates';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, TemplatesModule, CampaignsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
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
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE campaign_recipients, campaign_advisor_limits, campaigns, message_templates, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, qr_accounts, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, custom_field_values, custom_field_definitions, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, plans, users CASCADE');
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
    expect(p.estimate.days).toBe(3);
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
    expect(await ok(await call('GET', '/campaigns/access', T.alice))).toEqual({ plan_enabled: true, read: true, send: true, view_all: true, manage_limits: true });
    expect(await ok(await call('GET', '/campaigns/access', T.carol))).toEqual({ plan_enabled: true, read: true, send: true, view_all: false, manage_limits: false });
    expect(await ok(await call('GET', '/campaigns/access', T.eve))).toEqual({ plan_enabled: true, read: false, send: false, view_all: false, manage_limits: false });
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
