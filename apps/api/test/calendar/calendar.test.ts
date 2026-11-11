// v11 Pista G · 67a — Conexión de cada empresa con Google Calendar (ADR-67). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/calendar/connection
//   POST /v1/calendar/connection/start
//   GET /v1/calendar/calendars
//   PUT /v1/calendar/connection/calendar
//   POST /v1/calendar/connection/disconnect
//   GET /v1/integrations/google-calendar/callback  (pública: valida el `state` firmado antes de hacer nada)
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
import { CalendarError, CalendarModule, FakeCalendarProvider, SCOPE_APP_CALENDAR, SCOPE_EMAIL } from '../../src/modules/calendar';
import { deriveKey, newNonce, signState } from '../../src/modules/calendar/oauth-state';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

const fake = new FakeCalendarProvider();

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, CalendarModule.register({ provider: fake }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  root: 'd0000000-0000-4000-8000-0000000000d0', // super_admin
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const FRONT = 'https://app.ejemplo.test';
const CALLBACK = `${FRONT}/v1/integrations/google-calendar/callback`;
const RETURN = `${FRONT}/settings/calendar`;
const CLIENT_ID = 'cliente-de-prueba.example.test';
const CLIENT_SECRET = 'secreto-de-cliente-de-prueba-0001';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE calendar_connections, provider_credentials, provider_selection, platform_audit, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', 'Raíz']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
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

interface View {
  configured: boolean; available: boolean; unavailable_reason: string | null; status: string | null; mode: string | null; calendar_name: string | null; account: string | null; scopes: string[]; last_error: string | null; connected_at: string | null;
}
const view = (token: string) => call('GET', '/calendar/connection', token).then((r) => json<View>(r));
const row = async (org: string) => (await admin.query(`SELECT * FROM calendar_connections WHERE organization_id = $1`, [org])).rows[0] as Record<string, unknown> | undefined;

/** La plataforma carga la aplicación de Google y la pone en uso (por la API, como lo haría el Súper Admin). */
async function configurePlatform(): Promise<void> {
  expect((await call('PUT', '/platform/providers/calendar/google/credentials', T.root, { values: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } })).status).toBe(200);
  expect((await call('PUT', '/platform/providers/calendar/active', T.root, { provider: 'google' })).status).toBe(200);
}

/** Empieza la conexión y devuelve el `state` y la dirección de Google que armó el servidor. */
async function start(token: string, mode: 'own' | 'existing'): Promise<{ url: URL; state: string }> {
  const r = await call('POST', '/calendar/connection/start', token, { mode });
  expect(r.status).toBe(200);
  const url = new URL((await json<{ url: string }>(r)).url);
  return { url, state: url.searchParams.get('state')! };
}

/** Lo que haría el navegador cuando Google devuelve a la persona. Devuelve a dónde la manda el servidor. */
async function back(q: Record<string, string>): Promise<{ status: number; location: string; cache: string | null; referrer: string | null }> {
  const r = await fetch(`${base}/integrations/google-calendar/callback?${new URLSearchParams(q).toString()}`, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location') ?? '', cache: r.headers.get('cache-control'), referrer: r.headers.get('referrer-policy') };
}
const connectOwn = async (token: string) => {
  const { state } = await start(token, 'own');
  const r = await back({ code: 'good', state });
  expect(r.location).toBe(`${RETURN}?calendar=connected`);
};
const connectExisting = async (token: string) => {
  const { state } = await start(token, 'existing');
  const r = await back({ code: 'good', state });
  expect(r.location).toBe(`${RETURN}?calendar=pick`);
};

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: FRONT, MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
  fake.calls.length = 0;
  fake.grantedScopes = null;
  fake.withoutRefreshToken = false;
  fake.liveRefreshTokens.clear();
  fake.email = 'ana.perez@example.com';
  fake.calendars = [
    { id: 'primary-cal', name: 'ana.perez@example.com', primary: true, writable: true },
    { id: 'ventas-cal', name: 'Ventas', primary: false, writable: true },
  ];
});

describe('Google Calendar · permisos y disponibilidad', () => {
  it('sin sesión 401; un asesor no ve ni cambia nada (403); solo quien administra integraciones', async () => {
    for (const [m, p, b] of [['GET', '/calendar/connection'], ['POST', '/calendar/connection/start', { mode: 'own' }], ['GET', '/calendar/calendars'], ['PUT', '/calendar/connection/calendar', { calendar_id: 'x' }], ['POST', '/calendar/connection/disconnect']] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesora`).toBe(403);
    }
    expect((await call('GET', '/calendar/connection', T.alice)).status).toBe(200);
    expect(fake.calls).toHaveLength(0); // lo rechazado no llegó a hablar con Google
  });

  it('sin la aplicación de Google de la plataforma no se puede conectar: lo dice, con 503, y no habla con Google', async () => {
    const v = await view(T.alice);
    expect(v).toMatchObject({ configured: false, available: false, unavailable_reason: 'platform_credentials', status: null });
    const r = await call('POST', '/calendar/connection/start', T.alice, { mode: 'own' });
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('CALENDAR_UNAVAILABLE');
    expect(fake.calls).toHaveLength(0);
  });

  it('con la aplicación cargada y en uso queda disponible; el secreto de cliente jamás sale en ninguna respuesta', async () => {
    await configurePlatform();
    const v = await view(T.alice);
    expect(v).toMatchObject({ available: true, unavailable_reason: null });
    const list = await (await call('GET', '/platform/providers', T.root)).text();
    expect(list).not.toContain(CLIENT_SECRET);
    expect(list).toContain('https://app.ejemplo.test/v1/integrations/google-calendar/callback'); // la dirección a registrar en Google Cloud
    expect(JSON.stringify(v)).not.toContain(CLIENT_SECRET);
  });
});

describe('Google Calendar · empezar la conexión', () => {
  it('modo propio: pide SOLO permisos no sensibles, con PKCE S256, acceso sin conexión y la dirección de retorno exacta', async () => {
    await configurePlatform();
    const { url, state } = await start(T.alice, 'own');
    expect(url.origin + url.pathname).toBe('https://fake-google.test/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([SCOPE_APP_CALENDAR, SCOPE_EMAIL].sort());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(state.length).toBeGreaterThan(40);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it('modo «elegir uno existente»: pide además el permiso de eventos y la lista de calendarios', async () => {
    await configurePlatform();
    const { url } = await start(T.alice, 'existing');
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
    expect(scopes).not.toContain(SCOPE_APP_CALENDAR);
  });

  it('el modo se valida (400) y el cuerpo no admite campos de más', async () => {
    await configurePlatform();
    expect((await call('POST', '/calendar/connection/start', T.alice, { mode: 'todo' })).status).toBe(400);
    expect((await call('POST', '/calendar/connection/start', T.alice, { mode: 'own', organization_id: ORG_B })).status).toBe(400);
  });
});

describe('Google Calendar · el regreso de Google (público)', () => {
  it('modo propio: crea el calendario de Sales Smart, guarda el permiso CIFRADO y muestra solo el correo enmascarado', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    const r = await back({ code: 'good', state, scope: 'ignorado', authuser: '0' });
    expect(r.status).toBe(302);
    expect(r.location).toBe(`${RETURN}?calendar=connected`);
    expect(r.cache).toBe('no-store');
    expect(r.referrer).toBe('no-referrer');
    const created = fake.calls.find((c) => c.kind === 'createCalendar');
    expect(created).toMatchObject({ name: 'Sales Smart · Barbería Norte', timeZone: 'America/Guayaquil' });
    const v = await view(T.alice);
    expect(v).toMatchObject({ configured: true, status: 'connected', mode: 'own', calendar_name: 'Sales Smart · Barbería Norte', account: 'a***@example.com', last_error: null });
    expect(v.scopes.sort()).toEqual([SCOPE_APP_CALENDAR, SCOPE_EMAIL].sort());
    expect(v.connected_at).not.toBeNull();
    const db = (await row(ORG_A))!;
    expect(db['status']).toBe('connected');
    expect(String(db['credentials_sealed'])).not.toContain('refresh-token');
    expect(String(db['credentials_sealed']).split(':').length).toBe(8); // sobre de la bóveda (prefijo, versión y partes cifradas)
    expect(JSON.stringify(v)).not.toMatch(/refresh-token|access-token|credentials_sealed|ana\.perez/);
    // la auditoría deja constancia sin ningún token
    const audit = (await admin.query(`SELECT * FROM audit_logs WHERE organization_id = $1 AND entity_type = 'calendar_connection'`, [ORG_A])).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toMatch(/refresh-token|access-token/);
  });

  it('un `state` manipulado, vencido, de otra forma o ausente se rechaza sin tocar nada ni hablar con Google', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    const flipped = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');
    const stateKey = deriveKey(KEY, 'gcal-oauth-state/v1');
    const expired = signState(stateKey, { o: ORG_A, u: IDS.alice, m: 'own', n: newNonce(), e: Date.now() - 1000 });
    const foreignKey = signState(deriveKey(randomBytes(32).toString('base64'), 'gcal-oauth-state/v1'), { o: ORG_A, u: IDS.alice, m: 'own', n: newNonce(), e: Date.now() + 60_000 });
    const notUuid = signState(stateKey, { o: 'no-es-uuid', u: IDS.alice, m: 'own', n: newNonce(), e: Date.now() + 60_000 });
    fake.calls.length = 0;
    for (const bad of [flipped, expired, foreignKey, notUuid, 'basura', '', 'a.b.c']) {
      const r = await back(bad === '' ? { code: 'good' } : { code: 'good', state: bad });
      expect(r.location, `state «${bad.slice(0, 12)}»`).toBe(`${RETURN}?calendar=invalid`);
    }
    expect(fake.calls).toHaveLength(0);
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('si la persona cancela o rechaza en Google, no se guarda nada', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    expect((await back({ error: 'access_denied', state })).location).toBe(`${RETURN}?calendar=denied`);
    expect(await row(ORG_A)).toBeUndefined();
    expect(fake.calls.filter((c) => c.kind !== 'authorizeUrl')).toHaveLength(0);
  });

  it('si desmarcó algún permiso en la pantalla de Google, no queda una autorización a medias: se revoca y no se guarda', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    fake.grantedScopes = [SCOPE_EMAIL]; // quitó el de calendario
    expect((await back({ code: 'good', state })).location).toBe(`${RETURN}?calendar=scopes`);
    expect(fake.calls.some((c) => c.kind === 'revoke')).toBe(true);
    expect(fake.calls.some((c) => c.kind === 'createCalendar')).toBe(false);
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('un código inválido o sin permiso permanente (refresh token) no guarda nada', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    expect((await back({ code: 'malo', state })).location).toBe(`${RETURN}?calendar=denied`);
    fake.withoutRefreshToken = true;
    expect((await back({ code: 'good', state })).location).toBe(`${RETURN}?calendar=denied`);
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('si Google no responde, vuelve con «error» (sin detalles) y no deja nada a medias', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    fake.failNext(new CalendarError('Google no respondió', true));
    expect((await back({ code: 'good', state })).location).toBe(`${RETURN}?calendar=error`);
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('si la API de Google Calendar no está habilitada en el proyecto: avisa con su propio resultado (`api`), revoca y no guarda nada', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    fake.failNext(new CalendarError('La API de Google Calendar no está habilitada en el proyecto de Google Cloud', false, false, 'api_disabled'), 'createCalendar');
    expect((await back({ code: 'good', state })).location).toBe(`${RETURN}?calendar=api`);
    expect(fake.calls.some((c) => c.kind === 'revoke')).toBe(true);
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('un permiso que falta al crear el calendario sigue siendo «scopes»; otro fallo de Google, «error»', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    fake.failNext(new CalendarError('Falta un permiso', false, true), 'createCalendar');
    expect((await back({ code: 'good', state })).location).toBe(`${RETURN}?calendar=scopes`);
    fake.failNext(new CalendarError('Google rechazó la solicitud', false), 'createCalendar');
    expect((await back({ code: 'good', state })).location).toBe(`${RETURN}?calendar=error`);
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('el `state` ata la conexión a SU empresa: el de A guarda en A y no aparece en B', async () => {
    await configurePlatform();
    const { state } = await start(T.alice, 'own');
    await back({ code: 'good', state });
    expect(await row(ORG_A)).toBeDefined();
    expect(await row(ORG_B)).toBeUndefined();
    expect((await view(T.bob)).configured).toBe(false);
  });

  it('reconectar reemplaza la autorización y revoca la anterior en Google', async () => {
    await configurePlatform();
    await connectOwn(T.alice);
    const first = [...fake.liveRefreshTokens][0]!;
    fake.calls.length = 0;
    await connectOwn(T.alice);
    expect(fake.calls.some((c) => c.kind === 'revoke' && c.token === first)).toBe(true);
    expect(fake.liveRefreshTokens.has(first)).toBe(false);
    expect((await admin.query(`SELECT count(*)::int n FROM calendar_connections WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
  });
});

describe('Google Calendar · elegir un calendario existente', () => {
  it('queda «pendiente de elegir»; la lista trae solo donde se puede escribir; elegir conecta', async () => {
    await configurePlatform();
    fake.calendars.push({ id: 'solo-lectura', name: 'Feriados', primary: false, writable: false });
    await connectExisting(T.alice);
    expect(await view(T.alice)).toMatchObject({ configured: true, status: 'pending_calendar', mode: 'existing', calendar_name: null });
    expect(fake.calls.some((c) => c.kind === 'createCalendar')).toBe(false); // en este modo no se crea nada
    const list = await json<{ items: Array<{ id: string; name: string; primary: boolean }> }>(await call('GET', '/calendar/calendars', T.alice));
    expect(list.items.map((c) => c.id).sort()).toEqual(['primary-cal', 'ventas-cal']);
    const chosen = await call('PUT', '/calendar/connection/calendar', T.alice, { calendar_id: 'ventas-cal' });
    expect(chosen.status).toBe(200);
    expect(await json<View>(chosen)).toMatchObject({ status: 'connected', calendar_name: 'Ventas' });
    expect((await row(ORG_A))!['calendar_id']).toBe('ventas-cal');
  });

  it('el servidor comprueba el calendario contra Google: uno inexistente o de solo lectura se rechaza (400)', async () => {
    await configurePlatform();
    fake.calendars.push({ id: 'solo-lectura', name: 'Feriados', primary: false, writable: false });
    await connectExisting(T.alice);
    for (const id of ['no-existe', 'solo-lectura']) expect((await call('PUT', '/calendar/connection/calendar', T.alice, { calendar_id: id })).status, id).toBe(400);
    expect((await view(T.alice)).status).toBe('pending_calendar');
  });

  it('listar o elegir en modo propio, o sin conexión, da 404', async () => {
    await configurePlatform();
    expect((await call('GET', '/calendar/calendars', T.alice)).status).toBe(404);
    await connectOwn(T.alice);
    expect((await call('GET', '/calendar/calendars', T.alice)).status).toBe(404);
    expect((await call('PUT', '/calendar/connection/calendar', T.alice, { calendar_id: 'primary-cal' })).status).toBe(404);
  });

  it('si Google ya no acepta el permiso: 409 «requiere reconectar», la conexión lo muestra y reconectar la arregla', async () => {
    await configurePlatform();
    await connectExisting(T.alice);
    fake.liveRefreshTokens.clear(); // el usuario revocó el acceso desde su cuenta de Google
    const r = await call('GET', '/calendar/calendars', T.alice);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('CALENDAR_NEEDS_RECONNECT');
    expect(await view(T.alice)).toMatchObject({ status: 'needs_reconnect' });
    expect((await view(T.alice)).last_error).toBeTruthy();
    await connectExisting(T.alice);
    expect((await view(T.alice)).status).toBe('pending_calendar');
    expect((await call('GET', '/calendar/calendars', T.alice)).status).toBe(200);
  });
});

describe('Google Calendar · desconectar y aislamiento A↔B', () => {
  it('desconectar revoca el permiso en Google, BORRA el token cifrado y deja la conexión limpia', async () => {
    await configurePlatform();
    await connectOwn(T.alice);
    const token = [...fake.liveRefreshTokens][0]!;
    const r = await call('POST', '/calendar/connection/disconnect', T.alice);
    expect(r.status).toBe(200);
    expect(await json<View>(r)).toMatchObject({ configured: false, status: 'disconnected', calendar_name: null, account: null, scopes: [] });
    expect(fake.calls.some((c) => c.kind === 'revoke' && c.token === token)).toBe(true);
    const db = (await row(ORG_A))!;
    expect(db['credentials_sealed']).toBeNull();
    expect(db['key_version']).toBeNull();
    expect(db['calendar_id']).toBeNull();
    expect((await call('POST', '/calendar/connection/disconnect', T.alice)).status).toBe(200); // repetir no falla
  });

  it('desconectar funciona aunque Google no responda (se borra aquí igual)', async () => {
    await configurePlatform();
    await connectOwn(T.alice);
    fake.failNext(new CalendarError('Google no respondió', true));
    expect((await call('POST', '/calendar/connection/disconnect', T.alice)).status).toBe(200);
    expect((await row(ORG_A))!['credentials_sealed']).toBeNull();
  });

  it('cada empresa ve y cambia solo lo suyo: B no ve la conexión de A, y listar, elegir o desconectar sin la propia da 404', async () => {
    await configurePlatform();
    await connectOwn(T.alice);
    expect(await view(T.bob)).toMatchObject({ configured: false, status: null, calendar_name: null, account: null });
    expect((await call('GET', '/calendar/calendars', T.bob)).status).toBe(404);
    expect((await call('PUT', '/calendar/connection/calendar', T.bob, { calendar_id: 'primary-cal' })).status).toBe(404);
    expect((await call('POST', '/calendar/connection/disconnect', T.bob)).status).toBe(404);
    expect((await view(T.alice)).status).toBe('connected'); // lo de B no tocó a A
    await connectOwn(T.bob);
    await call('POST', '/calendar/connection/disconnect', T.alice);
    expect((await view(T.bob)).status).toBe('connected'); // desconectar A no toca a B
  });

  it('el permiso cifrado de A no sirve en la fila de B (atado a su empresa): copiarlo ahí deja a B en «requiere reconectar»', async () => {
    await configurePlatform();
    await connectOwn(T.alice);
    await connectExisting(T.bob);
    const sealedA = (await row(ORG_A))!['credentials_sealed'];
    await admin.query(`UPDATE calendar_connections SET credentials_sealed = $1 WHERE organization_id = $2`, [sealedA, ORG_B]);
    const r = await call('GET', '/calendar/calendars', T.bob);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('CALENDAR_NEEDS_RECONNECT');
    expect((await view(T.bob)).status).toBe('needs_reconnect');
  });

  it('la base rechaza un estado inválido y una conexión «conectada» sin calendario', async () => {
    await configurePlatform();
    await connectOwn(T.alice);
    await expect(admin.query(`UPDATE calendar_connections SET status = 'inventado' WHERE organization_id = $1`, [ORG_A])).rejects.toThrow(/calendar_connections_status_valid/);
    await expect(admin.query(`UPDATE calendar_connections SET status = 'connected', calendar_id = NULL WHERE organization_id = $1`, [ORG_A])).rejects.toThrow(/calendar_connections_calendar_when_connected/);
  });
});
