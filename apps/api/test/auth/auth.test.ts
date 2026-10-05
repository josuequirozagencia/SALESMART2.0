// M1.1 — sesiones, login, refresh rotativo, logout, bloqueo por intentos y resolvedor real.
import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule, PlatformOnly } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { Argon2idHasher } from '../../src/security';
import { PlatformContext, TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Controller('probe')
class ProbeController {
  @Get('me') me() { const c = TenantContext.current(); return { org: c.organizationId, user: c.userId }; }
  @PlatformOnly() @Get('platform') plat() { return { actor: PlatformContext.current().actorUserId }; }
}
@Module({ imports: [CoreModule, DbModule, AuthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [ProbeController] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // admin de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // admin de B
  root: 'f0000000-0000-4000-8000-0000000000f1', // super_admin
  pending: 'c0000000-0000-4000-8000-0000000000c1',
  disabled: 'c0000000-0000-4000-8000-0000000000c2',
  unverified: 'c0000000-0000-4000-8000-0000000000c3',
};
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Empresa A'], [ORG_B, 'client', 'Empresa B']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string, boolean]> = [
    [IDS.alice, 'alice@a.test', 'active', true], [IDS.bob, 'bob@b.test', 'active', true], [IDS.root, 'root@plat.test', 'active', true],
    [IDS.pending, 'pending@a.test', 'pending', true], [IDS.disabled, 'disabled@a.test', 'disabled', true], [IDS.unverified, 'unverified@a.test', 'active', false],
  ];
  for (const [id, email, status, verified] of users) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,$4,$5)`, [id, email, hash, status, verified ? new Date() : null]);
  }
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin'], [IDS.pending, ORG_A, 'advisor'], [IDS.disabled, ORG_A, 'advisor'], [IDS.unverified, ORG_A, 'advisor']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app); // mismo prefijo /v1 que producción
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(seed);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (path: string, token?: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
async function login(email: string, extra: Record<string, unknown> = {}) {
  const r = await post('/auth/login', { email, password: PW, token_transport: 'body', ...extra });
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as { access_token: string; refresh_token: string; expires_in: number; user: { id: string }; organization: { id: string }; role: string };
}
const scrub = (o: unknown) => JSON.stringify(o, (k, v) => (k === 'request_id' ? undefined : v));

describe('login', () => {
  it('devuelve access token, organización y rol; el refresh va en cookie HttpOnly SameSite=Strict (no en el cuerpo)', async () => {
    const r = await post('/auth/login', { email: ' Alice@A.test ', password: PW });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const cookie = r.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^ss_refresh=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b['refresh_token']).toBeUndefined();
    expect(b).toMatchObject({ token_type: 'Bearer', role: 'client_admin', organization: { id: ORG_A, kind: 'client' } });
    expect(b['expires_in']).toBeGreaterThan(800);
    expect(b['expires_in']).toBeLessThanOrEqual(900);
  });
  it('transporte por cuerpo: devuelve refresh_token y NO fija cookie', async () => {
    const r = await post('/auth/login', { email: 'alice@a.test', password: PW, token_transport: 'body' });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(((await r.json()) as { refresh_token: string }).refresh_token).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  });
  it('mismo error genérico para correo inexistente, contraseña errónea, usuario pendiente, desactivado o sin verificar', async () => {
    const attempts = [
      { email: 'nadie@x.test', password: PW }, { email: 'alice@a.test', password: 'mala' }, { email: 'pending@a.test', password: PW },
      { email: 'disabled@a.test', password: PW }, { email: 'unverified@a.test', password: PW },
    ];
    const bodies: string[] = [];
    for (const a of attempts) { const r = await post('/auth/login', a); expect(r.status).toBe(401); bodies.push(scrub(await r.json())); }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/existe|contraseña|correo/i);
  });
  it('rechaza campos desconocidos (p. ej. organization_id) y no devuelve el valor recibido', async () => {
    const r = await post('/auth/login', { email: 'alice@a.test', password: PW, organization_id: ORG_B });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain(ORG_B);
  });
  it('en BD solo existe el hash de los tokens, nunca el token', async () => {
    const t = await login('alice@a.test');
    const row = (await admin.query('SELECT * FROM sessions')).rows[0];
    const dump = JSON.stringify(row);
    for (const tok of [t.access_token, t.refresh_token]) expect(dump).not.toContain(tok.split('.')[1]);
    expect(row.access_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('bloqueo tras intentos fallidos (5) con espera creciente', () => {
  it('al 5.º fallo bloquea: incluso con la contraseña correcta responde 429 con Retry-After', async () => {
    for (let i = 0; i < 5; i++) expect((await post('/auth/login', { email: 'alice@a.test', password: 'mala' })).status).toBe(401);
    const r = await post('/auth/login', { email: 'alice@a.test', password: PW });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('TOO_MANY_ATTEMPTS');
  });
  it('un correo inexistente se bloquea igual (no revela qué cuentas existen)', async () => {
    for (let i = 0; i < 5; i++) await post('/auth/login', { email: 'fantasma@x.test', password: 'mala' });
    expect((await post('/auth/login', { email: 'fantasma@x.test', password: 'mala' })).status).toBe(429);
  });
  it('el bloqueo de una cuenta no afecta a otra', async () => {
    for (let i = 0; i < 5; i++) await post('/auth/login', { email: 'alice@a.test', password: 'mala' });
    expect((await post('/auth/login', { email: 'bob@b.test', password: PW })).status).toBe(200);
  });
  it('la espera crece: otro fallo tras expirar el primer bloqueo duplica la espera', async () => {
    for (let i = 0; i < 5; i++) await post('/auth/login', { email: 'alice@a.test', password: 'mala' });
    const k = (await admin.query(`SELECT key, locked_until, updated_at FROM auth_throttle WHERE key LIKE 'e:%'`)).rows[0];
    const first = k.locked_until.getTime() - k.updated_at.getTime();
    await admin.query(`UPDATE auth_throttle SET locked_until = now() - interval '1 second' WHERE key LIKE 'e:%'`); // simula el paso del tiempo
    await post('/auth/login', { email: 'alice@a.test', password: 'mala' });
    const k2 = (await admin.query(`SELECT locked_until, updated_at FROM auth_throttle WHERE key = $1`, [k.key])).rows[0];
    expect(k2.locked_until.getTime() - k2.updated_at.getTime()).toBeGreaterThanOrEqual(first * 2 - 50);
  });
  it('un login correcto reinicia el contador de la cuenta', async () => {
    for (let i = 0; i < 3; i++) await post('/auth/login', { email: 'alice@a.test', password: 'mala' });
    await login('alice@a.test');
    expect((await admin.query(`SELECT failures FROM auth_throttle WHERE key LIKE 'e:%'`)).rows[0].failures).toBe(0);
  });
  it('las claves de limitación no contienen el correo ni la IP en claro', async () => {
    await post('/auth/login', { email: 'alice@a.test', password: 'mala' });
    for (const r of (await admin.query('SELECT key FROM auth_throttle')).rows) { expect(r.key).not.toContain('alice'); expect(r.key).not.toContain('127.0.0.1'); }
  });
});

describe('resolvedor de acceso real (organización y rol salen de la sesión, no de la petición)', () => {
  it('sin token o con token inválido → 401 genérico', async () => {
    expect((await get('/probe/me')).status).toBe(401);
    expect((await get('/probe/me', 'basura')).status).toBe(401);
    expect((await get('/probe/me', `${IDS.alice}.${'A'.repeat(43)}`)).status).toBe(401);
  });
  it('A↔B: el principal es SIEMPRE la organización de la sesión aunque la petición pida otra', async () => {
    const a = await login('alice@a.test');
    const r = await get(`/probe/me?organization_id=${ORG_B}`, a.access_token, { 'x-organization-id': ORG_B, 'x-test-principal': `tenant:${ORG_B}:${IDS.bob}` });
    expect(await r.json()).toEqual({ org: ORG_A, user: IDS.alice });
    const b = await login('bob@b.test');
    expect(await (await get('/probe/me', b.access_token)).json()).toEqual({ org: ORG_B, user: IDS.bob });
  });
  it('el token de A no sirve con el id de sesión de B (ni al revés)', async () => {
    const a = await login('alice@a.test');
    const b = await login('bob@b.test');
    const forged = `${b.access_token.split('.')[0]}.${a.access_token.split('.')[1]}`;
    expect((await get('/probe/me', forged)).status).toBe(401);
  });
  it('super_admin: entra a rutas de plataforma, no a rutas de tenant; un cliente no entra a plataforma', async () => {
    const root = await login('root@plat.test');
    expect((await get('/probe/platform', root.access_token)).status).toBe(200);
    const r = await get('/probe/me', root.access_token);
    expect(r.status).toBe(403);
    const a = await login('alice@a.test');
    expect((await get('/probe/platform', a.access_token)).status).toBe(403);
  });
  it.each([
    ['membresía revocada', `UPDATE organization_members SET revoked_at = now() WHERE user_id = '${IDS.alice}'`],
    ['usuario desactivado', `UPDATE users SET status = 'disabled' WHERE id = '${IDS.alice}'`],
    ['usuario eliminado', `UPDATE users SET deleted_at = now() WHERE id = '${IDS.alice}'`],
    ['versión de sesión incrementada (cambio de contraseña)', `UPDATE users SET session_version = session_version + 1 WHERE id = '${IDS.alice}'`],
    ['organización suspendida', `UPDATE organizations SET status = 'suspended' WHERE id = '${ORG_A}'`],
    ['sesión revocada', `UPDATE sessions SET revoked_at = now(), revoke_reason = 'admin'`],
    ['access token vencido', `UPDATE sessions SET access_expires_at = now() - interval '1 second'`],
    ['sesión absoluta vencida', `UPDATE sessions SET absolute_expires_at = now() - interval '1 second'`],
  ])('efecto inmediato: %s → 401 en la siguiente petición', async (_n, sqlText) => {
    const a = await login('alice@a.test');
    expect((await get('/probe/me', a.access_token)).status).toBe(200);
    await admin.query(sqlText);
    expect((await get('/probe/me', a.access_token)).status).toBe(401);
  });
});

describe('refresh rotativo con detección de reutilización', () => {
  it('rota ambos tokens; el refresh anterior deja de valer y su reutilización REVOCA la sesión', async () => {
    const t = await login('alice@a.test');
    const r1 = await post('/auth/refresh', { refresh_token: t.refresh_token });
    expect(r1.status).toBe(200);
    const n = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(n.access_token).not.toBe(t.access_token);
    expect((await get('/probe/me', t.access_token)).status).toBe(401); // el access viejo ya no sirve
    expect((await get('/probe/me', n.access_token)).status).toBe(200);
    // reutilización del refresh viejo (robo) → 401 y la sesión completa queda revocada
    expect((await post('/auth/refresh', { refresh_token: t.refresh_token })).status).toBe(401);
    expect((await get('/probe/me', n.access_token)).status).toBe(401);
    expect((await post('/auth/refresh', { refresh_token: n.refresh_token })).status).toBe(401);
    expect((await admin.query('SELECT revoke_reason FROM sessions')).rows[0].revoke_reason).toBe('refresh_reuse');
  });
  it('DOS refrescos concurrentes con el mismo token: exactamente uno es válido, el otro es reutilización y REVOCA la sesión (sin ventana de gracia)', async () => {
    const t = await login('alice@a.test');
    const rs = await Promise.all([post('/auth/refresh', { refresh_token: t.refresh_token }), post('/auth/refresh', { refresh_token: t.refresh_token })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
    const winner = (await rs.find((r) => r.status === 200)!.json()) as { access_token: string; refresh_token: string };
    // la reutilización detectada revocó la sesión: ni siquiera los tokens del ganador sirven
    expect((await get('/probe/me', winner.access_token)).status).toBe(401);
    expect((await post('/auth/refresh', { refresh_token: winner.refresh_token })).status).toBe(401);
    const s = (await admin.query('SELECT revoke_reason FROM sessions')).rows;
    expect(s).toHaveLength(1);
    expect(s[0].revoke_reason).toBe('refresh_reuse');
  });
  it('N=12 refrescos concurrentes: exactamente UNA rotación; el resto son reutilización', async () => {
    const t = await login('alice@a.test');
    const rs = await Promise.all(Array.from({ length: 12 }, () => post('/auth/refresh', { refresh_token: t.refresh_token })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 401)).toHaveLength(11);
  });
  it('primer refresh válido; la reutilización posterior del token ANTERIOR revoca; no hay ventana de gracia aunque sea inmediata', async () => {
    const t = await login('alice@a.test');
    const r1 = await post('/auth/refresh', { refresh_token: t.refresh_token });
    expect(r1.status).toBe(200);
    const n = (await r1.json()) as { access_token: string; refresh_token: string };
    expect((await get('/probe/me', n.access_token)).status).toBe(200);
    const again = await post('/auth/refresh', { refresh_token: t.refresh_token }); // inmediato
    expect(again.status).toBe(401);
    expect((await get('/probe/me', n.access_token)).status).toBe(401); // revocación
    expect((await admin.query('SELECT revoke_reason FROM sessions')).rows[0].revoke_reason).toBe('refresh_reuse');
  });
  it('la rotación es atómica y serializada por bloqueo de fila: un refresh espera a quien tiene la fila', async () => {
    const t = await login('alice@a.test');
    const holder = new Client({ connectionString: info.adminDbUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM sessions FOR UPDATE'); // la fila queda bloqueada
      let done = false;
      const p = post('/auth/refresh', { refresh_token: t.refresh_token }).then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 600));
      expect(done, 'el refresh no debe avanzar mientras otra transacción tiene la fila').toBe(false);
      await holder.query('COMMIT');
      expect((await p).status).toBe(200);
    } finally { await holder.end(); }
  });
  it('si la rotación falla a mitad NO queda estado parcial: el token anterior sigue siendo válido (rollback)', async () => {
    const t = await login('alice@a.test');
    await admin.query(`CREATE OR REPLACE FUNCTION pg_temp_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo simulado'; END $$`);
    await admin.query(`CREATE TRIGGER sessions_fail BEFORE UPDATE OF refresh_hash ON sessions FOR EACH ROW EXECUTE FUNCTION pg_temp_fail()`);
    try {
      const before = (await admin.query('SELECT access_hash, refresh_hash, revoked_at FROM sessions')).rows[0];
      expect((await post('/auth/refresh', { refresh_token: t.refresh_token })).status).toBe(500);
      const after = (await admin.query('SELECT access_hash, refresh_hash, revoked_at FROM sessions')).rows[0];
      expect(after).toEqual(before); // ni access ni refresh cambiaron, ni se revocó
    } finally {
      await admin.query('DROP TRIGGER sessions_fail ON sessions');
      await admin.query('DROP FUNCTION pg_temp_fail()');
    }
    expect((await post('/auth/refresh', { refresh_token: t.refresh_token })).status).toBe(200); // el cliente puede reintentar
  });
  it('por cookie exige la cabecera anti-CSRF; sin ella → 403 y no rota', async () => {
    const l = await post('/auth/login', { email: 'alice@a.test', password: PW });
    const cookie = (l.headers.get('set-cookie') ?? '').split(';')[0]!;
    const noCsrf = await post('/auth/refresh', {}, { cookie });
    expect(noCsrf.status).toBe(403);
    const ok = await post('/auth/refresh', {}, { cookie, 'x-requested-by': 'sales-smart-web' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/^ss_refresh=/);
  });
  it('un refresh vencido, o el usuario desactivado, no refresca (y revoca)', async () => {
    const t = await login('alice@a.test');
    await admin.query(`UPDATE users SET status = 'disabled' WHERE id = '${IDS.alice}'`);
    expect((await post('/auth/refresh', { refresh_token: t.refresh_token })).status).toBe(401);
    expect((await admin.query('SELECT revoke_reason FROM sessions')).rows[0].revoke_reason).toBe('invalid_state');
  });
  it('el access token no sirve como refresh', async () => {
    const t = await login('alice@a.test');
    expect((await post('/auth/refresh', { refresh_token: t.access_token })).status).toBe(401);
  });
});

describe('logout', () => {
  it('revoca la sesión (access y refresh dejan de valer), es idempotente y acepta basura sin error', async () => {
    const t = await login('alice@a.test');
    expect((await post('/auth/logout', { refresh_token: t.refresh_token })).status).toBe(204);
    expect((await get('/probe/me', t.access_token)).status).toBe(401);
    expect((await post('/auth/refresh', { refresh_token: t.refresh_token })).status).toBe(401);
    expect((await post('/auth/logout', { refresh_token: t.refresh_token })).status).toBe(204);
    expect((await post('/auth/logout', { refresh_token: 'basura' })).status).toBe(204);
  });
  it('con el access token en Authorization también cierra; el token de otra sesión no cierra la ajena', async () => {
    const a = await login('alice@a.test');
    const b = await login('bob@b.test');
    await post('/auth/logout', {}, { authorization: `Bearer ${a.access_token}` });
    expect((await get('/probe/me', a.access_token)).status).toBe(401);
    expect((await get('/probe/me', b.access_token)).status).toBe(200);
    const forged = `${b.access_token.split('.')[0]}.${a.access_token.split('.')[1]}`;
    await post('/auth/logout', { refresh_token: forged });
    expect((await get('/probe/me', b.access_token)).status).toBe(200);
  });
});

describe('privilegios y errores', () => {
  it('ningún error de auth filtra SQL, hashes ni tokens', async () => {
    const r = await post('/auth/login', { email: 'alice@a.test', password: 'mala' });
    const t = await r.text();
    expect(t).not.toMatch(/argon2|select |insert |sessions|users/i);
  });
});

describe('versionado /v1', () => {
  it('los endpoints de acceso responden bajo /v1 y no existen sin el prefijo', async () => {
    const root = base.replace(/\/v1$/, '');
    const raw = (p: string) => fetch(`${root}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@a.test', password: PW }) });
    expect((await raw('/v1/auth/login')).status).toBe(200);
    for (const ep of ['login', 'refresh', 'logout']) expect((await raw(`/auth/${ep}`)).status, ep).toBe(404);
  });
  it('la cookie de refresh solo viaja a /v1/auth', async () => {
    const r = await post('/auth/login', { email: 'alice@a.test', password: PW });
    expect(r.headers.get('set-cookie')).toMatch(/Path=\/v1\/auth/);
  });
});
