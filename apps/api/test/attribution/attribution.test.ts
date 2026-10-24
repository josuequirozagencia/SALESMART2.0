// M3.3 — Etiquetas del sistema, atribución de Meta Ads y salida de eventos CAPI (ADR-45). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/tags · GET /v1/attribution/endpoint · POST /v1/attribution/endpoint · POST /v1/attribution/ctwa/:endpointId (pública)
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import {
  AttributionModule,
  AttributionService,
  CapiSenderJob,
  CapiSenderService,
  MetaSettingsService,
  CapiSendError,
  CAPI_MAX_ATTEMPTS,
  FakeCapiProvider,
  NoCapiProvider,
  phoneHash,
} from '../../src/modules/attribution';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';
import { capiProviderContract } from './capi.contract';

const fake = new FakeCapiProvider();

@Module({
  imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, AttributionModule.register({ capi: fake }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })],
})
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const P1 = '+593984217730';
const P2 = '+593991112233';

interface Endpoint { id: string; secret: string; rotated: boolean; path: string }
interface ContactView { id: string; name: string; source: string; consent: string; tags: Array<{ name: string; system_key: string | null }>; attribution: null | { ctwa_cl_id: string | null; first_touch: Touch | null; last_touch: Touch | null; capi: null | { status: string; sent_at: string | null } } }
interface Touch { at: string; source: string | null; campaign: string | null; adset: string | null; ad: string | null }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE meta_events, contact_tags, tags, custom_field_values, custom_field_definitions, contact_phones, contacts, attribution_endpoints, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;

const issue = async (t: string): Promise<Endpoint> => {
  const r = await call('POST', '/attribution/endpoint', t);
  expect(r.status).toBe(201);
  return json<Endpoint>(r);
};
const hook = (id: string, secret: string | undefined, body: unknown) =>
  fetch(`${base}/attribution/ctwa/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-webhook-secret': secret } : {}) }, body: JSON.stringify(body) });
const click = (over: Record<string, unknown> = {}) => ({ phone: P1, ctwa_cl_id: 'CLID-1', campaign_name: 'Cursos octubre', adset_name: 'Conjunto A', ad_name: 'Anuncio 1', ...over });
const contactByPhone = async (org: string, phone: string) =>
  (await admin.query(`SELECT c.* FROM contacts c JOIN contact_phones p ON p.contact_id = c.id AND p.organization_id = c.organization_id WHERE c.organization_id = $1 AND p.e164 = $2 AND p.deleted_at IS NULL`, [org, phone])).rows[0] as Record<string, unknown> | undefined;
const events = async (org: string, type?: string) => (await admin.query(`SELECT * FROM meta_events WHERE organization_id = $1 ${type ? `AND type = '${type}'` : ''} ORDER BY created_at, id`, [org])).rows as Array<Record<string, unknown>>;
const viewOf = async (t: string, id: string): Promise<ContactView> => json<ContactView>(await call('GET', `/contacts/${id}`, t));
/** Una empresa lista para atribuir: punto de entrada generado por su administrador. */
const setup = async (t: string) => issue(t);

const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);

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
  fake.sent.length = 0;
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
});

describe('punto de entrada de la empresa', () => {
  it('sin sesión 401 y la plataforma 403; el asesor no lo administra pero sí lee las etiquetas', async () => {
    for (const [m, p] of [['GET', '/attribution/endpoint'], ['POST', '/attribution/endpoint'], ['GET', '/tags']] as const) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root)).status, `${m} ${p} plataforma`).toBe(403);
    }
    expect((await call('GET', '/attribution/endpoint', T.carol)).status).toBe(403);
    expect((await call('POST', '/attribution/endpoint', T.carol)).status).toBe(403);
    expect((await call('GET', '/tags', T.carol)).status).toBe(200);
  });

  it('el administrador lo genera (secreto una sola vez, en la BD solo su hash), lo consulta sin ver el secreto y al regenerarlo el anterior deja de servir', async () => {
    const empty = await json<{ configured: boolean; id: string | null; path: string | null }>(await call('GET', '/attribution/endpoint', T.alice));
    expect(empty).toMatchObject({ configured: false, id: null, path: null });
    const ep = await issue(T.alice);
    expect(ep.secret).toMatch(/^ssw_[A-Za-z0-9_-]{40,}$/);
    expect(ep.path).toBe(`/v1/attribution/ctwa/${ep.id}`);
    expect(ep.rotated).toBe(false);
    const status = await call('GET', '/attribution/endpoint', T.alice);
    const raw = await status.text();
    expect(raw).not.toContain(ep.secret);
    expect(JSON.parse(raw)).toMatchObject({ configured: true, id: ep.id, path: ep.path, rotated_at: null });
    const row = (await admin.query('SELECT secret_hash FROM attribution_endpoints')).rows[0] as { secret_hash: string };
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(ep.secret);

    const again = await issue(T.alice);
    expect(again.id).toBe(ep.id); // el identificador es estable; cambia el secreto
    expect(again.rotated).toBe(true);
    expect(again.secret).not.toBe(ep.secret);
    expect((await hook(ep.id, ep.secret, click())).status).toBe(404);
    expect((await hook(ep.id, again.secret, click())).status).toBe(200);
    expect((await admin.query('SELECT count(*)::int AS n FROM attribution_endpoints')).rows[0].n).toBe(1);
    // la auditoría registra el alta y la regeneración, nunca el secreto
    const audit = (await admin.query(`SELECT field, new_value FROM audit_logs WHERE entity_type = 'attribution_endpoint' ORDER BY at, id`)).rows;
    expect(audit.map((a) => a.field)).toEqual(['created', 'secret_rotated']);
    expect(JSON.stringify(audit)).not.toContain('ssw_');
  });

  it('cada empresa tiene el suyo: el secreto de B no sirve en el punto de A', async () => {
    const a = await setup(T.alice);
    const b = await setup(T.bob);
    expect(a.id).not.toBe(b.id);
    expect((await json<{ id: string }>(await call('GET', '/attribution/endpoint', T.bob))).id).toBe(b.id);
    expect((await hook(a.id, b.secret, click())).status).toBe(404);
    expect((await hook(b.id, a.secret, click())).status).toBe(404);
    expect(await contactByPhone(ORG_A, P1)).toBeUndefined();
    expect(await contactByPhone(ORG_B, P1)).toBeUndefined();
  });
});

describe('webhook de atribución', () => {
  it('un identificador desconocido, un secreto equivocado o la falta de secreto responden exactamente lo mismo (404)', async () => {
    const ep = await setup(T.alice);
    const shape = async (r: Response) => {
      const { request_id: _ignored, ...error } = (await json<{ error: { code: string; message: string; request_id: string } }>(r)).error; // cada petición tiene su propio request_id
      void _ignored;
      return { status: r.status, error };
    };
    const unknown = await shape(await hook('11111111-1111-4111-8111-111111111111', ep.secret, click()));
    const wrong = await shape(await hook(ep.id, 'ssw_incorrecto', click()));
    const none = await shape(await hook(ep.id, undefined, click()));
    expect(unknown.status).toBe(404);
    expect(wrong).toEqual(unknown);
    expect(none).toEqual(unknown);
    expect((await hook('no-es-uuid', ep.secret, click())).status).toBe(400);
    expect(await contactByPhone(ORG_A, P1)).toBeUndefined();
  });

  it('valida el cuerpo con esquema estricto: teléfono E.164, clic obligatorio, sin campos extra ni fechas futuras', async () => {
    const ep = await setup(T.alice);
    const bad: Array<[string, unknown]> = [
      ['teléfono nacional', click({ phone: '0984217730' })],
      ['sin clic', { phone: P1 }],
      ['clic vacío', click({ ctwa_cl_id: '  ' })],
      ['campo extra', click({ organization_id: ORG_B })],
      ['fuente inválida', click({ source: 'Mi Fuente' })],
      ['fecha futura', click({ occurred_at: new Date(Date.now() + 3_600_000).toISOString() })],
      ['fecha sin zona', click({ occurred_at: '2026-10-16 10:00:00' })],
      ['campaña larga', click({ campaign_name: 'x'.repeat(201) })],
    ];
    for (const [label, body] of bad) expect((await hook(ep.id, ep.secret, body)).status, label).toBe(400);
    expect(await contactByPhone(ORG_A, P1)).toBeUndefined();
  });

  it('un clic de un teléfono nuevo crea el contacto (origen meta_ctwa, sin consentimiento), graba primer y último toque, pone la etiqueta Lead y encola el evento sin guardar el teléfono en claro', async () => {
    const ep = await setup(T.alice);
    const r = await hook(ep.id, ep.secret, click({ occurred_at: '2026-10-10T15:00:00Z' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const row = (await contactByPhone(ORG_A, P1))!;
    expect(row).toMatchObject({ source: 'meta_ctwa', consent: 'unknown', owner_id: null, created_by: null, ctwa_cl_id: 'CLID-1', first_touch_source: 'meta_ctwa', first_touch_campaign: 'Cursos octubre', last_touch_adset: 'Conjunto A', last_touch_ad: 'Anuncio 1' });
    expect((row['first_touch_at'] as Date).toISOString()).toBe('2026-10-10T15:00:00.000Z');
    expect((row['last_touch_at'] as Date).toISOString()).toBe('2026-10-10T15:00:00.000Z');

    const v = await viewOf(T.alice, row['id'] as string);
    expect(v).toMatchObject({ source: 'meta_ctwa', consent: 'unknown' });
    expect(v.tags).toEqual([expect.objectContaining({ name: 'Lead', system_key: 'lead' })]);
    expect(v.attribution).toMatchObject({ ctwa_cl_id: 'CLID-1', first_touch: { campaign: 'Cursos octubre', adset: 'Conjunto A', ad: 'Anuncio 1', source: 'meta_ctwa' }, last_touch: { campaign: 'Cursos octubre' }, capi: null });

    const evs = await events(ORG_A, 'Lead');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ status: 'pending', attempts: 0, contact_id: row['id'] });
    const payload = evs[0]!['payload'] as { user_data: { ph: string[]; ctwa_clid: string }; action_source: string };
    expect(payload).toMatchObject({ event_name: 'Lead', action_source: 'business_messaging', user_data: { ph: [phoneHash(P1)], ctwa_clid: 'CLID-1' } });
    expect(JSON.stringify(evs[0]!['payload'])).not.toContain('984217730'); // el teléfono nunca va en claro
    const audit = (await admin.query(`SELECT field, source FROM audit_logs WHERE entity_type = 'contact' AND entity_id = $1 ORDER BY at, id`, [row['id']])).rows;
    expect(audit.map((a) => a.field).sort((x, y) => String(x).localeCompare(String(y)))).toEqual(['attribution', null, 'tag']);
    expect(audit.every((a) => a.source !== 'manual')).toBe(true);
  });

  it('es idempotente: repetir el mismo clic no cambia nada ni duplica contacto, evento, etiqueta ni auditoría', async () => {
    const ep = await setup(T.alice);
    for (let i = 0; i < 3; i++) expect((await hook(ep.id, ep.secret, click())).status).toBe(200);
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(1);
    expect(await events(ORG_A)).toHaveLength(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM contact_tags')).rows[0].n).toBe(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE field = 'attribution'`)).rows[0].n).toBe(1);
  });

  it('el primer toque es inmutable y el último se sobrescribe; un clic más antiguo no pisa al último; cada clic distinto deja su propio evento Lead', async () => {
    const ep = await setup(T.alice);
    await hook(ep.id, ep.secret, click({ occurred_at: '2026-10-10T15:00:00Z' }));
    await hook(ep.id, ep.secret, click({ ctwa_cl_id: 'CLID-2', campaign_name: 'Barbería', adset_name: 'B', ad_name: 'Anuncio 2', occurred_at: '2026-10-12T09:00:00Z' }));
    let row = (await contactByPhone(ORG_A, P1))!;
    expect(row).toMatchObject({ ctwa_cl_id: 'CLID-2', first_touch_campaign: 'Cursos octubre', first_touch_ad: 'Anuncio 1', last_touch_campaign: 'Barbería', last_touch_ad: 'Anuncio 2' });
    expect((row['first_touch_at'] as Date).toISOString()).toBe('2026-10-10T15:00:00.000Z');
    expect((row['last_touch_at'] as Date).toISOString()).toBe('2026-10-12T09:00:00.000Z');

    // llega tarde un clic ANTERIOR al último: queda como evento, pero no cambia los toques
    await hook(ep.id, ep.secret, click({ ctwa_cl_id: 'CLID-0', campaign_name: 'Vieja', occurred_at: '2026-10-01T00:00:00Z' }));
    row = (await contactByPhone(ORG_A, P1))!;
    expect(row).toMatchObject({ ctwa_cl_id: 'CLID-2', first_touch_campaign: 'Cursos octubre', last_touch_campaign: 'Barbería' });
    expect(await events(ORG_A, 'Lead')).toHaveLength(3);
    expect((await admin.query('SELECT count(*)::int AS n FROM contact_tags')).rows[0].n).toBe(1); // la etiqueta Lead se pone una vez
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(1);
  });

  it('si el teléfono ya es de un contacto (creado a mano) se le agrega la atribución sin tocar su nombre, dueño ni consentimiento', async () => {
    const ep = await setup(T.alice);
    const made = await json<{ id: string }>(await call('POST', '/contacts', T.alice, { name: 'Ana Torres', phones: [P1], owner_id: IDS.carol, consent: 'granted' }));
    expect((await hook(ep.id, ep.secret, click())).status).toBe(200);
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(1);
    const v = await viewOf(T.alice, made.id);
    expect(v).toMatchObject({ name: 'Ana Torres', consent: 'granted', source: 'manual' });
    expect(v.attribution).toMatchObject({ ctwa_cl_id: 'CLID-1' });
    expect(v.tags.map((t) => t.system_key)).toEqual(['lead']);
    // el asesor dueño del contacto también ve su origen; un contacto de otro asesor no
    expect((await viewOf(T.carol, made.id)).attribution?.ctwa_cl_id).toBe('CLID-1');
  });

  it('aislamiento A↔B: el clic de A solo escribe en A aunque el mismo teléfono exista en B; los eventos y etiquetas de cada empresa son suyos', async () => {
    const a = await setup(T.alice);
    const b = await setup(T.bob);
    const theirs = await json<{ id: string }>(await call('POST', '/contacts', T.bob, { name: 'Beto', phones: [P1] }));
    await hook(a.id, a.secret, click());
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts WHERE organization_id = $1', [ORG_A])).rows[0].n).toBe(1);
    const bRow = (await admin.query('SELECT ctwa_cl_id, first_touch_at FROM contacts WHERE id = $1', [theirs.id])).rows[0];
    expect(bRow).toEqual({ ctwa_cl_id: null, first_touch_at: null });
    expect(await events(ORG_B)).toEqual([]);
    expect((await viewOf(T.bob, theirs.id)).attribution).toBeNull();
    await hook(b.id, b.secret, click({ ctwa_cl_id: 'CLID-B' }));
    expect((await viewOf(T.bob, theirs.id)).attribution?.ctwa_cl_id).toBe('CLID-B');
    expect((await events(ORG_A, 'Lead')).length).toBe(1);
    expect((await events(ORG_B, 'Lead')).length).toBe(1);
    const tagsA = (await json<{ items: Array<{ id: string }> }>(await call('GET', '/tags', T.alice))).items.map((t) => t.id);
    const tagsB = (await json<{ items: Array<{ id: string }> }>(await call('GET', '/tags', T.bob))).items.map((t) => t.id);
    expect(tagsA.filter((i) => tagsB.includes(i))).toEqual([]);
  });

  it('límite de peticiones: pasado el tope por minuto responde 429 con Retry-After', async () => {
    const id = '22222222-2222-4222-8222-222222222222'; // propio de esta prueba: el límite es por (IP, punto de entrada)
    let last = 0;
    let retry: string | null = null;
    for (let i = 0; i < 125; i++) {
      const r = await hook(id, 'ssw_x', click());
      last = r.status;
      if (r.status === 429) retry = r.headers.get('retry-after');
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  }, 60_000);
});

describe('etiquetas del sistema', () => {
  it('cada empresa recibe sus tres etiquetas al primer uso (idempotente) y ninguna ruta permite renombrarlas, borrarlas ni ponerlas a mano', async () => {
    const first = await json<{ items: Array<{ id: string; name: string; system_key: string; is_system: boolean; color: string }> }>(await call('GET', '/tags', T.alice));
    expect(first.items.map((t) => [t.name, t.system_key, t.is_system]).sort()).toEqual([['Cita agendada', 'appointment', true], ['Lead', 'lead', true], ['Venta', 'sale', true]]);
    expect(first.items.every((t) => /^#[0-9a-f]{6}$/i.test(t.color))).toBe(true);
    const second = await json<typeof first>(await call('GET', '/tags', T.alice));
    expect(second.items.map((t) => t.id).sort()).toEqual(first.items.map((t) => t.id).sort());
    expect((await admin.query('SELECT count(*)::int AS n FROM tags WHERE organization_id = $1', [ORG_A])).rows[0].n).toBe(3);
    const id = first.items[0]!.id;
    for (const [m, p] of [['PATCH', `/tags/${id}`], ['DELETE', `/tags/${id}`]] as const) {
      const r = await call(m, p, T.alice, { name: 'Otra' });
      expect(r.status, `${m} ${p}`).toBe(409); // TAG_SYSTEM
    }
    for (const [m, p] of [['PUT', `/tags/${id}`], ['POST', `/contacts/${id}/tags`]] as const) {
      expect([404, 405], `${m} ${p}`).toContain((await call(m, p, T.alice, {})).status);
    }
    // un contacto no acepta etiquetas desde la API de contactos
    const c = await call('POST', '/contacts', T.alice, { name: 'X', tags: ['lead'] });
    expect(c.status).toBe(400);
  });
});

describe('Purchase: ventana de gracia, cancelación y envío', () => {
  const DAY = 86_400_000;
  const NOW = new Date('2026-10-16T12:00:00.000Z');
  /** Un contacto de A que llegó por un anuncio. */
  async function attributed(): Promise<string> {
    const ep = await setup(T.alice);
    await hook(ep.id, ep.secret, click());
    // El Lead sale «hace un minuto» respecto del reloj fijo de estas pruebas (así no dependen de la hora real)
    await admin.query(`UPDATE meta_events SET send_after = $1 WHERE type = 'Lead'`, [new Date(NOW.getTime() - 60_000)]);
    return (await contactByPhone(ORG_A, P1))!['id'] as string;
  }
  const sale = (contactId: string, saleId: string, extra: Record<string, unknown> = {}) =>
    inOrg(ORG_A, () => app.get(Database).withTenant((tx) => app.get(AttributionService).onSaleTagSet(tx, { contactId, saleId, amount: 250.5, currency: 'USD', ...extra }, NOW)));
  const run = (org: string, now: Date) => inOrg(org, () => app.get(CapiSenderService).runDue(now));

  it('la venta pone la etiqueta Venta y encola el Purchase por el TOTAL a 30 minutos; antes de la hora no sale y después sí', async () => {
    const contactId = await attributed();
    const r = await sale(contactId, 'venta-1');
    expect(r).toEqual({ eventId: 'purchase:venta-1', status: 'pending' });
    const ev = (await events(ORG_A, 'Purchase'))[0]!;
    expect(ev).toMatchObject({ status: 'pending', attempts: 0, contact_id: contactId });
    expect((ev['send_after'] as Date).getTime() - NOW.getTime()).toBe(30 * 60_000);
    expect(ev['payload']).toMatchObject({ event_name: 'Purchase', event_id: 'purchase:venta-1', user_data: { ph: [phoneHash(P1)], ctwa_clid: 'CLID-1' }, custom_data: { value: 250.5, currency: 'USD' } });
    expect((await viewOf(T.alice, contactId)).tags.map((t) => t.system_key).sort()).toEqual(['lead', 'sale']);
    expect((await viewOf(T.alice, contactId)).attribution?.capi).toEqual({ status: 'pending', sent_at: null });

    // los Lead pendientes del clic salen enseguida; el Purchase espera su ventana
    expect(await run(ORG_A, new Date(NOW.getTime() + 29 * 60_000))).toBe(1); // solo el Lead
    expect(fake.sent.map((e) => e.type)).toEqual(['Lead']);
    expect(await run(ORG_A, new Date(NOW.getTime() + 31 * 60_000))).toBe(1);
    expect(fake.sent.map((e) => e.type)).toEqual(['Lead', 'Purchase']);
    expect(fake.last()).toMatchObject({ eventId: 'purchase:venta-1', type: 'Purchase', payload: { custom_data: { value: 250.5, currency: 'USD' } } });
    const done = (await events(ORG_A, 'Purchase'))[0]!;
    expect(done).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
    expect(done['sent_at']).not.toBeNull();
    expect((await viewOf(T.alice, contactId)).attribution?.capi?.status).toBe('sent');
    expect(await run(ORG_A, new Date(NOW.getTime() + 60 * 60_000))).toBe(0); // no se reenvía
  });

  it('cancelar dentro de la ventana evita el envío; después de enviado ya no se puede cancelar; la misma venta no duplica el evento', async () => {
    const contactId = await attributed();
    await sale(contactId, 'venta-2');
    await sale(contactId, 'venta-2'); // idempotente
    expect(await events(ORG_A, 'Purchase')).toHaveLength(1);
    const cancel = (saleId: string) => inOrg(ORG_A, () => app.get(Database).withTenant((tx) => app.get(AttributionService).cancelPurchase(tx, saleId)));
    expect(await cancel('venta-2')).toBe(true);
    expect(await cancel('venta-2')).toBe(false);
    expect((await events(ORG_A, 'Purchase'))[0]).toMatchObject({ status: 'cancelled' });
    await run(ORG_A, new Date(NOW.getTime() + 2 * 3_600_000));
    expect(fake.sent.filter((e) => e.type === 'Purchase')).toEqual([]);
    expect((await viewOf(T.alice, contactId)).attribution?.capi?.status).toBe('cancelled');

    await sale(contactId, 'venta-3');
    await run(ORG_A, new Date(NOW.getTime() + 2 * 3_600_000));
    expect(fake.sent.filter((e) => e.type === 'Purchase')).toHaveLength(1);
    expect(await cancel('venta-3')).toBe(false); // ya salió
    expect(await cancel('venta-que-no-existe')).toBe(false);
  });

  it('un contacto que no llegó por un anuncio no tiene a quién atribuir: el Purchase queda omitido (skipped) con su motivo y nunca se envía', async () => {
    const made = await json<{ id: string }>(await call('POST', '/contacts', T.alice, { name: 'Manual', phones: [P2] }));
    expect(await sale(made.id, 'venta-4')).toEqual({ eventId: 'purchase:venta-4', status: 'skipped' });
    const ev = (await events(ORG_A, 'Purchase'))[0]!;
    expect(ev).toMatchObject({ status: 'skipped' });
    expect(String(ev['last_error'])).toMatch(/anuncio de Meta/);
    expect(JSON.stringify(ev['payload'])).not.toContain('ph');
    await run(ORG_A, new Date(NOW.getTime() + DAY));
    expect(fake.sent).toEqual([]);
    expect((await viewOf(T.alice, made.id)).tags.map((t) => t.system_key)).toEqual(['sale']);
  });

  it('valida la ventana de gracia (0 a 24 h) y el monto; una ventana propia se respeta', async () => {
    const contactId = await attributed();
    await expect(sale(contactId, 'v5', { graceMs: DAY + 1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sale(contactId, 'v5', { graceMs: -1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sale(contactId, 'v5', { amount: -5 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await events(ORG_A, 'Purchase')).toEqual([]);
    await sale(contactId, 'v6', { graceMs: DAY });
    expect(((await events(ORG_A, 'Purchase'))[0]!['send_after'] as Date).getTime() - NOW.getTime()).toBe(DAY);
    await sale(contactId, 'v7', { graceMs: 0 });
    const v7 = (await events(ORG_A, 'Purchase')).find((e) => e['event_id'] === 'purchase:v7')!;
    expect((v7['send_after'] as Date).getTime()).toBe(NOW.getTime());
  });

  it('fallos de envío: los reintentables se reprograman con espera creciente, los definitivos y el quinto intento quedan en failed, y los muy viejos caducan', async () => {
    await attributed();
    const ev = async () => (await events(ORG_A, 'Lead'))[0]!;
    let now = new Date(NOW.getTime());
    fake.failNext(new CapiSendError('límite de peticiones de Meta', true));
    expect(await run(ORG_A, now)).toBe(1);
    expect(await ev()).toMatchObject({ status: 'pending', attempts: 1, last_error: 'límite de peticiones de Meta' });
    expect(((await ev())['send_after'] as Date).getTime() - now.getTime()).toBe(2 * 60_000);
    expect(await run(ORG_A, new Date(now.getTime() + 60_000))).toBe(0); // aún no toca
    now = new Date(now.getTime() + 3 * 60_000);
    expect(await run(ORG_A, now)).toBe(1);
    expect(await ev()).toMatchObject({ status: 'sent', attempts: 2, last_error: null });

    // definitivo: failed al primer intento
    await admin.query(`UPDATE meta_events SET status = 'pending', attempts = 0, sent_at = NULL, send_after = $1`, [NOW]);
    fake.failNext(new CapiSendError('token rechazado', false));
    await run(ORG_A, now);
    expect(await ev()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'token rechazado' });

    // reintentable pero al quinto intento deja de reintentar
    await admin.query(`UPDATE meta_events SET status = 'pending', attempts = $1, send_after = $2`, [CAPI_MAX_ATTEMPTS - 1, NOW]);
    fake.failNext(new CapiSendError('red caída', true));
    await run(ORG_A, now);
    expect(await ev()).toMatchObject({ status: 'failed', attempts: CAPI_MAX_ATTEMPTS });

    // un error inesperado no filtra su texto
    await admin.query(`UPDATE meta_events SET status = 'pending', attempts = 0, send_after = $1`, [NOW]);
    fake.failNext(new Error('Bearer EAAB-secreto-que-no-debe-salir') as CapiSendError);
    await run(ORG_A, now);
    const msg = String((await ev())['last_error']);
    expect(msg).not.toContain('EAAB');

    // evento de hace más de 7 días: caduca en vez de reintentarse
    await admin.query(`UPDATE meta_events SET status = 'pending', attempts = 0, send_after = $1, created_at = $2`, [NOW, new Date(NOW.getTime() - 8 * DAY)]);
    fake.sent.length = 0;
    await run(ORG_A, now);
    expect(await ev()).toMatchObject({ status: 'expired' });
    expect(fake.sent).toEqual([]);
  });

  it('sin proveedor configurado no se envía nada y los eventos siguen pendientes', async () => {
    await attributed();
    const sender = new CapiSenderService(app.get(Database), new NoCapiProvider(), app.get(MetaSettingsService));
    expect(sender.enabled).toBe(false);
    expect(await inOrg(ORG_A, () => sender.runDue(new Date(NOW.getTime() + DAY)))).toBe(0);
    expect((await events(ORG_A, 'Lead'))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('el envío es por empresa (RLS): runDue de A no toca eventos de B; la tarea periódica recorre cada empresa bajo su contexto', async () => {
    const a = await setup(T.alice);
    const b = await setup(T.bob);
    await hook(a.id, a.secret, click());
    await hook(b.id, b.secret, click({ phone: P2, ctwa_cl_id: 'CLID-B' }));
    await admin.query(`UPDATE meta_events SET send_after = $1 WHERE type = 'Lead'`, [new Date(NOW.getTime() - 60_000)]);
    expect(await run(ORG_A, NOW)).toBe(1);
    expect(fake.sent).toHaveLength(1);
    expect((await events(ORG_B, 'Lead'))[0]).toMatchObject({ status: 'pending' });
    expect(await app.get(CapiSenderJob).run(NOW)).toBe(1); // queda el de B
    expect(fake.sent.map((e) => (e.payload['user_data'] as { ctwa_clid: string }).ctwa_clid).sort()).toEqual(['CLID-1', 'CLID-B']);
    expect((await events(ORG_B, 'Lead'))[0]).toMatchObject({ status: 'sent' });
  });

  it('dos envíos a la vez no mandan el mismo evento dos veces (SKIP LOCKED)', async () => {
    const contactId = await attributed();
    for (let i = 0; i < 6; i++) await sale(contactId, `par-${i}`, { graceMs: 0 });
    const later = new Date(NOW.getTime() + 1000);
    const [x, y] = await Promise.all([run(ORG_A, later), run(ORG_A, later)]);
    expect(x + y).toBe(7); // 1 Lead + 6 Purchase
    const ids = fake.sent.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('contrato del puerto CapiProvider', () => {
  it('el fake cumple el contract test y el proveedor vacío rechaza con un error definitivo', async () => {
    await capiProviderContract(() => {
      const p = new FakeCapiProvider();
      return { provider: p, failNext: (e) => p.failNext(e) };
    });
    const none = await new NoCapiProvider().send().catch((e: unknown) => e);
    expect(none).toBeInstanceOf(CapiSendError);
    expect((none as CapiSendError).retryable).toBe(false);
  });
});

describe('base de datos: roles y restricciones', () => {
  const as = async (url: string, q: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(q);
    } finally {
      await c.end();
    }
  };

  it('app_rw no puede borrar ni vaciar; app_platform y app_identity no ven las tablas de negocio; attribution_endpoints es solo de identidad', async () => {
    for (const t of ['tags', 'contact_tags', 'meta_events']) {
      if (t !== 'contact_tags') await expect(as(info.rwUrl, `DELETE FROM ${t}`), `rw DELETE ${t}`).rejects.toThrow(/permission denied/); // contact_tags es pivote con DELETE desde M3.4 (ADR-46)
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `rw TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
    for (const url of [info.rwUrl, info.platformUrl]) await expect(as(url, 'SELECT 1 FROM attribution_endpoints')).rejects.toThrow(/permission denied/);
    await expect(as(info.identityUrl, 'SELECT 1 FROM attribution_endpoints')).resolves.toBeDefined();
    await expect(as(info.identityUrl, 'DELETE FROM attribution_endpoints')).rejects.toThrow(/permission denied/);
  });

  it('las restricciones protegen la forma de los datos y las claves foráneas compuestas impiden cruzar empresas', async () => {
    const ep = await setup(T.alice);
    await hook(ep.id, ep.secret, click());
    const contactId = (await contactByPhone(ORG_A, P1))!['id'] as string;
    const tagId = (await admin.query('SELECT id FROM tags WHERE organization_id = $1 LIMIT 1', [ORG_A])).rows[0].id as string;
    const bad = (sql: string) => admin.query(sql);
    await expect(bad(`INSERT INTO tags(organization_id, id, name, is_system, system_key) VALUES ('${ORG_A}', gen_random_uuid(), 'Otra', true, 'lead')`)).rejects.toThrow(/tags_org_system_key_uq/); // una sola por empresa
    await expect(bad(`INSERT INTO tags(organization_id, id, name, is_system, system_key) VALUES ('${ORG_A}', gen_random_uuid(), 'X', false, 'lead')`)).rejects.toThrow(/tags_system_consistent/);
    await expect(bad(`INSERT INTO tags(organization_id, id, name, is_system, system_key) VALUES ('${ORG_A}', gen_random_uuid(), 'X', true, 'otra')`)).rejects.toThrow(/tags_system_key_valid/);
    await expect(bad(`INSERT INTO tags(organization_id, id, name, color) VALUES ('${ORG_A}', gen_random_uuid(), 'X', 'rojo')`)).rejects.toThrow(/tags_color_shape/);
    await expect(bad(`INSERT INTO tags(organization_id, id, name) VALUES ('${ORG_A}', gen_random_uuid(), '  ')`)).rejects.toThrow(/tags_name_shape/);
    await expect(bad(`INSERT INTO tags(organization_id, id, name) VALUES ('${ORG_A}', gen_random_uuid(), 'LEAD')`)).rejects.toThrow(/tags_org_name_uq/); // sin distinguir mayúsculas
    await expect(bad(`INSERT INTO contact_tags(organization_id, contact_id, tag_id, set_by) VALUES ('${ORG_B}', '${contactId}', '${tagId}', 'system')`)).rejects.toThrow(/contact_tags_contact_fk/);
    await expect(bad(`INSERT INTO contact_tags(organization_id, contact_id, tag_id, set_by) VALUES ('${ORG_A}', '${contactId}', '${tagId}', 'robot')`)).rejects.toThrow(/contact_tags_set_by_valid|contact_tags_pk/);
    await expect(bad(`UPDATE contacts SET ctwa_cl_id = '   ' WHERE id = '${contactId}'`)).rejects.toThrow(/contacts_ctwa_cl_id_shape/);
    await expect(bad(`UPDATE contacts SET last_touch_source = 'Mi Fuente' WHERE id = '${contactId}'`)).rejects.toThrow(/contacts_touch_source_shape/);
    const ev = `INSERT INTO meta_events(organization_id, id, event_id, type, contact_id, status, send_after, payload)`;
    await expect(bad(`${ev} VALUES ('${ORG_A}', gen_random_uuid(), 'x1', 'Otro', '${contactId}', 'pending', now(), '{}')`)).rejects.toThrow(/meta_events_type_valid/);
    await expect(bad(`${ev} VALUES ('${ORG_A}', gen_random_uuid(), 'x1', 'Lead', '${contactId}', 'enviado', now(), '{}')`)).rejects.toThrow(/meta_events_status_valid/);
    await expect(bad(`${ev} VALUES ('${ORG_B}', gen_random_uuid(), 'x1', 'Lead', '${contactId}', 'pending', now(), '{}')`)).rejects.toThrow(/meta_events_contact_fk/);
    await expect(bad(`${ev} VALUES ('${ORG_A}', gen_random_uuid(), '${String((await events(ORG_A))[0]!['event_id'])}', 'Lead', '${contactId}', 'pending', now(), '{}')`)).rejects.toThrow(/meta_events_org_event_id_uq/);
    await expect(bad(`INSERT INTO attribution_endpoints(id, organization_id, secret_hash) VALUES (gen_random_uuid(), '${ORG_A}', repeat('a', 64))`)).rejects.toThrow(/attribution_endpoints_org_uq|secret_hash_hex/);
  });

  it('la RLS: sin organización activa app_rw no ve nada; con la de A no ve lo de B', async () => {
    const a = await setup(T.alice);
    const b = await setup(T.bob);
    await hook(a.id, a.secret, click());
    await hook(b.id, b.secret, click({ phone: P2, ctwa_cl_id: 'CLID-B' }));
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      expect((await c.query('SELECT count(*)::int AS n FROM meta_events')).rows[0].n).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query('SELECT count(*)::int AS n FROM meta_events')).rows[0].n).toBe(1);
      expect((await c.query('SELECT count(*)::int AS n FROM tags')).rows[0].n).toBe(3);
      expect((await c.query('SELECT count(*)::int AS n FROM contact_tags')).rows[0].n).toBe(1);
      await expect(c.query(`INSERT INTO tags(organization_id, id, name) VALUES ('${ORG_B}', gen_random_uuid(), 'Intruso')`)).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
