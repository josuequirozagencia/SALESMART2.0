// M7.1 — Conexión de cada empresa con GoHighLevel (ADR-52/ADR-05). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/ghl/connection
//   PUT /v1/ghl/connection
//   POST /v1/ghl/connection/test
//   POST /v1/ghl/connection/disconnect
//   POST /v1/ghl/webhook/secret
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
import { FakeGhlProvider, GhlError, GhlModule } from '../../src/modules/ghl';
import { GhlRoutesService, OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

const fake = new FakeGhlProvider();

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, GhlModule.register({ provider: fake }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
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
const TOKEN_A = 'pit-aaaaaaaa-1111-4222-8333-alicia0123456789';
const TOKEN_B = 'pit-bbbbbbbb-1111-4222-8333-beto0123456789ab';
const LOC_A = 've9EPM428h8vShlRW1KT';
const LOC_B = 'Zk3Rm91QpWxYtLuNc7Aa';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ghl_connections, ghl_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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

interface View {
  configured: boolean; available: boolean; auth_type: string; status: string | null; location_id: string | null; token_last4: string | null; last_error: string | null; last_check_at: string | null;
  webhook: { configured: boolean; id: string | null; path: string | null; created_at: string | null; rotated_at: string | null; last_used_at: string | null };
}
const view = (token: string) => call('GET', '/ghl/connection', token).then((r) => json<View>(r));
const save = (token: string, body: Record<string, unknown>) => call('PUT', '/ghl/connection', token, body);
const connect = async (token: string, loc = LOC_A, tok = TOKEN_A): Promise<View> => {
  const r = await save(token, { location_id: loc, access_token: tok });
  expect(r.status).toBe(200);
  return json<View>(r);
};
const row = async (org: string) => (await admin.query(`SELECT * FROM ghl_connections WHERE organization_id = $1`, [org])).rows[0] as Record<string, unknown> | undefined;

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
  fake.verified.length = 0;
});

describe('conexión con GoHighLevel · permisos y aislamiento', () => {
  it('sin sesión 401; un asesor no ve ni cambia nada (403); solo el administrador', async () => {
    for (const [m, p, b] of [['GET', '/ghl/connection'], ['PUT', '/ghl/connection', { location_id: LOC_A, access_token: TOKEN_A }], ['POST', '/ghl/connection/test'], ['POST', '/ghl/connection/disconnect'], ['POST', '/ghl/webhook/secret']] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesora`).toBe(403);
    }
    expect((await call('GET', '/ghl/connection', T.alice)).status).toBe(200);
    expect(fake.verified).toHaveLength(0); // lo rechazado no llegó a hablar con GHL
  });

  it('cada empresa ve solo lo suyo: A y B guardan su propia Location y su propio token, y no se enteran una de la otra', async () => {
    await connect(T.alice, LOC_A, TOKEN_A);
    await connect(T.bob, LOC_B, TOKEN_B);
    const a = await view(T.alice);
    const b = await view(T.bob);
    expect(a).toMatchObject({ location_id: LOC_A, token_last4: TOKEN_A.slice(-4) });
    expect(b).toMatchObject({ location_id: LOC_B, token_last4: TOKEN_B.slice(-4) });
    expect(JSON.stringify(a)).not.toContain(LOC_B);
    expect(JSON.stringify(b)).not.toContain(LOC_A);
    await call('POST', '/ghl/connection/disconnect', T.alice);
    expect((await view(T.bob)).status).toBe('active'); // desconectar A no toca a B
    expect((await view(T.alice)).status).toBe('disconnected');
  });
});

describe('conectar', () => {
  it('sin conexión: configured=false, available=true y sin webhook', async () => {
    expect(await view(T.alice)).toMatchObject({ configured: false, available: true, status: null, location_id: null, token_last4: null, auth_type: 'private_token', webhook: { configured: false, id: null, path: null } });
  });

  it('la primera vez exige el token; con él, GHL lo comprueba ANTES de guardarlo y queda activa con solo los últimos 4', async () => {
    const r = await save(T.alice, { location_id: LOC_A });
    expect(r.status).toBe(400);
    expect(await row(ORG_A)).toBeUndefined();
    const v = await connect(T.alice);
    expect(fake.verified).toEqual([{ locationId: LOC_A, accessToken: TOKEN_A }]);
    expect(v).toMatchObject({ configured: true, status: 'active', location_id: LOC_A, token_last4: TOKEN_A.slice(-4), last_error: null });
    expect(v.last_check_at).toBeTruthy();
  });

  it('el token jamás se devuelve, ni se guarda en claro, ni va a la auditoría', async () => {
    const created = await save(T.alice, { location_id: LOC_A, access_token: TOKEN_A }).then((r) => r.text());
    expect(created).not.toContain(TOKEN_A);
    expect(JSON.stringify(await view(T.alice))).not.toContain(TOKEN_A);
    const r = (await row(ORG_A))!;
    expect(String(r['credentials_sealed'])).not.toContain(TOKEN_A);
    expect(String(r['credentials_sealed']).length).toBeGreaterThan(40);
    const audit = JSON.stringify((await admin.query(`SELECT * FROM audit_logs`)).rows);
    expect(audit).not.toContain(TOKEN_A);
    expect(audit).toContain('ghl_connection');
    // un cambio posterior tampoco lo filtra
    await save(T.alice, { location_id: 'Otra1234Location5678', access_token: TOKEN_B });
    expect(JSON.stringify((await admin.query(`SELECT * FROM audit_logs`)).rows)).not.toContain(TOKEN_B);
  });

  it('si GHL rechaza el token, no se guarda nada y se explica el motivo (sin el token)', async () => {
    fake.failNextVerify(new GhlError(`GoHighLevel rechazó el token o no encuentra la Location: Invalid JWT`, false, true));
    const r = await save(T.alice, { location_id: LOC_A, access_token: TOKEN_A });
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toContain('rechazó');
    expect(body).not.toContain(TOKEN_A);
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('si GHL no responde ahora, 503 y no se guarda nada', async () => {
    fake.failNextVerify(new GhlError('No se pudo contactar a GoHighLevel', true));
    const r = await save(T.alice, { location_id: LOC_A, access_token: TOKEN_A });
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('GHL_UNREACHABLE');
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('cambiar de Location exige el token de esa Location; con la misma Location se puede guardar sin pegarlo otra vez', async () => {
    await connect(T.alice);
    fake.verified.length = 0;
    expect((await save(T.alice, { location_id: 'OtraLocation12345678' })).status).toBe(400);
    const same = await save(T.alice, { location_id: LOC_A });
    expect(same.status).toBe(200);
    expect(fake.verified).toHaveLength(0); // sin token nuevo no hay nada que comprobar
    const moved = await save(T.alice, { location_id: 'OtraLocation12345678', access_token: TOKEN_B });
    expect(moved.status).toBe(200);
    expect(await json<View>(moved)).toMatchObject({ location_id: 'OtraLocation12345678', token_last4: TOKEN_B.slice(-4) });
    const audit = (await admin.query(`SELECT old_value, new_value FROM audit_logs WHERE entity_type = 'ghl_connection' AND field = 'location_id'`)).rows;
    expect(audit).toEqual([{ old_value: LOC_A, new_value: 'OtraLocation12345678' }]);
  });

  it('valida el cuerpo: Location y token con forma, sin campos de más', async () => {
    for (const body of [{}, { location_id: 'corta', access_token: TOKEN_A }, { location_id: 'con espacio 12345', access_token: TOKEN_A }, { location_id: '../../me/12345', access_token: TOKEN_A }, { location_id: LOC_A, access_token: 'corto' }, { location_id: LOC_A, access_token: 'con espacio en el token de prueba' }, { location_id: LOC_A, access_token: TOKEN_A, status: 'active' }, { location_id: LOC_A, access_token: TOKEN_A, auth_type: 'oauth' }]) {
      expect((await save(T.alice, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await row(ORG_A)).toBeUndefined();
  });

  it('el token queda atado a SU empresa: copiado a otra no se puede abrir', async () => {
    await connect(T.alice);
    await connect(T.bob, LOC_B, TOKEN_B);
    const sealedA = (await row(ORG_A))!['credentials_sealed'];
    await admin.query(`UPDATE ghl_connections SET credentials_sealed = $1 WHERE organization_id = $2`, [sealedA, ORG_B]);
    fake.verified.length = 0;
    const r = await call('POST', '/ghl/connection/test', T.bob);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('GHL_TOKEN_UNREADABLE');
    expect(fake.verified).toHaveLength(0); // nunca se mandó a GHL un token ajeno
    expect((await view(T.bob)).status).toBe('needs_reconnect');
  });
});

describe('probar, reconectar y desconectar', () => {
  it('«Probar» vuelve a comprobar con el token guardado y deja la conexión activa', async () => {
    await connect(T.alice);
    fake.verified.length = 0;
    const r = await call('POST', '/ghl/connection/test', T.alice);
    expect(r.status).toBe(200);
    expect(await json<{ ok: boolean }>(r)).toMatchObject({ ok: true });
    expect(fake.verified).toEqual([{ locationId: LOC_A, accessToken: TOKEN_A }]);
    expect(await view(T.alice)).toMatchObject({ status: 'active', last_error: null });
  });

  it('sin conexión, «Probar» y «Desconectar» dan 404', async () => {
    expect((await call('POST', '/ghl/connection/test', T.alice)).status).toBe(404);
    expect((await call('POST', '/ghl/connection/disconnect', T.alice)).status).toBe(404);
  });

  it('si GHL rechaza el token guardado, la conexión pasa a «requiere reconexión» con el motivo; para reconectar hay que pegar un token nuevo', async () => {
    await connect(T.alice);
    fake.failNextVerify(new GhlError('GoHighLevel rechazó el token o no encuentra la Location: token revoked', false, true));
    const r = await call('POST', '/ghl/connection/test', T.alice);
    expect(r.status).toBe(400);
    const v = await view(T.alice);
    expect(v).toMatchObject({ status: 'needs_reconnect' });
    expect(v.last_error).toContain('token revoked');
    expect((await save(T.alice, { location_id: LOC_A })).status).toBe(400); // el token guardado ya no sirve
    const fixed = await json<View>(await save(T.alice, { location_id: LOC_A, access_token: TOKEN_B }));
    expect(fixed).toMatchObject({ status: 'active', last_error: null, token_last4: TOKEN_B.slice(-4) });
    const audit = (await admin.query(`SELECT old_value, new_value FROM audit_logs WHERE entity_type = 'ghl_connection' AND field = 'status' ORDER BY at`)).rows;
    expect(audit).toEqual([{ old_value: 'active', new_value: 'needs_reconnect' }, { old_value: 'needs_reconnect', new_value: 'active' }]);
  });

  it('si GHL no responde ahora, solo se anota el aviso: no es culpa del token y la conexión sigue activa', async () => {
    await connect(T.alice);
    fake.failNextVerify(new GhlError('No se pudo contactar a GoHighLevel', true));
    const r = await call('POST', '/ghl/connection/test', T.alice);
    expect(r.status).toBe(503);
    expect(await view(T.alice)).toMatchObject({ status: 'active', last_error: 'No se pudo contactar a GoHighLevel' });
    expect((await call('POST', '/ghl/connection/test', T.alice)).status).toBe(200);
    expect((await view(T.alice)).last_error).toBeNull();
  });

  it('desconectar BORRA el token, deja la Location y el estado «desconectada»; probar da 409 y reconectar exige un token', async () => {
    await connect(T.alice);
    const r = await call('POST', '/ghl/connection/disconnect', T.alice);
    expect(r.status).toBe(200);
    expect(await json<View>(r)).toMatchObject({ configured: true, status: 'disconnected', location_id: LOC_A, token_last4: null });
    expect(await row(ORG_A)).toMatchObject({ credentials_sealed: null, key_version: null, token_last4: null, status: 'disconnected' });
    expect((await call('POST', '/ghl/connection/disconnect', T.alice)).status).toBe(200); // repetir no falla
    const t = await call('POST', '/ghl/connection/test', T.alice);
    expect(t.status).toBe(409);
    expect(await code(t)).toBe('GHL_DISCONNECTED');
    expect((await save(T.alice, { location_id: LOC_A })).status).toBe(400);
    expect(await view(T.alice).then((v) => v.status)).toBe('disconnected');
    expect((await save(T.alice, { location_id: LOC_A, access_token: TOKEN_A })).status).toBe(200);
    expect((await view(T.alice)).status).toBe('active');
    const audit = (await admin.query(`SELECT old_value, new_value FROM audit_logs WHERE entity_type = 'ghl_connection' AND field = 'status' ORDER BY at`)).rows;
    expect(audit).toEqual([{ old_value: 'active', new_value: 'disconnected' }, { old_value: 'disconnected', new_value: 'active' }]);
  });
});

describe('punto de entrada del webhook de Workflow', () => {
  it('se crea con un secreto que se muestra UNA vez; después solo se ve la ruta, nunca el secreto', async () => {
    const r = await call('POST', '/ghl/webhook/secret', T.alice);
    expect(r.status).toBe(201);
    const first = await json<{ id: string; secret: string; rotated: boolean; path: string }>(r);
    expect(first.rotated).toBe(false);
    expect(first.secret).toMatch(/^ghw_[A-Za-z0-9_-]{40,}$/);
    expect(first.path).toBe(`/v1/integrations/ghl/webhook/${first.id}`);
    const v = await view(T.alice);
    expect(v.webhook).toMatchObject({ configured: true, id: first.id, path: first.path, rotated_at: null });
    expect(JSON.stringify(v)).not.toContain(first.secret);
    // en la base solo está su huella
    const db = (await admin.query(`SELECT secret_hash FROM ghl_routes`)).rows[0] as { secret_hash: string };
    expect(db.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.secret_hash).not.toContain(first.secret);
    expect(JSON.stringify((await admin.query(`SELECT * FROM audit_logs`)).rows)).not.toContain(first.secret);
  });

  it('rotar conserva la ruta y el secreto anterior deja de servir; un id desconocido o un secreto equivocado no se distinguen (null)', async () => {
    const first = await json<{ id: string; secret: string }>(await call('POST', '/ghl/webhook/secret', T.alice));
    const second = await json<{ id: string; secret: string; rotated: boolean }>(await call('POST', '/ghl/webhook/secret', T.alice));
    expect(second).toMatchObject({ id: first.id, rotated: true });
    expect(second.secret).not.toBe(first.secret);
    const routes = app.get(GhlRoutesService);
    expect(await routes.resolve(first.id, second.secret)).toBe(ORG_A);
    expect(await routes.resolve(first.id, first.secret)).toBeNull();
    expect(await routes.resolve(first.id, 'ghw_otra')).toBeNull();
    expect(await routes.resolve('11111111-2222-4333-8444-555555555555', second.secret)).toBeNull();
    expect((await admin.query(`SELECT count(*)::int AS n FROM ghl_routes`)).rows[0].n).toBe(1);
    const audit = (await admin.query(`SELECT field FROM audit_logs WHERE entity_type = 'ghl_webhook' ORDER BY at`)).rows.map((r) => r.field);
    expect(audit).toEqual(['created', 'secret_rotated']);
  });

  it('cada empresa tiene su ruta: el secreto de A no abre la ruta de B', async () => {
    const a = await json<{ id: string; secret: string }>(await call('POST', '/ghl/webhook/secret', T.alice));
    const b = await json<{ id: string; secret: string }>(await call('POST', '/ghl/webhook/secret', T.bob));
    expect(a.id).not.toBe(b.id);
    const routes = app.get(GhlRoutesService);
    expect(await routes.resolve(a.id, a.secret)).toBe(ORG_A);
    expect(await routes.resolve(b.id, b.secret)).toBe(ORG_B);
    expect(await routes.resolve(b.id, a.secret)).toBeNull();
    expect(await routes.resolve(a.id, b.secret)).toBeNull();
    expect((await view(T.alice)).webhook.id).toBe(a.id);
    expect((await view(T.bob)).webhook.id).toBe(b.id);
    // la empresa sale del contexto, no de un parámetro
    const st = await TenantContext.run({ organizationId: ORG_B, userId: IDS.bob }, () => routes.status());
    expect(st.id).toBe(b.id);
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

  it('ghl_connections es de negocio (solo app_rw, sin DELETE ni TRUNCATE) y ghl_routes es de identidad (solo app_identity, sin DELETE)', async () => {
    await expect(as(info.rwUrl, 'DELETE FROM ghl_connections')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'TRUNCATE ghl_connections')).rejects.toThrow(/permission denied/);
    for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, 'SELECT 1 FROM ghl_connections')).rejects.toThrow(/permission denied/);
    for (const url of [info.rwUrl, info.platformUrl]) await expect(as(url, 'SELECT 1 FROM ghl_routes')).rejects.toThrow(/permission denied/);
    await expect(as(info.identityUrl, 'SELECT 1 FROM ghl_routes')).resolves.toBeDefined();
    await expect(as(info.identityUrl, 'DELETE FROM ghl_routes')).rejects.toThrow(/permission denied/);
  });

  it('las restricciones impiden estados incoherentes: conectada sin token, desconectada con token, Location o estado inválidos, dos por empresa', async () => {
    const bad = (sql: string) => admin.query(sql);
    await expect(bad(`INSERT INTO ghl_connections(id, organization_id, location_id, status) VALUES (gen_random_uuid(), '${ORG_A}', '${LOC_A}', 'active')`)).rejects.toThrow(/ghl_connections_credentials_by_status/);
    await expect(bad(`INSERT INTO ghl_connections(id, organization_id, location_id, status, credentials_sealed, key_version, token_last4) VALUES (gen_random_uuid(), '${ORG_A}', '${LOC_A}', 'disconnected', 'x', 1, 'abcd')`)).rejects.toThrow(/ghl_connections_credentials_by_status/);
    await expect(bad(`INSERT INTO ghl_connections(id, organization_id, location_id, status) VALUES (gen_random_uuid(), '${ORG_A}', 'corta', 'disconnected')`)).rejects.toThrow(/ghl_connections_location_shape/);
    await expect(bad(`INSERT INTO ghl_connections(id, organization_id, location_id, status, credentials_sealed, key_version, token_last4) VALUES (gen_random_uuid(), '${ORG_A}', '${LOC_A}', 'raro', 'x', 1, 'abcd')`)).rejects.toThrow(/ghl_connections_status_valid/);
    await bad(`INSERT INTO ghl_connections(id, organization_id, location_id, status) VALUES (gen_random_uuid(), '${ORG_A}', '${LOC_A}', 'disconnected')`);
    await expect(bad(`INSERT INTO ghl_connections(id, organization_id, location_id, status) VALUES (gen_random_uuid(), '${ORG_A}', '${LOC_A}', 'disconnected')`)).rejects.toThrow(/ghl_connections_org_uq/);
    await expect(bad(`INSERT INTO ghl_routes(id, organization_id, secret_hash) VALUES (gen_random_uuid(), '${ORG_A}', 'no-es-un-hash')`)).rejects.toThrow(/ghl_routes_secret_hash_hex/);
  });
});
