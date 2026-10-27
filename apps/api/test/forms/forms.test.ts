// M9.1 — Formularios embebibles (ADR-09/54; F07): administración y recepción pública. Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/forms
//   POST /v1/forms
//   GET /v1/forms/:id
//   PATCH /v1/forms/:id
//   PUT /v1/forms/:id/fields
//   POST /v1/forms/:id/publish
//   POST /v1/forms/:id/pause
//   GET /v1/forms/:id/submissions
//   DELETE /v1/forms/:id
//   GET /v1/public/forms/:token
//   OPTIONS /v1/public/forms/:token/submit
//   POST /v1/public/forms/:token/submit
import 'reflect-metadata';
import { request } from 'node:http';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { FormsModule } from '../../src/modules/forms';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, FormsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const LANDING = 'https://landing.test';

let admin: Client;
let app: INestApplication;
let base = '';
let origin = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE form_submissions, form_fields, forms, form_routes, meta_events, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, custom_field_values, custom_field_definitions, contact_phones, contacts, queue_members, queue_distribution_state, queues, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
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

/** Petición al endpoint público con `Origin` (el `fetch` de Node no deja fijarla de forma fiable: se usa `http`). */
function pub(method: string, path: string, opts: { origin?: string; key?: string; body?: unknown; ua?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(opts.origin ? { origin: opts.origin } : {}), ...(opts.key ? { 'idempotency-key': opts.key } : {}), ...(opts.ua ? { 'user-agent': opts.ua } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? (JSON.parse(text) as unknown) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface Form { id: string; name: string; status: string; field_count: number; submissions: number; public_token: string; queue_id: string | null; pipeline_id: string | null; stage_id: string | null; extra_tag_id: string | null; allowed_domains: string[]; consent_text: string; phone_prefix: string; redirect_url: string | null; fields: Array<{ id: string; key: string; kind: string; label: string; maps_to: string; required: boolean; options: string[] | null }>; missing: string[] }
const mk = async (token: string, name = 'Landing de cursos'): Promise<Form> => {
  const r = await call('POST', '/forms', token, { name });
  expect(r.status).toBe(201);
  return json<Form>(r);
};
const field = (label: string, kind: string, mapsTo: string, extra: Record<string, unknown> = {}) => ({ label, kind, maps_to: mapsTo, required: false, ...extra });
const BASE_FIELDS = [field('Nombre', 'text', 'name', { required: true }), field('WhatsApp', 'phone', 'phone', { required: true }), field('Correo', 'email', 'email')];
const setFields = (token: string, id: string, fields: unknown[]) => call('PUT', `/forms/${id}/fields`, token, { fields });
const patch = (token: string, id: string, body: Record<string, unknown>) => call('PATCH', `/forms/${id}`, token, body);

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER', 'CAPI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: process.env['TEST_LOG'] ?? 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AI_PROVIDER: 'fake', CAPI_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
  base = `${origin}/v1`;
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

// ═══════════════════════════════════════════════════════════════════════════ administración

describe('administración de formularios', () => {
  it('sin sesión 401; un asesor no administra formularios (403); la lista de A no se mezcla con la de B', async () => {
    const f = await mk(T.alice);
    const routes: Array<[string, string, unknown?]> = [['GET', '/forms'], ['POST', '/forms', { name: 'X' }], ['GET', `/forms/${f.id}`], ['PATCH', `/forms/${f.id}`, { name: 'Y' }], ['PUT', `/forms/${f.id}/fields`, { fields: [field('N', 'text', 'name', { required: true })] }], ['POST', `/forms/${f.id}/publish`], ['POST', `/forms/${f.id}/pause`], ['GET', `/forms/${f.id}/submissions`], ['DELETE', `/forms/${f.id}`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
    await mk(T.bob, 'Formulario de B');
    const a = await json<{ items: Form[] }>(await call('GET', '/forms', T.alice));
    const b = await json<{ items: Form[] }>(await call('GET', '/forms', T.bob));
    expect(a.items.map((x) => x.name)).toEqual(['Landing de cursos']);
    expect(b.items.map((x) => x.name)).toEqual(['Formulario de B']);
    expect(a.items[0]!.public_token).not.toBe(b.items[0]!.public_token);
  });

  it('crear: queda en borrador con nombre, WhatsApp y correo, un token público aleatorio y su auditoría; un nombre repetido es 409', async () => {
    const f = await mk(T.alice);
    expect(f).toMatchObject({ status: 'draft', field_count: 3, submissions: 0 });
    expect(f.fields.map((x) => [x.maps_to, x.required])).toEqual([['name', true], ['phone', true], ['email', false]]);
    expect(f.public_token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(f.missing.join(' ')).toMatch(/autoriza al menos un dominio/);
    expect((await call('POST', '/forms', T.alice, { name: 'landing de cursos' })).status).toBe(409);
    expect((await call('POST', '/forms', T.alice, { name: '' })).status).toBe(400);
    expect((await call('POST', '/forms', T.alice, { name: 'x', otro: 1 })).status).toBe(400);
    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE entity_type = 'form' AND entity_id = $1`, [f.id])).rows).toHaveLength(1);
    expect((await admin.query(`SELECT organization_id FROM form_routes WHERE id = $1`, [f.public_token])).rows[0]).toMatchObject({ organization_id: ORG_A });
  });

  it('ajustes: normaliza los dominios y rechaza los inválidos; la redirección debe ser https; consentimiento y prefijo se validan', async () => {
    const f = await mk(T.alice);
    const ok = await patch(T.alice, f.id, { allowed_domains: ['https://Landing.TEST/oferta', 'landing.test', '*.promo.test'], redirect_url: 'https://landing.test/gracias', phone_prefix: '+57', consent_text: 'Acepto que me escriban por WhatsApp.', thanks_message: 'Listo, te escribimos.', description: 'Campaña de octubre' });
    expect(ok.status).toBe(200);
    expect(await json<Form>(ok)).toMatchObject({ allowed_domains: ['landing.test', '*.promo.test'], redirect_url: 'https://landing.test/gracias', phone_prefix: '+57' });
    for (const bad of [{ allowed_domains: ['no es dominio'] }, { redirect_url: 'http://landing.test' }, { redirect_url: 'javascript:alert(1)' }, { redirect_url: 'https://user:pw@x.com' }, { phone_prefix: '593' }, { consent_text: 'corto' }, { allowed_domains: Array.from({ length: 21 }, (_, i) => `d${i}.com`) }, {}]) {
      expect((await patch(T.alice, f.id, bad)).status, JSON.stringify(bad).slice(0, 50)).toBe(400);
    }
    const fields = (await admin.query(`SELECT field FROM audit_logs WHERE entity_id = $1 AND field IS NOT NULL`, [f.id])).rows.map((r) => r.field);
    expect(fields).toEqual(expect.arrayContaining(['allowed_domains', 'redirect_url', 'phone_prefix', 'consent_text']));
  });

  it('el destino se valida: cola, pipeline, etapa abierta del pipeline y etiqueta personalizada de la propia empresa', async () => {
    const f = await mk(T.alice);
    const [qa] = (await admin.query(`INSERT INTO queues(id, organization_id, name) VALUES (gen_random_uuid(), $1, 'Ventas') RETURNING id`, [ORG_A])).rows;
    const [qb] = (await admin.query(`INSERT INTO queues(id, organization_id, name) VALUES (gen_random_uuid(), $1, 'Ventas B') RETURNING id`, [ORG_B])).rows;
    expect((await patch(T.alice, f.id, { queue_id: qa.id })).status).toBe(200);
    expect((await patch(T.alice, f.id, { queue_id: qb.id })).status).toBe(400); // la cola de otra empresa no existe para A
    // pipeline y etapas
    const pa = (await admin.query(`INSERT INTO pipelines(id, organization_id, name, position) VALUES (gen_random_uuid(), $1, 'Ventas', 0) RETURNING id`, [ORG_A])).rows[0].id as string;
    const stage = async (pipeline: string, name: string, kind: string, pos: number, hidden = false) => (await admin.query(`INSERT INTO pipeline_stages(id, organization_id, pipeline_id, name, kind, position, is_hidden) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING id`, [ORG_A, pipeline, name, kind, pos, hidden])).rows[0].id as string;
    const open = await stage(pa, 'Nuevo', 'open', 0);
    const won = await stage(pa, 'Ganada', 'won', 1);
    const hidden = await stage(pa, 'Oculta', 'open', 2, true);
    const other = (await admin.query(`INSERT INTO pipelines(id, organization_id, name, position) VALUES (gen_random_uuid(), $1, 'Otro', 1) RETURNING id`, [ORG_A])).rows[0].id as string;
    expect((await patch(T.alice, f.id, { pipeline_id: pa, stage_id: open })).status).toBe(200);
    expect(await json<Form>(await call('GET', `/forms/${f.id}`, T.alice))).toMatchObject({ pipeline_id: pa, stage_id: open });
    expect((await patch(T.alice, f.id, { stage_id: won })).status).toBe(400);
    expect((await patch(T.alice, f.id, { stage_id: hidden })).status).toBe(400);
    expect((await patch(T.alice, f.id, { pipeline_id: other, stage_id: open })).status).toBe(400); // la etapa no es de ese pipeline
    // cambiar de pipeline sin elegir etapa deja la primera abierta (stage nula)
    expect(await json<Form>(await patch(T.alice, f.id, { pipeline_id: other }))).toMatchObject({ pipeline_id: other, stage_id: null });
    expect((await patch(T.alice, f.id, { pipeline_id: '00000000-0000-4000-8000-00000000dead' })).status).toBe(400);
    // etiquetas: la personalizada sirve; la del sistema y la de otra empresa, no
    const tag = async (org: string, name: string, system: boolean) => (await admin.query(`INSERT INTO tags(id, organization_id, name, color, is_system, system_key) VALUES (gen_random_uuid(), $1, $2, '#112233', $3, $4) RETURNING id`, [org, name, system, system ? 'lead' : null])).rows[0].id as string;
    expect((await patch(T.alice, f.id, { extra_tag_id: await tag(ORG_A, 'Curso', false) })).status).toBe(200);
    expect((await patch(T.alice, f.id, { extra_tag_id: await tag(ORG_A, 'Lead', true) })).status).toBe(400);
    expect((await patch(T.alice, f.id, { extra_tag_id: await tag(ORG_B, 'De B', false) })).status).toBe(400);
    expect((await patch(T.alice, f.id, { queue_id: null, pipeline_id: null, extra_tag_id: null })).status).toBe(200);
  });

  it('campos: reemplaza el conjunto en orden, genera las claves desde la etiqueta y valida estructura y campos personalizados', async () => {
    const f = await mk(T.alice);
    expect((await call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' })).status).toBe(201);
    const r = await setFields(T.alice, f.id, [...BASE_FIELDS, field('Tu ciudad', 'text', 'custom:ciudad'), field('Interés', 'select', 'note', { options: ['Uñas', 'Pestañas'] }), field('Cuéntanos más', 'long_text', 'note', { placeholder: 'Escribe aquí' })]);
    expect(r.status).toBe(200);
    const d = await json<Form>(r);
    expect(d.fields.map((x) => x.key)).toEqual(['nombre', 'whatsapp', 'correo', 'tu_ciudad', 'interes', 'cuentanos_mas']);
    expect(d.field_count).toBe(6);
    expect((await admin.query(`SELECT position FROM form_fields WHERE form_id = $1 ORDER BY position`, [f.id])).rows.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 5]);
    const bads: Array<[string, unknown[]]> = [
      ['sin teléfono', [field('Nombre', 'text', 'name', { required: true })]],
      ['teléfono opcional', [field('Nombre', 'text', 'name', { required: true }), field('WhatsApp', 'phone', 'phone')]],
      ['dos nombres', [...BASE_FIELDS, field('Otro nombre', 'text', 'name', { required: true })]],
      ['teléfono como texto', [field('Nombre', 'text', 'name', { required: true }), field('WhatsApp', 'text', 'phone', { required: true })]],
      ['selección sin opciones', [...BASE_FIELDS, field('Interés', 'select', 'note')]],
      ['opciones en un texto', [...BASE_FIELDS, field('Dato', 'text', 'note', { options: ['A'] })]],
      ['campo personalizado inexistente', [...BASE_FIELDS, field('Dato', 'text', 'custom:no_existe')]],
      ['dos veces el mismo personalizado', [...BASE_FIELDS, field('A', 'text', 'custom:ciudad'), field('B', 'text', 'custom:ciudad')]],
      ['clave repetida', [{ ...field('Nombre', 'text', 'name', { required: true }), key: 'dato' }, field('WhatsApp', 'phone', 'phone', { required: true }), { ...field('Otro', 'text', 'note'), key: 'dato' }]],
    ];
    for (const [label, fields] of bads) expect((await setFields(T.alice, f.id, fields)).status, label).toBe(400);
    expect((await setFields(T.alice, f.id, [])).status).toBe(400);
    expect((await setFields(T.alice, f.id, Array.from({ length: 31 }, (_, i) => field(`C${i}`, 'text', 'note')))).status).toBe(400);
    // lo rechazado no tocó lo guardado
    expect((await json<Form>(await call('GET', `/forms/${f.id}`, T.alice))).field_count).toBe(6);
  });

  it('publicar exige dominios y estructura completa (409 con lo que falta); pausar y borrar; el nombre se libera al borrar', async () => {
    const f = await mk(T.alice);
    const no = await call('POST', `/forms/${f.id}/publish`, T.alice);
    expect(no.status).toBe(409);
    expect(await json<{ error: { code: string; message: string } }>(no)).toMatchObject({ error: { code: 'FORM_INCOMPLETE' } });
    await patch(T.alice, f.id, { allowed_domains: ['landing.test'] });
    const p = await call('POST', `/forms/${f.id}/publish`, T.alice);
    expect(p.status).toBe(200);
    expect(await json<Form>(p)).toMatchObject({ status: 'published', missing: [] });
    expect((await json<Form>(await call('POST', `/forms/${f.id}/pause`, T.alice))).status).toBe('paused');
    expect((await json<Form>(await call('POST', `/forms/${f.id}/publish`, T.alice))).status).toBe('published');
    const statuses = (await admin.query(`SELECT new_value FROM audit_logs WHERE entity_id = $1 AND field = 'status' ORDER BY at`, [f.id])).rows.map((r) => r.new_value);
    expect(statuses).toEqual(['published', 'paused', 'published']);
    expect((await call('DELETE', `/forms/${f.id}`, T.alice)).status).toBe(200);
    expect((await call('GET', `/forms/${f.id}`, T.alice)).status).toBe(404);
    expect((await json<{ items: Form[] }>(await call('GET', '/forms', T.alice))).items).toEqual([]);
    expect((await call('POST', '/forms', T.alice, { name: 'Landing de cursos' })).status).toBe(201);
  });

  it('A↔B: B no ve ni cambia nada del formulario de A (404) y no puede usar sus colas, pipelines ni etiquetas', async () => {
    const f = await mk(T.alice);
    for (const [m, p, b] of [['GET', `/forms/${f.id}`], ['PATCH', `/forms/${f.id}`, { name: 'Robado' }], ['PUT', `/forms/${f.id}/fields`, { fields: BASE_FIELDS }], ['POST', `/forms/${f.id}/publish`], ['POST', `/forms/${f.id}/pause`], ['GET', `/forms/${f.id}/submissions`], ['DELETE', `/forms/${f.id}`]] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, T.bob, b)).status, `${m} ${p}`).toBe(404);
    }
    expect((await json<Form>(await call('GET', `/forms/${f.id}`, T.alice))).name).toBe('Landing de cursos');
    expect((await call('GET', '/forms/no-es-uuid', T.alice)).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════ recepción pública

/** Un formulario de A listo: dominios, campo personalizado, cola con reparto a Carolina, pipeline con su etapa y etiqueta extra. */
async function ready(over: Record<string, unknown> = {}): Promise<{ form: Form; token: string; queue: string; stage: string; pipeline: string; tag: string }> {
  expect((await call('POST', '/custom-fields', T.alice, { name: 'Ciudad', type: 'text' })).status).toBe(201);
  const f = await mk(T.alice);
  expect((await setFields(T.alice, f.id, [...BASE_FIELDS, field('Ciudad', 'text', 'custom:ciudad'), field('Interés', 'select', 'note', { options: ['Uñas', 'Pestañas'], required: true })])).status).toBe(200);
  const queue = ((await (await call('POST', '/queues', T.alice, { name: 'Captación' })).json()) as { id: string }).id;
  expect((await call('PATCH', `/queues/${queue}`, T.alice, { distribution_on: true })).status).toBe(200);
  expect((await call('PUT', `/queues/${queue}/members`, T.alice, { members: [{ user_id: IDS.carol, active: true, weight: 1 }] })).status).toBe(200);
  const pipeline = (await admin.query(`INSERT INTO pipelines(id, organization_id, name, position) VALUES (gen_random_uuid(), $1, 'Captación', 0) RETURNING id`, [ORG_A])).rows[0].id as string;
  const stage = (await admin.query(`INSERT INTO pipeline_stages(id, organization_id, pipeline_id, name, kind, position) VALUES (gen_random_uuid(), $1, $2, 'Nuevo lead', 'open', 0) RETURNING id`, [ORG_A, pipeline])).rows[0].id as string;
  const tag = (await admin.query(`INSERT INTO tags(id, organization_id, name, color, is_system) VALUES (gen_random_uuid(), $1, 'Curso de uñas', '#aa3366', false) RETURNING id`, [ORG_A])).rows[0].id as string;
  expect((await patch(T.alice, f.id, { allowed_domains: ['landing.test', '*.promo.test'], queue_id: queue, pipeline_id: pipeline, stage_id: stage, extra_tag_id: tag, thanks_message: '¡Gracias, te escribimos!', ...over })).status).toBe(200);
  app.get(OrgDirectoryService).invalidate();
  const p = await json<Form>(await call('POST', `/forms/${f.id}/publish`, T.alice));
  return { form: p, token: p.public_token, queue, stage, pipeline, tag };
}
const GOOD = { values: { nombre: 'Lucía Paredes', whatsapp: '0984217730', correo: 'Lucia@Example.com', ciudad: 'Guayaquil', interes: 'uñas' }, consent: true, captcha_token: 'fake-pass' };
let n = 0;
const submit = (token: string, over: Record<string, unknown> = {}, opts: { origin?: string | null; key?: string | null; ua?: string } = {}) => {
  n += 1;
  return pub('POST', `/public/forms/${token}/submit`, { origin: opts.origin === null ? undefined : (opts.origin ?? LANDING), key: opts.key === null ? undefined : (opts.key ?? `idem-${n}-${Math.random().toString(36).slice(2)}`), body: { ...GOOD, ...over }, ...(opts.ua ? { ua: opts.ua } : {}) });
};
const contactRows = async () => (await admin.query(`SELECT c.*, (SELECT e164 FROM contact_phones p WHERE p.contact_id = c.id LIMIT 1) AS phone FROM contacts c ORDER BY created_at`)).rows as Row[];
const subs = async () => (await admin.query(`SELECT * FROM form_submissions ORDER BY created_at`)).rows as Row[];
const events = async () => (await admin.query(`SELECT * FROM meta_events ORDER BY created_at`)).rows as Row[];
const opps = async () => (await admin.query(`SELECT * FROM opportunities`)).rows as Row[];
const tagNames = async (contact: string) => (await admin.query(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1 ORDER BY t.name`, [contact])).rows.map((r) => r.name as string);

describe('definición pública del formulario', () => {
  it('muestra solo lo necesario para dibujarlo (sin destino, dominios ni cola) y pone CORS solo al origen autorizado', async () => {
    const { token, form } = await ready();
    const r = await pub('GET', `/public/forms/${token}`, { origin: LANDING });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(LANDING);
    expect(r.headers['vary']).toMatch(/Origin/);
    expect(r.headers['cache-control']).toBe('no-store');
    const d = r.body as { id: string; name: string; fields: Array<{ key: string; kind: string; label: string; required: boolean; options: string[] | null }>; captcha: { provider: string; site_key: string | null }; thanks_message: string };
    expect(d).toMatchObject({ id: token, name: 'Landing de cursos', thanks_message: '¡Gracias, te escribimos!', captcha: { provider: 'fake', site_key: 'fake' } });
    expect(d.fields.map((x) => x.key)).toEqual(['nombre', 'whatsapp', 'correo', 'ciudad', 'interes']);
    expect(d.fields[4]).toMatchObject({ kind: 'select', required: true, options: ['Uñas', 'Pestañas'] });
    const text = JSON.stringify(r.body);
    for (const secret of [form.id, 'queue', 'allowed_domains', 'pipeline', 'maps_to', ORG_A]) expect(text, secret).not.toContain(secret);
    // un subdominio con «*.» también; otro dominio no recibe ni las cabeceras CORS
    expect((await pub('GET', `/public/forms/${token}`, { origin: 'https://a.promo.test' })).status).toBe(200);
    const bad = await pub('GET', `/public/forms/${token}`, { origin: 'https://evil.test' });
    expect(bad.status).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect((await pub('GET', `/public/forms/${token}`, { origin: 'https://promo.test' })).status).toBe(403);
    // sin Origin (una lectura del mismo sitio) se permite
    expect((await pub('GET', `/public/forms/${token}`)).status).toBe(200);
  });

  it('un token desconocido, un formulario en borrador, pausado o borrado responden igual: 404', async () => {
    const { token, form } = await ready();
    expect((await pub('GET', `/public/forms/00000000-0000-4000-8000-00000000dead`, { origin: LANDING })).status).toBe(404);
    expect((await pub('GET', `/public/forms/no-es-uuid`, { origin: LANDING })).status).toBe(400);
    await call('POST', `/forms/${form.id}/pause`, T.alice);
    expect((await pub('GET', `/public/forms/${token}`, { origin: LANDING })).status).toBe(404);
    expect((await submit(token)).status).toBe(404);
    await call('POST', `/forms/${form.id}/publish`, T.alice);
    expect((await pub('GET', `/public/forms/${token}`, { origin: LANDING })).status).toBe(200);
    await call('DELETE', `/forms/${form.id}`, T.alice);
    expect((await pub('GET', `/public/forms/${token}`, { origin: LANDING })).status).toBe(404);
    const draft = await mk(T.alice, 'Borrador');
    expect((await pub('GET', `/public/forms/${draft.public_token}`, { origin: LANDING })).status).toBe(404);
  });

  it('el preflight CORS responde 204 con el origen autorizado y 403 al resto', async () => {
    const { token } = await ready();
    const ok = await pub('OPTIONS', `/public/forms/${token}/submit`, { origin: LANDING });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(LANDING);
    expect(String(ok.headers['access-control-allow-headers'])).toMatch(/idempotency-key/i);
    expect(String(ok.headers['access-control-allow-methods'])).toMatch(/POST/);
    const no = await pub('OPTIONS', `/public/forms/${token}/submit`, { origin: 'https://evil.test' });
    expect(no.status).toBe(403);
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
    expect((await pub('OPTIONS', `/public/forms/${token}/submit`)).status).toBe(403);
  });
});

describe('envío público', () => {
  it('crea el contacto, lo deja con consentimiento, etiquetas, oportunidad, responsable y campo personalizado, guarda el envío y deja el evento Lead listo para Meta (sin conversación)', async () => {
    const { token, form, stage, pipeline } = await ready();
    const r = await submit(token, { event_id: 'pixel-evt-123456', source_url: 'https://landing.test/oferta?x=1', utm: { utm_source: 'facebook', utm_campaign: 'octubre', secreto: 'no' }, fbc: 'fb.1.1700000000.abc', fbp: 'fb.1.1700000000.123' }, { ua: 'Mozilla/5.0 (Prueba)' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(LANDING);
    expect(r.body).toEqual({ ok: true, event_id: 'pixel-evt-123456', message: '¡Gracias, te escribimos!', redirect_url: null });

    const [c] = await contactRows();
    expect(c).toMatchObject({ name: 'Lucía Paredes', email: 'lucia@example.com', source: 'form', consent: 'granted', phone: '+593984217730', owner_id: IDS.carol });
    expect(await tagNames(c!['id'] as string)).toEqual(['Curso de uñas', 'Lead']);
    const [o] = await opps();
    expect(o).toMatchObject({ contact_id: c!['id'], pipeline_id: pipeline, stage_id: stage, status: 'open', owner_id: IDS.carol });
    expect((await admin.query(`SELECT origin FROM stage_history WHERE opportunity_id = $1`, [o!['id']])).rows).toEqual([{ origin: 'system' }]);
    const value = (await admin.query(`SELECT v.value_text FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.definition_id WHERE d.var_key = 'ciudad' AND v.entity_id = $1`, [c!['id']])).rows[0];
    expect(value).toEqual({ value_text: 'Guayaquil' });
    expect((await admin.query(`SELECT 1 FROM conversations`)).rows).toHaveLength(0); // un formulario no crea conversación

    const [s] = await subs();
    expect(s).toMatchObject({ form_id: form.id, contact_id: c!['id'], contact_created: true, event_id: 'pixel-evt-123456', source_url: 'https://landing.test/oferta?x=1' });
    expect(s!['payload']).toEqual({ nombre: 'Lucía Paredes', whatsapp: '+593984217730', correo: 'lucia@example.com', ciudad: 'Guayaquil', interes: 'Uñas' });
    expect(s!['utm']).toEqual({ utm_source: 'facebook', utm_campaign: 'octubre' });
    expect(String(s!['ip_hash'])).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(s)).not.toContain('127.0.0.1');

    const [e] = await events();
    expect(e).toMatchObject({ event_id: 'pixel-evt-123456', type: 'Lead', contact_id: c!['id'], status: 'pending' });
    const p = e!['payload'] as { action_source: string; event_source_url: string; user_data: Record<string, unknown>; event_name: string };
    expect(p).toMatchObject({ event_name: 'Lead', action_source: 'website', event_source_url: 'https://landing.test/oferta?x=1' });
    expect(p.user_data['ph']).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(p.user_data['em']).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(p.user_data).toMatchObject({ fbc: 'fb.1.1700000000.abc', fbp: 'fb.1.1700000000.123', client_user_agent: 'Mozilla/5.0 (Prueba)' });
    expect(JSON.stringify(e)).not.toContain('593984217730'); // el teléfono nunca va en claro
    expect(JSON.stringify(e)).not.toContain('lucia@example.com');
    // la auditoría marca el origen
    const audit = (await admin.query(`SELECT field, source FROM audit_logs WHERE entity_id = $1 AND source = 'api' ORDER BY at`, [c!['id']])).rows;
    expect(audit.map((a) => a.field)).toEqual(expect.arrayContaining([null, 'custom.ciudad', 'consent']));
  });

  it('sin event_id propio usa uno derivado del envío; la redirección configurada se devuelve', async () => {
    const { token } = await ready({ redirect_url: 'https://landing.test/gracias' });
    const r = await submit(token);
    const body = r.body as { event_id: string; redirect_url: string };
    expect(body.redirect_url).toBe('https://landing.test/gracias');
    const [s] = await subs();
    expect(body.event_id).toBe(`lead:form:${s!['id']}`);
  });

  it('es idempotente: la misma llave devuelve lo mismo sin duplicar contacto, oportunidad, envío ni evento (también con envíos simultáneos)', async () => {
    const { token } = await ready();
    const a = await submit(token, {}, { key: 'misma-llave-1' });
    const b = await submit(token, {}, { key: 'misma-llave-1' });
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const par = await Promise.all([1, 2, 3, 4].map(() => submit(token, { values: { ...GOOD.values, whatsapp: '0991112222' } }, { key: 'llave-paralela-9' })));
    expect(par.every((x) => x.status === 200)).toBe(true);
    expect(new Set(par.map((x) => (x.body as { event_id: string }).event_id)).size).toBe(1);
    expect(await subs()).toHaveLength(2);
    expect(await contactRows()).toHaveLength(2);
    expect(await opps()).toHaveLength(2);
    expect(await events()).toHaveLength(2);
  });

  it('con un contacto que ya existe: completa lo que falta SIN pisar lo que tiene, conserva su responsable y consentimiento revocado, no duplica la oportunidad abierta', async () => {
    const { token } = await ready();
    const c = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id, consent, email) VALUES (gen_random_uuid(), $1, 'Lucía P. (cliente VIP)', $2, 'revoked', 'vip@empresa.test') RETURNING id`, [ORG_A, IDS.alice])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984217730', true)`, [ORG_A, c]);
    const def = (await admin.query(`INSERT INTO custom_field_values(id, organization_id, entity, entity_id, definition_id, value_text, updated_by) SELECT gen_random_uuid(), $1, 'contact', $2, d.id, 'Quito', $3 FROM custom_field_definitions d WHERE d.var_key = 'ciudad' RETURNING id`, [ORG_A, c, IDS.alice]));
    expect(def.rowCount).toBe(1);
    expect((await submit(token)).status).toBe(200);
    expect((await submit(token, { values: { ...GOOD.values, nombre: 'Otra Persona' } })).status).toBe(200);
    const rows = await contactRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: c, name: 'Lucía P. (cliente VIP)', email: 'vip@empresa.test', owner_id: IDS.alice, consent: 'revoked' });
    expect((await admin.query(`SELECT v.value_text FROM custom_field_values v WHERE v.entity_id = $1`, [c])).rows).toEqual([{ value_text: 'Quito' }]);
    expect(await opps()).toHaveLength(1);
    expect((await subs()).map((s) => s['contact_created'])).toEqual([false, false]);
  });

  it('el nombre de reserva (el teléfono) sí se completa con el nombre del formulario', async () => {
    const { token } = await ready();
    const c = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, '+593984217730') RETURNING id`, [ORG_A])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984217730', true)`, [ORG_A, c]);
    await submit(token);
    expect((await contactRows())[0]).toMatchObject({ name: 'Lucía Paredes', email: 'lucia@example.com' });
  });

  it('valida en el servidor: obligatorios, teléfono, correo y opción inválidos dan 400 con el campo, y no se crea nada', async () => {
    const { token } = await ready();
    const r = await submit(token, { values: { nombre: '', whatsapp: '12', correo: 'x', interes: 'Otra' } });
    expect(r.status).toBe(400);
    const paths = (r.body as { error: { details: Array<{ path: string }> } }).error.details.map((d) => d.path).sort();
    expect(paths).toEqual(['values.correo', 'values.interes', 'values.nombre', 'values.whatsapp']);
    expect(await contactRows()).toHaveLength(0);
    expect(await subs()).toHaveLength(0);
    // sin prefijo usa el del formulario (+593); con otro prefijo configurado, ese
    expect((await submit(token, { values: { ...GOOD.values, whatsapp: '0984217730' } })).status).toBe(200);
    expect((await contactRows())[0]).toMatchObject({ phone: '+593984217730' });
  });

  it('el consentimiento es obligatorio; sin captcha o con uno malo, 400 y nada se crea', async () => {
    const { token } = await ready();
    for (const [label, over] of [['sin consentimiento', { consent: false }], ['sin captcha', { captcha_token: undefined }], ['captcha malo', { captcha_token: 'otro' }]] as Array<[string, Record<string, unknown>]>) {
      const r = await submit(token, over);
      expect(r.status, label).toBe(400);
    }
    expect(((await submit(token, { captcha_token: 'otro' })).body as { error: { code: string } }).error.code).toBe('CAPTCHA_FAILED');
    expect(await contactRows()).toHaveLength(0);
    expect(await subs()).toHaveLength(0);
  });

  it('el campo trampa responde «bien» pero no guarda nada', async () => {
    const { token } = await ready();
    const r = await submit(token, { hp: 'http://spam.example' });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect(await contactRows()).toHaveLength(0);
    expect(await subs()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  it('exige Origin autorizado (también al enviar) y Idempotency-Key; rechaza cuerpos con campos desconocidos', async () => {
    const { token } = await ready();
    expect((await submit(token, {}, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await submit(token, {}, { origin: null })).status).toBe(403);
    expect((await submit(token, {}, { key: null })).status).toBe(400);
    expect((await submit(token, {}, { key: 'corta' })).status).toBe(400);
    expect((await submit(token, { extra: 1 })).status).toBe(400);
    expect((await submit(token, { event_id: 'con espacios' })).status).toBe(400);
    expect(await contactRows()).toHaveLength(0);
    // el propio origen de la aplicación siempre está permitido (la página alojada por nosotros, M9.2)
    expect((await submit(token, {}, { origin: 'http://localhost:5173' })).status).toBe(200);
  });

  it('limita los envíos por IP y formulario (429 a partir del 11.º en un minuto)', async () => {
    const { token } = await ready();
    const out: number[] = [];
    for (let i = 0; i < 12; i++) out.push((await submit(token, { values: { ...GOOD.values, whatsapp: `09910000${String(i).padStart(2, '0')}` } })).status);
    expect(out.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(out.slice(10)).toEqual([429, 429]);
  });

  it('A↔B: un formulario de B solo crea datos de B; el token de A no sirve para escribir en B', async () => {
    const a = await ready();
    expect((await call('POST', '/custom-fields', T.bob, { name: 'Ciudad', type: 'text' })).status).toBe(201);
    const fb = await mk(T.bob, 'Formulario de B');
    await patch(T.bob, fb.id, { allowed_domains: ['landing.test'] });
    const pb = await json<Form>(await call('POST', `/forms/${fb.id}/publish`, T.bob));
    expect((await submit(pb.public_token, { values: { nombre: 'Beto Cliente', whatsapp: '0984000000' } })).status).toBe(200);
    expect((await admin.query(`SELECT organization_id FROM contacts`)).rows).toEqual([{ organization_id: ORG_B }]);
    expect((await admin.query(`SELECT organization_id FROM form_submissions`)).rows).toEqual([{ organization_id: ORG_B }]);
    expect((await admin.query(`SELECT organization_id FROM meta_events`)).rows).toEqual([{ organization_id: ORG_B }]);
    expect((await json<{ items: unknown[] }>(await call('GET', `/forms/${a.form.id}/submissions`, T.alice))).items).toEqual([]);
    expect((await json<{ items: unknown[] }>(await call('GET', `/forms/${fb.id}/submissions`, T.bob))).items).toHaveLength(1);
  });
});

describe('lo recibido', () => {
  it('lista los envíos del formulario con su contacto, lo más reciente primero y con paginación; la lista y el detalle cuentan los envíos', async () => {
    const { token, form } = await ready();
    for (let i = 0; i < 3; i++) await submit(token, { values: { ...GOOD.values, whatsapp: `09877000${i}0`, nombre: `Cliente ${i}` } });
    const p1 = await json<{ items: Array<{ contact: { name: string }; contact_created: boolean; values: Record<string, unknown> }>; next_cursor: string | null }>(await call('GET', `/forms/${form.id}/submissions?limit=2`, T.alice));
    expect(p1.items.map((x) => x.contact.name)).toEqual(['Cliente 2', 'Cliente 1']);
    expect(p1.next_cursor).not.toBeNull();
    expect(p1.items[0]!.values).toMatchObject({ nombre: 'Cliente 2' });
    const p2 = await json<{ items: Array<{ contact: { name: string } }>; next_cursor: string | null }>(await call('GET', `/forms/${form.id}/submissions?limit=2&cursor=${p1.next_cursor}`, T.alice));
    expect(p2.items.map((x) => x.contact.name)).toEqual(['Cliente 0']);
    expect(p2.next_cursor).toBeNull();
    expect((await call('GET', `/forms/${form.id}/submissions?cursor=basura`, T.alice)).status).toBe(400);
    expect((await json<{ items: Form[] }>(await call('GET', '/forms', T.alice))).items[0]).toMatchObject({ submissions: 3 });
  });
});
