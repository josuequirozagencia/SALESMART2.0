// M7.2 — Avisos del Workflow de GoHighLevel (ADR-52): receptor público, proceso asíncrono y panel. Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   POST /v1/integrations/ghl/webhook/:routeId
//   GET /v1/ghl/events
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { FakeGhlProvider, GHL_EVENT_MAX_ATTEMPTS, GHL_PAYLOAD_RETENTION_DAYS, GhlEventsJob, GhlEventsService, GhlModule } from '../../src/modules/ghl';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

const fake = new FakeGhlProvider();

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, GhlModule.register({ provider: fake }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const TOKEN = 'pit-aaaaaaaa-1111-4222-8333-alicia0123456789';
const LOC_A = 've9EPM428h8vShlRW1KT';
const LOC_B = 'Zk3Rm91QpWxYtLuNc7Aa';
const PHONE = '+593984217730';
// Los avisos se guardan con la hora real: el proceso de la prueba corre «un poco después»
const NOW = new Date(Date.now() + 10 * 60_000);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
let hookA: { id: string; secret: string };
let hookB: { id: string; secret: string };
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ghl_events, ghl_contact_links, ghl_connections, ghl_routes, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

/** Envía un aviso como lo haría el Workflow: ruta + cabecera con el secreto. */
const hook = (h: { id: string; secret: string }, body: unknown, secret: string | null = h.secret) => call('POST', `/integrations/ghl/webhook/${h.id}`, undefined, body, secret === null ? {} : { 'x-webhook-secret': secret });
const connect = async (token: string, loc: string) => {
  const r = await call('PUT', '/ghl/connection', token, { location_id: loc, access_token: TOKEN });
  expect(r.status).toBe(200);
};
const issue = async (token: string) => (await call('POST', '/ghl/webhook/secret', token).then((r) => json<{ id: string; secret: string }>(r)));
const events = async (org = ORG_A) => (await admin.query(`SELECT * FROM ghl_events WHERE organization_id = $1 ORDER BY received_at, id`, [org])).rows as Array<Record<string, unknown>>;
const process_ = (org: string, at: Date = NOW) => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, () => app.get(GhlEventsService).runDue(at));
const contactsOf = async (org = ORG_A) => (await admin.query(`SELECT c.id, c.name, c.email, c.source, c.consent, c.owner_id, p.e164 FROM contacts c LEFT JOIN contact_phones p ON p.contact_id = c.id AND p.organization_id = c.organization_id WHERE c.organization_id = $1 ORDER BY c.created_at`, [org])).rows as Array<Record<string, unknown>>;
const links = async (org = ORG_A) => (await admin.query(`SELECT ghl_contact_id, contact_id FROM ghl_contact_links WHERE organization_id = $1`, [org])).rows as Array<{ ghl_contact_id: string; contact_id: string }>;
const ana = (over: Record<string, unknown> = {}) => ({ contact_id: 'GHL-ANA', full_name: 'Ana Torres', phone: PHONE, email: 'ana@correo.test', ...over });

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  await admin.query('DROP TRIGGER IF EXISTS boom ON contacts');
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
  await connect(T.alice, LOC_A);
  await connect(T.bob, LOC_B);
  hookA = await issue(T.alice);
  hookB = await issue(T.bob);
});

describe('receptor público · quién puede entrar', () => {
  it('con la ruta y el secreto vigentes guarda el aviso y responde 200 al instante, sin procesarlo todavía', async () => {
    const r = await hook(hookA, ana());
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ ok: true });
    const [ev] = await events();
    expect(ev).toMatchObject({ status: 'pending', event_type: 'contact', ghl_contact_id: 'GHL-ANA', attempts: 0, outcome: null });
    expect(await contactsOf()).toEqual([]); // aún nada creado: lo hace la tarea
  });

  it('secreto equivocado, ausente, de otra empresa o ruta desconocida: la MISMA respuesta (404) y nada guardado', async () => {
    const wrong = await hook(hookA, ana(), 'ghw_equivocado');
    const none = await hook(hookA, ana(), null);
    const foreign = await hook(hookA, ana(), hookB.secret);
    const unknown = await hook({ id: randomUUID(), secret: hookA.secret }, ana());
    const bodies = await Promise.all([wrong, none, foreign, unknown].map(async (r) => { expect(r.status).toBe(404); return JSON.stringify((await json<{ error: { code: string; message: string } }>(r)).error).replace(/"request_id":"[^"]*",?/, ''); }));
    expect(new Set(bodies).size).toBe(1);
    expect(await events()).toHaveLength(0);
    expect(await events(ORG_B)).toHaveLength(0);
  });

  it('una ruta que no es un identificador válido da 400 sin tocar la base', async () => {
    const r = await call('POST', '/integrations/ghl/webhook/no-es-uuid', undefined, ana(), { 'x-webhook-secret': hookA.secret });
    expect(r.status).toBe(400);
  });

  it('autenticar va ANTES de validar: sin credencial un cuerpo malo también da 404 (no revela nada)', async () => {
    const r = await hook(hookA, { cualquier: 'cosa' }, 'ghw_equivocado');
    expect(r.status).toBe(404);
  });

  it('el secreto rotado deja de servir y el nuevo sirve; el aviso se guarda en la empresa de la RUTA, no en la que diga el cuerpo', async () => {
    const next = await issue(T.alice);
    expect(next.id).toBe(hookA.id);
    expect((await hook(hookA, ana())).status).toBe(404);
    expect((await hook(next, { ...ana(), organization_id: ORG_B })).status).toBe(200);
    expect(await events(ORG_A)).toHaveLength(1);
    expect(await events(ORG_B)).toHaveLength(0);
  });

  it('empresa sin conexión o desconectada: 404; con el token rechazado SÍ recibe (entrar no usa el token)', async () => {
    await call('POST', '/ghl/connection/disconnect', T.alice);
    expect((await hook(hookA, ana())).status).toBe(404);
    expect(await events()).toHaveLength(0);
    await admin.query(`DELETE FROM ghl_connections WHERE organization_id = $1`, [ORG_B]);
    expect((await hook(hookB, ana())).status).toBe(404);
    // reconectar y luego marcar «requiere reconexión»
    await connect(T.alice, LOC_A);
    fake.failNextVerify(new (await import('../../src/modules/ghl')).GhlError('rechazado', false, true));
    await call('POST', '/ghl/connection/test', T.alice);
    expect((await call('GET', '/ghl/connection', T.alice).then((r) => json<{ status: string }>(r))).status).toBe('needs_reconnect');
    expect((await hook(hookA, ana())).status).toBe(200);
  });
});

describe('receptor público · contrato del cuerpo', () => {
  it('un cuerpo fuera de contrato da 400 con el detalle (para armar el Workflow) y no guarda nada', async () => {
    for (const [body, path] of [[{}, 'contact_id'], [{ contact_id: 'C1', event: 'otro' }, 'event'], [{ contact_id: 'x'.repeat(101) }, 'contact_id']] as const) {
      const r = await hook(hookA, body);
      expect(r.status).toBe(400);
      expect(JSON.stringify(await json(r))).toContain(path);
    }
    expect((await hook(hookA, [1, 2])).status).toBe(400);
    expect(await events()).toHaveLength(0);
  });

  it('un aviso de OTRA Location es 400 (Workflow mal conectado); de la misma Location, o sin Location, entra', async () => {
    const r = await hook(hookA, ana({ location: { id: LOC_B } }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(await json(r))).toContain('location_mismatch');
    expect((await hook(hookA, ana({ location: { id: LOC_A } }))).status).toBe(200);
    expect((await hook(hookA, ana({ contact_id: 'OTRO' }))).status).toBe(200);
    expect(await events()).toHaveLength(2);
  });

  it('un cuerpo enorme se rechaza antes de procesarse (413)', async () => {
    const r = await hook(hookA, ana({ notas: 'x'.repeat(300_000) }));
    expect(r.status).toBe(413);
    expect(await events()).toHaveLength(0);
  });

  it('solo se guarda lo que el contrato conoce: lo demás del cuerpo (direcciones, notas…) nunca llega a la base', async () => {
    await hook(hookA, { ...ana(), address1: 'Calle Secreta 123', customData: { nota_privada: 'no guardar' }, attributionSource: { sessionSource: 'x' } });
    const [ev] = await events();
    expect(Object.keys(ev!['payload'] as object).sort()).toEqual(['email', 'message', 'name', 'phone', 'phone_invalid', 'tags']);
    expect(JSON.stringify(ev)).not.toMatch(/Calle Secreta|no guardar|sessionSource/);
  });

  it('el mismo aviso repetido (por event_id, o igual dentro de 10 minutos) se guarda una sola vez', async () => {
    expect((await hook(hookA, ana({ event_id: 'wf-1' }))).status).toBe(200);
    expect((await hook(hookA, ana({ event_id: 'wf-1', full_name: 'Otro nombre' }))).status).toBe(200);
    expect(await events()).toHaveLength(1);
    await hook(hookA, ana({ contact_id: 'OTRO' }));
    await hook(hookA, ana({ contact_id: 'OTRO' }));
    expect(await events()).toHaveLength(2);
  });

  it('el receptor limita el ritmo por (IP, ruta): pasado el tope responde 429', async () => {
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await hook(hookB, ana({ contact_id: `RATE-${i % 3}` }))).status;
    expect(last).toBe(429);
  });
});

describe('proceso de los avisos de contacto', () => {
  it('un contacto nuevo de GHL crea el contacto (origen «ghl», sin consentimiento ni responsable), el vínculo y deja el aviso hecho', async () => {
    await hook(hookA, ana());
    expect(await process_(ORG_A)).toBe(1);
    const cs = await contactsOf();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ name: 'Ana Torres', source: 'ghl', consent: 'unknown', owner_id: null, e164: PHONE, email: 'ana@correo.test' });
    expect(await links()).toEqual([{ ghl_contact_id: 'GHL-ANA', contact_id: cs[0]!['id'] }]);
    const [ev] = await events();
    expect(ev).toMatchObject({ status: 'done', outcome: 'contact_created', contact_id: cs[0]!['id'], attempts: 1, last_error: null, note: null });
    expect(ev!['processed_at']).toBeTruthy();
    const audit = (await admin.query(`SELECT source, field FROM audit_logs WHERE entity_type = 'contact' AND entity_id = $1 ORDER BY at`, [cs[0]!['id']])).rows;
    expect(audit.every((a) => a.source === 'ghl')).toBe(true);
    expect(audit.map((a) => a.field)).toContain('email');
  });

  it('un contacto que ya existe por teléfono se vincula sin tocar su nombre ni su responsable; el correo vacío se completa', async () => {
    const id = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Ana (cliente VIP)', $2) RETURNING id`, [ORG_A, IDS.carol])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [ORG_A, id, PHONE]);
    await hook(hookA, ana());
    await process_(ORG_A);
    const cs = await contactsOf();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ id, name: 'Ana (cliente VIP)', owner_id: IDS.carol, email: 'ana@correo.test' });
    expect((await events())[0]).toMatchObject({ status: 'done', outcome: 'contact_linked', contact_id: id });
    expect(await links()).toEqual([{ ghl_contact_id: 'GHL-ANA', contact_id: id }]);
  });

  it('un contacto cuyo nombre es solo su teléfono recibe el nombre real; con un nombre propio, no se pisa', async () => {
    const id = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [ORG_A, PHONE])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [ORG_A, id, PHONE]);
    await hook(hookA, ana());
    await process_(ORG_A);
    expect((await contactsOf())[0]).toMatchObject({ name: 'Ana Torres' });
    await hook(hookA, ana({ full_name: 'Ana Otra', email: 'otro@correo.test' }));
    await process_(ORG_A);
    expect((await contactsOf())[0]).toMatchObject({ name: 'Ana Torres', email: 'ana@correo.test' }); // ni nombre ni correo se pisan
    expect((await events()).map((e) => e['outcome'])).toEqual(['contact_linked', 'contact_unchanged']);
  });

  it('un aviso posterior del mismo contacto de GHL lo encuentra por el vínculo (aunque ahora traiga otro teléfono) y no crea otro', async () => {
    await hook(hookA, ana({ email: undefined }));
    await process_(ORG_A);
    await hook(hookA, { contact_id: 'GHL-ANA', email: 'nuevo@correo.test', phone: '+593999999999' });
    await process_(ORG_A);
    const cs = await contactsOf();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ email: 'nuevo@correo.test', e164: PHONE });
    expect((await events()).map((e) => e['outcome'])).toEqual(['contact_created', 'contact_updated']);
  });

  it('sin teléfono, o con uno sin formato internacional, un contacto desconocido se OMITE con su motivo y no se crea nada', async () => {
    await hook(hookA, { contact_id: 'SIN-TEL', full_name: 'Sin Teléfono', email: 'x@y.test' });
    await hook(hookA, { contact_id: 'TEL-MALO', full_name: 'Tel Malo', phone: '0984217730' });
    await process_(ORG_A);
    const evs = await events();
    expect(evs.map((e) => e['status'])).toEqual(['skipped', 'skipped']);
    expect(evs[0]!['note']).toContain('no trae teléfono');
    expect(evs[1]!['note']).toContain('formato internacional');
    expect(await contactsOf()).toEqual([]);
    expect(await links()).toEqual([]);
  });

  it('el teléfono de un contacto ya vinculado a OTRO contacto de GHL no se reasigna: se omite', async () => {
    await hook(hookA, ana());
    await process_(ORG_A);
    await hook(hookA, ana({ contact_id: 'GHL-OTRO', full_name: 'Homónimo' }));
    await process_(ORG_A);
    expect((await events())[1]).toMatchObject({ status: 'skipped' });
    expect((await events())[1]!['note']).toContain('otro contacto de GoHighLevel');
    expect(await contactsOf()).toHaveLength(1);
    expect(await links()).toHaveLength(1);
  });

  it('si el contacto vinculado se borró, el siguiente aviso crea uno nuevo y mueve el vínculo', async () => {
    await hook(hookA, ana());
    await process_(ORG_A);
    const old = (await contactsOf())[0]!['id'];
    await admin.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [old]);
    await admin.query(`UPDATE contact_phones SET deleted_at = now() WHERE contact_id = $1`, [old]);
    await hook(hookA, ana({ email: 'otra@vez.test' }));
    await process_(ORG_A);
    const live = (await contactsOf()).filter((c) => c['id'] !== old);
    expect(live).toHaveLength(1);
    expect(await links()).toEqual([{ ghl_contact_id: 'GHL-ANA', contact_id: live[0]!['id'] }]);
    expect((await events())[1]).toMatchObject({ status: 'done', outcome: 'contact_created' });
  });

  it('un aviso de mensaje sin el texto es 400 y no guarda nada (los mensajes se prueban en ghl-messages.test.ts)', async () => {
    const r = await hook(hookA, ana({ event: 'message_in' }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(await json(r))).toContain('message');
    expect(await events()).toEqual([]);
  });

  it('un fallo al procesar reintenta con espera creciente y tras el máximo de intentos queda «failed», sin datos personales en el error', async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falla de prueba'; END $$`);
    await admin.query(`CREATE TRIGGER boom BEFORE INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION boom()`);
    try {
      await hook(hookA, ana());
      await hook(hookA, ana({ contact_id: 'GHL-B', full_name: 'Beta', phone: '+593911111111' }));
      let at = NOW;
      let before = 0;
      for (let attempt = 1; attempt < GHL_EVENT_MAX_ATTEMPTS; attempt++) {
        expect(await process_(ORG_A, at)).toBe(2);
        const evs = await events();
        expect(evs.every((e) => e['status'] === 'pending' && e['attempts'] === attempt)).toBe(true);
        const next = new Date(evs[0]!['next_attempt_at'] as Date).getTime();
        expect(next).toBeGreaterThan(Math.max(before, at.getTime())); // la espera crece
        before = next - at.getTime();
        // antes de la hora de reintento no se vuelve a tomar
        expect(await process_(ORG_A, new Date(at.getTime() + 1_000))).toBe(0);
        at = new Date(next + 1);
      }
      expect(await process_(ORG_A, at)).toBe(2);
      const evs = await events();
      expect(evs.map((e) => e['status'])).toEqual(['failed', 'failed']);
      expect(evs.every((e) => e['attempts'] === GHL_EVENT_MAX_ATTEMPTS)).toBe(true);
      expect(JSON.stringify(evs.map((e) => e['last_error']))).not.toMatch(/593|Ana|ana@|falla de prueba/);
      expect(await contactsOf()).toEqual([]);
    } finally {
      await admin.query('DROP TRIGGER IF EXISTS boom ON contacts');
    }
  });

  it('cuando el fallo se arregla, el aviso pendiente se procesa en el siguiente intento', async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falla de prueba'; END $$`);
    await admin.query(`CREATE TRIGGER boom BEFORE INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION boom()`);
    await hook(hookA, ana());
    await process_(ORG_A, NOW);
    expect((await events())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await admin.query('DROP TRIGGER boom ON contacts');
    const retryAt = new Date(new Date((await events())[0]!['next_attempt_at'] as Date).getTime() + 1);
    await process_(ORG_A, retryAt);
    expect((await events())[0]).toMatchObject({ status: 'done', outcome: 'contact_created', attempts: 2, last_error: null });
  });

  it('a los 30 días el contenido de los avisos terminados se vacía (queda el registro); los pendientes no', async () => {
    await hook(hookA, ana());
    await hook(hookA, ana({ contact_id: 'SIN-TEL', phone: undefined }));
    await process_(ORG_A);
    const later = new Date(NOW.getTime() + (GHL_PAYLOAD_RETENTION_DAYS + 1) * 86_400_000);
    await hook(hookA, ana({ contact_id: 'RECIENTE' }), hookA.secret); // llega ahora, sin procesar
    await admin.query(`UPDATE ghl_events SET processed_at = $1 WHERE status <> 'pending'`, [NOW]);
    await process_(ORG_A, later);
    const evs = await events();
    const done = evs.filter((e) => e['ghl_contact_id'] !== 'RECIENTE');
    expect(done.every((e) => e['payload'] === null && e['redacted_at'])).toBe(true);
    expect(done.map((e) => e['status']).sort()).toEqual(['done', 'skipped']);
  });

  it('la tarea recorre solo las empresas con punto de entrada y procesa cada una bajo su contexto', async () => {
    await hook(hookA, ana());
    await hook(hookB, ana({ contact_id: 'GHL-BETO', full_name: 'Beto Cliente', phone: '+593922222222' }));
    expect(await app.get(GhlEventsJob).run(NOW)).toBe(2);
    expect((await contactsOf(ORG_A)).map((c) => c['name'])).toEqual(['Ana Torres']);
    expect((await contactsOf(ORG_B)).map((c) => c['name'])).toEqual(['Beto Cliente']);
    expect(await app.get(GhlEventsJob).run(NOW)).toBe(0);
  });

  it('procesar una empresa no toca los avisos de otra (RLS)', async () => {
    await hook(hookB, ana({ contact_id: 'GHL-BETO', phone: '+593922222222' }));
    expect(await process_(ORG_A)).toBe(0);
    expect((await events(ORG_B))[0]).toMatchObject({ status: 'pending' });
    expect(await process_(ORG_B)).toBe(1);
  });
});

describe('panel de avisos', () => {
  it('lista los avisos recientes primero, con el contacto, el resultado y el motivo; sin teléfonos ni correos', async () => {
    await hook(hookA, ana());
    await hook(hookA, { contact_id: 'SIN-TEL', full_name: 'Sin Teléfono' });
    await hook(hookA, ana({ contact_id: 'PEND', phone: '+593933333333' }));
    await process_(ORG_A);
    await hook(hookA, ana({ contact_id: 'ULTIMO', phone: '+593944444444' }));
    const r = await call('GET', '/ghl/events', T.alice);
    expect(r.status).toBe(200);
    const body = await json<{ items: Array<Record<string, unknown>>; next_cursor: string | null }>(r);
    expect(body.items.map((i) => i['ghl_contact_id'])).toEqual(['ULTIMO', 'PEND', 'SIN-TEL', 'GHL-ANA']);
    expect(body.items[0]).toMatchObject({ status: 'pending', outcome: null, contact: null });
    expect(body.items[3]).toMatchObject({ status: 'done', outcome: 'contact_created', contact: { name: 'Ana Torres' } });
    expect(body.items[2]).toMatchObject({ status: 'skipped', note: expect.stringContaining('no trae teléfono') });
    expect(JSON.stringify(body)).not.toMatch(/\+5939|@correo\.test/);
    expect(body.next_cursor).toBeNull();
  });

  it('filtra por estado y se pagina con cursor', async () => {
    for (let i = 0; i < 5; i++) await hook(hookA, ana({ contact_id: `G${i}`, phone: `+59390000000${i}` }));
    await process_(ORG_A);
    await hook(hookA, { contact_id: 'SIN-TEL' });
    await process_(ORG_A);
    const skipped = await call('GET', '/ghl/events?status=skipped', T.alice).then((r) => json<{ items: unknown[] }>(r));
    expect(skipped.items).toHaveLength(1);
    const p1 = await call('GET', '/ghl/events?limit=4', T.alice).then((r) => json<{ items: Array<{ ghl_contact_id: string }>; next_cursor: string | null }>(r));
    expect(p1.items).toHaveLength(4);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await call('GET', `/ghl/events?limit=4&cursor=${p1.next_cursor}`, T.alice).then((r) => json<{ items: Array<{ ghl_contact_id: string }>; next_cursor: string | null }>(r));
    expect(p2.items).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.ghl_contact_id)).size).toBe(6);
    for (const bad of ['?status=raro', '?limit=0', '?limit=99', '?cursor=basura', '?otro=1']) expect((await call('GET', `/ghl/events${bad}`, T.alice)).status, bad).toBe(400);
  });

  it('solo el administrador lo ve (la asesora 403, sin sesión 401) y cada empresa ve solo lo suyo', async () => {
    await hook(hookA, ana());
    await hook(hookB, ana({ contact_id: 'GHL-BETO', phone: '+593922222222' }));
    expect((await call('GET', '/ghl/events')).status).toBe(401);
    expect((await call('GET', '/ghl/events', T.carol)).status).toBe(403);
    const a = await call('GET', '/ghl/events', T.alice).then((r) => json<{ items: Array<{ ghl_contact_id: string }> }>(r));
    const b = await call('GET', '/ghl/events', T.bob).then((r) => json<{ items: Array<{ ghl_contact_id: string }> }>(r));
    expect(a.items.map((i) => i.ghl_contact_id)).toEqual(['GHL-ANA']);
    expect(b.items.map((i) => i.ghl_contact_id)).toEqual(['GHL-BETO']);
  });
});

describe('privilegios y restricciones de la base', () => {
  const as = async (url: string, sql: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  };

  it('ghl_events y ghl_contact_links son de negocio: solo app_rw, sin DELETE ni TRUNCATE; platform e identity no las ven', async () => {
    for (const t of ['ghl_events', 'ghl_contact_links']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), t).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), t).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });

  it('las restricciones impiden avisos y vínculos incoherentes', async () => {
    const bad = (sql: string) => admin.query(sql);
    const ins = (cols: string, vals: string) => `INSERT INTO ghl_events(id, organization_id, ${cols}) VALUES (gen_random_uuid(), '${ORG_A}', ${vals})`;
    await expect(bad(ins('dedupe_key, event_type, ghl_contact_id', `'k', 'tag', 'C1'`))).rejects.toThrow(/ghl_events_type_valid/);
    await expect(bad(ins('dedupe_key, event_type, ghl_contact_id, status', `'k', 'contact', 'C1', 'raro'`))).rejects.toThrow(/ghl_events_status_valid/);
    await expect(bad(ins('dedupe_key, event_type, ghl_contact_id, outcome', `'k', 'contact', 'C1', 'magia'`))).rejects.toThrow(/ghl_events_outcome_valid/);
    await expect(bad(ins('dedupe_key, event_type, ghl_contact_id', `'k', 'contact', ''`))).rejects.toThrow(/ghl_events_ghl_contact_shape/);
    await expect(bad(ins('dedupe_key, event_type, ghl_contact_id', `'', 'contact', 'C1'`))).rejects.toThrow(/ghl_events_dedupe_shape/);
    await bad(ins('dedupe_key, event_type, ghl_contact_id', `'unica', 'contact', 'C1'`));
    await expect(bad(ins('dedupe_key, event_type, ghl_contact_id', `'unica', 'contact', 'C2'`))).rejects.toThrow(/ghl_events_org_dedupe_uq/);
    // un vínculo solo apunta a un contacto de SU empresa (clave foránea compuesta) y es uno a uno
    const a = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), '${ORG_A}', 'A') RETURNING id`)).rows[0].id as string;
    const b = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), '${ORG_B}', 'B') RETURNING id`)).rows[0].id as string;
    const link = (org: string, ghl: string, contact: string) => `INSERT INTO ghl_contact_links(id, organization_id, ghl_contact_id, contact_id) VALUES (gen_random_uuid(), '${org}', '${ghl}', '${contact}')`;
    await expect(bad(link(ORG_A, 'G1', b))).rejects.toThrow(/ghl_contact_links_contact_fk/);
    await bad(link(ORG_A, 'G1', a));
    await expect(bad(link(ORG_A, 'G1', a))).rejects.toThrow(/ghl_contact_links_ghl_uq|ghl_contact_links_contact_uq/);
    await expect(bad(link(ORG_A, 'G2', a))).rejects.toThrow(/ghl_contact_links_contact_uq/);
  });
});
