// M6.4 — Conexión de cada empresa con la API de Conversiones de Meta y panel de eventos (ADR-45 #5/ADR-51). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/meta/settings
//   PUT /v1/meta/settings
//   POST /v1/meta/settings/test
//   GET /v1/meta/events
//   POST /v1/meta/events/:id/retry
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AttributionModule, AttributionService, CapiSendError, CapiSenderService, DEFAULT_GRACE_MINUTES, FakeCapiProvider } from '../../src/modules/attribution';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

/** Como el adaptador real: SIN credenciales de la empresa no envía. */
class CredFake extends FakeCapiProvider {
  override readonly requiresCredentials = true;
}
const fake = new CredFake();

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, AttributionModule.register({ capi: fake }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
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
const TOKEN_A = 'EAAGm0PX4ZCpsBAalicia0123456789abcdef';
const TOKEN_B = 'EAAGm0PX4ZCpsBAbeto0123456789abcdefgh';
const DATASET_A = '111122223333444';
const DATASET_B = '555566667777888';
const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE meta_settings, meta_events, conversations, whatsapp_accounts, channel_accounts, contact_tags, tags, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);

interface Settings { configured: boolean; available: boolean; dataset_id: string | null; token_last4: string | null; grace_minutes: number; test_event_code: string | null; enabled: boolean; last_error: string | null; last_check_at: string | null; counts: Record<string, number> }
interface EventRow { id: string; event_id: string; type: string; status: string; attempts: number; contact: { id: string; name: string } | null; last_error: string | null; can_retry: boolean }
const save = (token: string, body: Record<string, unknown>) => call('PUT', '/meta/settings', token, body);
const good = (over: Record<string, unknown> = {}) => ({ dataset_id: DATASET_A, access_token: TOKEN_A, grace_minutes: 30, test_event_code: null, enabled: true, ...over });
const events = (token: string, q = '') => call('GET', `/meta/events${q}`, token).then((r) => json<{ items: EventRow[]; next_cursor: string | null }>(r));

let seq = 0;
/** Un contacto que llegó por un anuncio, y un Purchase pendiente de él (el evento se arma con el servicio de atribución, como al vender). */
async function purchase(org: string, over: { amount?: number; now?: Date; saleId?: string } = {}): Promise<{ contactId: string; saleId: string; eventId: string }> {
  seq += 1;
  const contactId = (await admin.query(`INSERT INTO contacts(id, organization_id, name, ctwa_cl_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, `ctwa-${seq}`])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contactId, `+59397000${String(seq).padStart(4, '0')}`]);
  const saleId = over.saleId ?? randomUUID();
  const r = await inOrg(org, () => app.get(Database).withTenant((tx) => app.get(AttributionService).onSaleTagSet(tx, { contactId, saleId, amount: over.amount ?? 100, currency: 'USD' }, over.now ?? NOW)));
  return { contactId, saleId, eventId: r.eventId };
}
const run = (org: string, now: Date) => inOrg(org, () => app.get(CapiSenderService).runDue(now));
const status = async (eventId: string): Promise<string> => (await admin.query(`SELECT status FROM meta_events WHERE event_id = $1`, [eventId])).rows[0].status as string;
const due = (): Date => new Date(NOW.getTime() + 3 * DAY);

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
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
  fake.sent.length = 0;
  fake.credentials.length = 0;
  fake.verified.length = 0;
  fake.datasetName = 'Pixel de la barbería';
});

describe('conexión con Meta · permisos y aislamiento', () => {
  it('sin sesión 401; un asesor no ve ni cambia nada (403); solo el administrador', async () => {
    for (const [m, p, b] of [['GET', '/meta/settings'], ['PUT', '/meta/settings', good()], ['POST', '/meta/settings/test'], ['GET', '/meta/events'], ['POST', `/meta/events/${randomUUID()}/retry`]] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
    expect((await call('GET', '/meta/settings', T.alice)).status).toBe(200);
  });

  it('cada empresa tiene SU conexión: lo que guarda A no lo ve B, ni el dataset ni el token ni los eventos', async () => {
    expect((await save(T.alice, good())).status).toBe(200);
    expect((await save(T.bob, good({ dataset_id: DATASET_B, access_token: TOKEN_B }))).status).toBe(200);
    const a = await json<Settings>(await call('GET', '/meta/settings', T.alice));
    const b = await json<Settings>(await call('GET', '/meta/settings', T.bob));
    expect(a).toMatchObject({ dataset_id: DATASET_A, token_last4: TOKEN_A.slice(-4) });
    expect(b).toMatchObject({ dataset_id: DATASET_B, token_last4: TOKEN_B.slice(-4) });
    const pa = await purchase(ORG_A);
    expect((await events(T.alice)).items.map((e) => e.event_id)).toEqual([pa.eventId]);
    expect((await events(T.bob)).items).toEqual([]);
    expect((await call('POST', `/meta/events/${(await events(T.alice)).items[0]!.id}/retry`, T.bob)).status).toBe(404);
    expect(await admin.query(`SELECT count(*)::int n FROM meta_settings`).then((r) => r.rows[0].n)).toBe(2);
  });
});

describe('conexión con Meta · guardar', () => {
  it('antes de configurar: sin credenciales, ventana por omisión y encendida=false', async () => {
    expect(await json<Settings>(await call('GET', '/meta/settings', T.alice))).toMatchObject({ configured: false, available: true, dataset_id: null, token_last4: null, grace_minutes: DEFAULT_GRACE_MINUTES, enabled: false, last_error: null });
  });

  it('guarda tras comprobar el token con Meta; el token NO vuelve en ninguna respuesta, no queda en claro en la base ni en la auditoría', async () => {
    const r = await save(T.alice, good({ grace_minutes: 45, test_event_code: 'TEST12345' }));
    expect(r.status).toBe(200);
    const text = JSON.stringify(await r.json());
    expect(text).not.toContain(TOKEN_A);
    expect(JSON.parse(text)).toMatchObject({ configured: true, dataset_id: DATASET_A, token_last4: 'cdef', grace_minutes: 45, test_event_code: 'TEST12345', enabled: true, last_error: null });
    expect(fake.verified).toEqual([{ datasetId: DATASET_A, accessToken: TOKEN_A, testEventCode: 'TEST12345' }]);
    expect(JSON.stringify(await (await call('GET', '/meta/settings', T.alice)).json())).not.toContain(TOKEN_A);
    const row = (await admin.query(`SELECT credentials_sealed, token_last4 FROM meta_settings`)).rows[0];
    expect(row.credentials_sealed).not.toContain(TOKEN_A);
    expect(row.credentials_sealed).not.toContain('alicia');
    const audit = JSON.stringify((await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'meta_settings'`)).rows);
    expect(audit).not.toContain(TOKEN_A);
  });

  it('si Meta rechaza el token o el dataset, NO se guarda nada y el motivo llega a la persona', async () => {
    fake.failNextVerify(new CapiSendError('Meta rechazó las credenciales: Invalid OAuth access token', false, true));
    const r = await save(T.alice, good());
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain('Meta rechazó las credenciales');
    expect(await admin.query(`SELECT count(*)::int n FROM meta_settings`).then((x) => x.rows[0].n)).toBe(0);
    fake.failNextVerify(new CapiSendError('Meta no pudo atender', true));
    const down = await save(T.alice, good());
    expect(down.status).toBe(503);
    expect(await code(down)).toBe('META_UNREACHABLE');
    expect(await admin.query(`SELECT count(*)::int n FROM meta_settings`).then((x) => x.rows[0].n)).toBe(0);
  });

  it('valida los datos: dataset solo dígitos, token mínimo, ventana de 0 a 24 h, código de prueba acotado, y el token es obligatorio la primera vez', async () => {
    for (const body of [good({ dataset_id: '12ab' }), good({ dataset_id: '../x' }), good({ access_token: 'corto' }), good({ access_token: 'tiene espacios en el medio del token ok' }), good({ grace_minutes: -1 }), good({ grace_minutes: 1441 }), good({ grace_minutes: 1.5 }), good({ test_event_code: 'con espacios' }), good({ enabled: 'si' }), { ...good(), extra: 1 }]) {
      expect((await save(T.alice, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await save(T.alice, { dataset_id: DATASET_A, grace_minutes: 30, test_event_code: null, enabled: true })).status).toBe(400); // sin token la primera vez
    expect(await admin.query(`SELECT count(*)::int n FROM meta_settings`).then((x) => x.rows[0].n)).toBe(0);
  });

  it('cambiar ventana, código de prueba o encendido no pide el token y conserva el guardado; cambiar de dataset sí lo pide', async () => {
    await save(T.alice, good());
    const rest = { dataset_id: DATASET_A, grace_minutes: 0, test_event_code: 'PRUEBA1', enabled: false };
    const r = await save(T.alice, rest);
    expect(r.status).toBe(200);
    expect(await json<Settings>(r)).toMatchObject({ grace_minutes: 0, test_event_code: 'PRUEBA1', enabled: false, token_last4: 'cdef' });
    expect(fake.verified).toHaveLength(1); // solo se comprobó al pegar el token
    const other = await save(T.alice, { ...rest, dataset_id: '999988887777666' });
    expect(other.status).toBe(400);
    expect(JSON.stringify(await other.json())).toContain('token');
    expect((await save(T.alice, { ...rest, dataset_id: '999988887777666', access_token: TOKEN_B })).status).toBe(200);
    const fields = (await admin.query(`SELECT field FROM audit_logs WHERE entity_type = 'meta_settings' AND field IS NOT NULL ORDER BY field`)).rows.map((x) => x.field);
    expect(fields).toEqual(expect.arrayContaining(['access_token', 'dataset_id', 'enabled', 'grace_minutes', 'test_event_code']));
  });

  it('«Probar conexión» vuelve a comprobar con Meta y anota el resultado; sin conexión guardada, 404', async () => {
    expect((await call('POST', '/meta/settings/test', T.alice)).status).toBe(404);
    await save(T.alice, good());
    const ok = await call('POST', '/meta/settings/test', T.alice);
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ ok: true, dataset_name: 'Pixel de la barbería' });
    expect(fake.verified.at(-1)).toMatchObject({ accessToken: TOKEN_A }); // usó el token guardado
    fake.failNextVerify(new CapiSendError('Meta rechazó las credenciales: token vencido', false, true));
    const bad = await call('POST', '/meta/settings/test', T.alice);
    expect(bad.status).toBe(400);
    expect((await json<Settings>(await call('GET', '/meta/settings', T.alice))).last_error).toContain('token vencido');
    expect((await json<Settings>(await call('GET', '/meta/settings', T.alice))).last_check_at).not.toBeNull();
    await call('POST', '/meta/settings/test', T.alice);
    expect((await json<Settings>(await call('GET', '/meta/settings', T.alice))).last_error).toBeNull();
  });

  it('la base no deja borrar la conexión a la aplicación y rechaza valores fuera de rango', async () => {
    await save(T.alice, good());
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await expect(c.query(`DELETE FROM meta_settings`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
    await expect(admin.query(`UPDATE meta_settings SET grace_minutes = 2000`)).rejects.toThrow(/meta_settings_grace_valid/);
    await expect(admin.query(`UPDATE meta_settings SET dataset_id = 'abc'`)).rejects.toThrow(/meta_settings_dataset_shape/);
    await expect(admin.query(`INSERT INTO meta_settings(organization_id, id, dataset_id, credentials_sealed, key_version, token_last4) VALUES ($1, gen_random_uuid(), '12345678', 'x', 1, 'abcd')`, [ORG_A])).rejects.toThrow(/meta_settings_org_uq/);
  });
});

describe('envío con las credenciales de cada empresa', () => {
  it('sin conexión guardada (o apagada) los eventos NO se pierden: siguen pendientes; con ella salen con el dataset y el token de ESA empresa', async () => {
    const pa = await purchase(ORG_A);
    const pb = await purchase(ORG_B);
    await admin.query(`UPDATE meta_events SET send_after = $1`, [NOW]);
    expect(await run(ORG_A, due())).toBe(0);
    expect(fake.sent).toEqual([]);
    expect([await status(pa.eventId), await status(pb.eventId)]).toEqual(['pending', 'pending']);

    await save(T.alice, good({ test_event_code: 'TESTA' }));
    expect(await run(ORG_A, due())).toBe(1);
    expect(fake.credentials).toEqual([{ datasetId: DATASET_A, accessToken: TOKEN_A, testEventCode: 'TESTA' }]);
    expect(fake.sent.map((e) => e.eventId)).toEqual([pa.eventId]);
    expect(await status(pa.eventId)).toBe('sent');
    expect(await status(pb.eventId)).toBe('pending'); // B no configuró nada: la tarea de A no toca lo suyo

    await save(T.bob, good({ dataset_id: DATASET_B, access_token: TOKEN_B }));
    expect(await run(ORG_B, due())).toBe(1);
    expect(fake.credentials.at(-1)).toEqual({ datasetId: DATASET_B, accessToken: TOKEN_B, testEventCode: null });

    await save(T.alice, { dataset_id: DATASET_A, grace_minutes: 30, test_event_code: null, enabled: false });
    const again = await purchase(ORG_A);
    await admin.query(`UPDATE meta_events SET send_after = $1 WHERE event_id = $2`, [NOW, again.eventId]);
    expect(await run(ORG_A, due())).toBe(0);
    expect(await status(again.eventId)).toBe('pending');
  });

  it('agrega la cuenta de WhatsApp Business al evento al enviarlo (la del número por el que habló el contacto, o la primera de la empresa)', async () => {
    const ch = (await admin.query(`INSERT INTO channel_accounts(organization_id, id, provider, name) VALUES ($1, gen_random_uuid(), 'meta_cloud', 'Ventas') RETURNING id`, [ORG_A])).rows[0].id as string;
    await admin.query(`INSERT INTO whatsapp_accounts(organization_id, channel_account_id, waba_id, phone_number_id) VALUES ($1, $2, '777888999000111', '1090123456789')`, [ORG_A, ch]);
    await save(T.alice, good());
    const p = await purchase(ORG_A);
    await admin.query(`UPDATE meta_events SET send_after = $1`, [NOW]);
    expect(await run(ORG_A, due())).toBe(1);
    const sent = fake.sent[0]!.payload as { user_data: Record<string, unknown> };
    expect(sent.user_data['whatsapp_business_account_id']).toBe('777888999000111');
    expect(sent.user_data['ctwa_clid']).toMatch(/^ctwa-/);
    expect(p.eventId).toBe(fake.sent[0]!.eventId);
  });

  it('si Meta rechaza las credenciales, el evento queda BLOQUEADO (no fallido), se anota en la conexión y no se insiste con los demás; tras corregir se reintenta desde el panel', async () => {
    await save(T.alice, good());
    const [p1, p2] = [await purchase(ORG_A), await purchase(ORG_A)];
    await admin.query(`UPDATE meta_events SET send_after = $1`, [NOW]);
    fake.failNext(new CapiSendError('Meta rechazó las credenciales: Invalid OAuth access token', false, true));
    await run(ORG_A, due());
    const statuses = [await status(p1.eventId), await status(p2.eventId)].sort();
    expect(statuses).toEqual(['blocked', 'pending']); // el segundo ni se intentó
    const s = await json<Settings>(await call('GET', '/meta/settings', T.alice));
    expect(s.last_error).toContain('Meta rechazó las credenciales');
    expect(s.counts).toMatchObject({ blocked: 1, pending: 1 });
    const blocked = (await events(T.alice, '?status=blocked')).items[0]!;
    expect(blocked).toMatchObject({ can_retry: true, attempts: 1 });
    const retry = await call('POST', `/meta/events/${blocked.id}/retry`, T.alice);
    expect(retry.status).toBe(200);
    expect(await json<EventRow>(retry)).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    await run(ORG_A, due());
    expect(fake.sent).toHaveLength(2);
    expect((await json<Settings>(await call('GET', '/meta/settings', T.alice))).last_error).toBeNull(); // un envío correcto limpia el aviso
  });

  it('un fallo pasajero se reintenta con espera; tras 5 intentos queda FALLIDO y se puede reintentar desde el panel', async () => {
    await save(T.alice, good());
    const p = await purchase(ORG_A);
    await admin.query(`UPDATE meta_events SET send_after = $1`, [NOW]);
    let t = due();
    for (let i = 0; i < 5; i++) {
      fake.failNext(new CapiSendError('Meta no pudo atender el envío ahora', true));
      await run(ORG_A, t);
      t = new Date(t.getTime() + 2 * 60 * 60_000);
    }
    expect(await status(p.eventId)).toBe('failed');
    const row = (await events(T.alice, '?status=failed')).items[0]!;
    expect(row).toMatchObject({ attempts: 5, can_retry: true, last_error: 'Meta no pudo atender el envío ahora' });
    expect((await call('POST', `/meta/events/${row.id}/retry`, T.alice)).status).toBe(200);
    await run(ORG_A, t);
    expect(await status(p.eventId)).toBe('sent');
  });
});

describe('panel de eventos', () => {
  it('lista con filtros por estado y tipo, con el nombre del contacto, de más reciente a más antiguo y por cursor', async () => {
    const made = [] as string[];
    for (let i = 0; i < 3; i++) {
      made.push((await purchase(ORG_A, { now: new Date(NOW.getTime() + i * 1000) })).eventId);
      await new Promise((r) => setTimeout(r, 5));
    }
    const all = await events(T.alice);
    expect(all.items.map((e) => e.event_id)).toEqual([...made].reverse());
    expect(all.items[0]!.contact?.name).toMatch(/^Cliente/);
    const p1 = await events(T.alice, '?limit=2');
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await events(T.alice, `?limit=2&cursor=${p1.next_cursor}`);
    expect(p2.items.map((e) => e.event_id)).toEqual([made[0]]);
    expect(p2.next_cursor).toBeNull();
    expect((await events(T.alice, '?status=sent')).items).toEqual([]);
    expect((await events(T.alice, '?type=Purchase')).items).toHaveLength(3);
    expect((await events(T.alice, '?type=Lead')).items).toEqual([]);
    expect((await call('GET', '/meta/events?status=otro', T.alice)).status).toBe(400);
    expect((await call('GET', '/meta/events?cursor=basura', T.alice)).status).toBe(400);
  });

  it('solo se reintentan los fallidos o bloqueados con menos de 7 días; los enviados, pendientes o vencidos no', async () => {
    const sent = await purchase(ORG_A);
    const failed = await purchase(ORG_A);
    const old = await purchase(ORG_A);
    await admin.query(`UPDATE meta_events SET status = 'sent' WHERE event_id = $1`, [sent.eventId]);
    await admin.query(`UPDATE meta_events SET status = 'failed', attempts = 5, last_error = 'x' WHERE event_id = $1`, [failed.eventId]);
    await admin.query(`UPDATE meta_events SET status = 'failed', created_at = now() - interval '8 days' WHERE event_id = $1`, [old.eventId]);
    const byId = async (eventId: string) => (await events(T.alice)).items.find((e) => e.event_id === eventId)!;
    expect((await byId(sent.eventId)).can_retry).toBe(false);
    expect((await byId(old.eventId)).can_retry).toBe(false);
    expect(await code(await call('POST', `/meta/events/${(await byId(sent.eventId)).id}/retry`, T.alice))).toBe('EVENT_NOT_RETRYABLE');
    expect(await code(await call('POST', `/meta/events/${(await byId(old.eventId)).id}/retry`, T.alice))).toBe('EVENT_TOO_OLD');
    expect((await call('POST', `/meta/events/${(await byId(failed.eventId)).id}/retry`, T.alice)).status).toBe(200);
    expect((await call('POST', `/meta/events/${randomUUID()}/retry`, T.alice)).status).toBe(404);
  });
});

describe('ventana de gracia del Purchase', () => {
  it('el Purchase espera lo que la empresa configuró (0 = al instante, máximo 24 h); sin configurar, 30 minutos; cada empresa la suya', async () => {
    const wait = async (org: string): Promise<number> => {
      const p = await purchase(org);
      return ((await admin.query(`SELECT send_after FROM meta_events WHERE event_id = $1`, [p.eventId])).rows[0].send_after as Date).getTime() - NOW.getTime();
    };
    expect(await wait(ORG_A)).toBe(DEFAULT_GRACE_MINUTES * 60_000);
    await save(T.alice, good({ grace_minutes: 120 }));
    expect(await wait(ORG_A)).toBe(120 * 60_000);
    await save(T.alice, good({ grace_minutes: 0 }));
    expect(await wait(ORG_A)).toBe(0);
    await save(T.alice, good({ grace_minutes: 1440 }));
    expect(await wait(ORG_A)).toBe(1440 * 60_000);
    expect(await wait(ORG_B)).toBe(DEFAULT_GRACE_MINUTES * 60_000); // B no configuró nada
  });
});
