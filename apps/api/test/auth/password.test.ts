// M1.3 — olvido, restablecimiento y cambio de contraseña. Rutas cubiertas: POST /v1/auth/forgot, /v1/auth/reset y
// POST /v1/auth/password (@SelfService: solo opera sobre el propio usuario; ver pruebas «no admite ids ajenos»).
import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { FAKE_CAPTCHA_PASS, MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Controller('probe')
class ProbeController { @Get('me') me() { return { org: TenantContext.current().organizationId }; } }
@Module({ imports: [CoreModule, DbModule, AuthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [ProbeController] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const NEW = 'Nueva-Clave-2026';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', bob: 'b0000000-0000-4000-8000-00000000000b', root: 'f0000000-0000-4000-8000-0000000000f1',
  pending: 'c0000000-0000-4000-8000-0000000000c1', disabled: 'c0000000-0000-4000-8000-0000000000c2',
};
let admin: Client;
let hash = '';
const saved = { ...process.env };
interface Booted { app: INestApplication; base: string; mail: MemoryMailProvider }
async function boot(env: Record<string, string>): Promise<Booted> {
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, ...env });
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: `${await app.getUrl()}/v1`, mail: app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider };
}
const GENEROUS = { FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', SIGNUP_IP_MAX_PER_HOUR: '200', RESET_IP_MAX_PER_HOUR: '200', RESET_ATTEMPT_IP_MAX_PER_HOUR: '500', RESET_EMAIL_MAX_PER_HOUR: '3' };

const scrub = (o: unknown) => JSON.stringify(o, (k, v) => (k === 'request_id' ? undefined : v));
async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, password_resets, email_verifications, signup_attempts, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Empresa A'], [ORG_B, 'client', 'Empresa B']]) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string]> = [[IDS.alice, 'alice@a.test', 'active'], [IDS.bob, 'bob@b.test', 'active'], [IDS.root, 'root@plat.test', 'active'], [IDS.pending, 'pending@a.test', 'pending'], [IDS.disabled, 'disabled@a.test', 'disabled']];
  for (const [id, email, status] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,$4,$5)`, [id, email, hash, status, status === 'pending' ? null : new Date()]);
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin'], [IDS.pending, ORG_A, 'advisor'], [IDS.disabled, ORG_A, 'advisor']]) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}
const bypass = (email: string) => admin.query(`UPDATE password_resets SET last_sent_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]);

describe('olvido / restablecimiento / cambio de contraseña', () => {
  let b: Booted;
  const post = (path: string, body: unknown, token?: string) => fetch(`${b.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const forgot = (email: string, extra: Record<string, unknown> = {}) => post('/auth/forgot', { email, captcha_token: FAKE_CAPTCHA_PASS, ...extra });
  const login = async (email: string, password = PW) => {
    const r = await post('/auth/login', { email, password, token_transport: 'body' });
    return { status: r.status, body: (await r.json()) as { access_token: string; refresh_token: string } };
  };
  const me = (token: string) => fetch(`${b.base}/probe/me`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    hash = await new Argon2idHasher().hash(PW);
    b = await boot(GENEROUS);
  });
  afterAll(async () => { await b.app.close(); await admin.end(); process.env = saved; });
  beforeEach(async () => { await seed(); b.mail.resetOutbox.length = 0; });

  it('flujo feliz: forgot → token por correo → reset → la contraseña nueva funciona y la vieja no; las sesiones previas quedan revocadas', async () => {
    const before = await login('alice@a.test');
    expect((await me(before.body.access_token)).status).toBe(200);

    const r = await forgot(' Alice@A.test ');
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: 'reset_requested' });
    const mail = b.mail.lastReset('alice@a.test')!;
    const token = b.mail.lastResetToken('alice@a.test')!;
    expect(token).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(mail.expiresInMinutes).toBe(30);
    expect(mail.resetUrl.startsWith('https://app.ejemplo.test/reset-password#token=')).toBe(true);

    const v = await post('/auth/reset', { token, new_password: NEW });
    expect(v.status).toBe(200);
    expect(await v.json()).toEqual({ status: 'password_updated' });

    expect((await login('alice@a.test', PW)).status).toBe(401);
    expect((await login('alice@a.test', NEW)).status).toBe(200);
    expect((await me(before.body.access_token)).status).toBe(401); // sesión anterior revocada
    expect((await post('/auth/refresh', { refresh_token: before.body.refresh_token })).status).toBe(401);
    expect((await admin.query(`SELECT revoke_reason FROM sessions WHERE revoke_reason IS NOT NULL`)).rows[0].revoke_reason).toBe('password_reset');
    expect((await admin.query(`SELECT session_version FROM users WHERE email='alice@a.test'`)).rows[0].session_version).toBe(2);
  });

  it('en BD solo hay el SHA-256 del token; ni el token ni el secreto ni el correo en contadores', async () => {
    await forgot('alice@a.test');
    const mail = b.mail.lastReset('alice@a.test')!;
    const tokenSecret = b.mail.lastResetToken('alice@a.test')!.split('.')[1]!;
    const dump = JSON.stringify((await admin.query('SELECT * FROM password_resets')).rows) + JSON.stringify((await admin.query('SELECT * FROM signup_attempts')).rows);
    expect(dump).not.toContain(tokenSecret);
    expect(mail.resetUrl).toMatch(/^https:\/\/app\.ejemplo\.test\/reset-password#token=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(dump).not.toContain('alice@a.test');
    expect((await admin.query('SELECT token_hash FROM password_resets')).rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forgot UNIFORME: inexistente, pendiente, desactivada y activa responden igual; solo la activa recibe correo', async () => {
    const bodies: string[] = [];
    for (const email of ['nadie@x.test', 'pending@a.test', 'disabled@a.test', 'alice@a.test']) {
      const r = await forgot(email);
      expect(r.status).toBe(202);
      bodies.push(scrub(await r.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(b.mail.resetOutbox.map((m) => m.to)).toEqual(['alice@a.test']);
  });

  it('reset: error UNIFORME (basura, secreto erróneo, id ajeno, vencido, ya usado, usuario desactivado después)', async () => {
    await forgot('alice@a.test');
    const good = b.mail.lastResetToken('alice@a.test')!;
    const [id] = good.split('.');
    const bodies: string[] = [];
    const bad = async (token: string) => { const r = await post('/auth/reset', { token, new_password: NEW }); expect(r.status, token).toBe(400); bodies.push(scrub(await r.json())); };
    await bad('basura');
    await bad(`${id}.${'A'.repeat(43)}`);
    await bad(`${IDS.bob}.${good.split('.')[1]}`);
    await admin.query(`UPDATE password_resets SET expires_at = now() - interval '1 second'`);
    await bad(good);
    await admin.query(`UPDATE password_resets SET expires_at = now() + interval '10 minutes'`);
    await admin.query(`UPDATE users SET status='disabled' WHERE id=$1`, [IDS.alice]);
    await bad(good);
    await admin.query(`UPDATE users SET status='active' WHERE id=$1`, [IDS.alice]);
    expect((await post('/auth/reset', { token: good, new_password: NEW })).status).toBe(200);
    await bad(good); // de un solo uso
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('INVALID_TOKEN');
  });

  it('una contraseña corta se rechaza con 400 de validación SIN consumir el token', async () => {
    await forgot('alice@a.test');
    const token = b.mail.lastResetToken('alice@a.test')!;
    expect((await post('/auth/reset', { token, new_password: 'corta' })).status).toBe(400);
    expect((await admin.query('SELECT consumed_at FROM password_resets')).rows[0].consumed_at).toBeNull();
    expect((await post('/auth/reset', { token, new_password: NEW })).status).toBe(200);
  });

  it('un nuevo forgot (fuera de cooldown) invalida el token anterior; dentro del cooldown no se envía otro', async () => {
    await forgot('alice@a.test');
    const first = b.mail.lastResetToken('alice@a.test')!;
    await forgot('alice@a.test');
    expect(b.mail.resetOutbox).toHaveLength(1); // cooldown
    await bypass('alice@a.test');
    await forgot('alice@a.test');
    const second = b.mail.lastResetToken('alice@a.test')!;
    expect(second).not.toBe(first);
    expect((await post('/auth/reset', { token: first, new_password: NEW })).status).toBe(400);
    expect((await post('/auth/reset', { token: second, new_password: NEW })).status).toBe(200);
  });

  it('seis reset simultáneos con el mismo token: exactamente uno tiene éxito', async () => {
    await forgot('alice@a.test');
    const token = b.mail.lastResetToken('alice@a.test')!;
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => post('/auth/reset', { token, new_password: `${NEW}-${i}` })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400, 400]);
    expect((await admin.query(`SELECT session_version FROM users WHERE email='alice@a.test'`)).rows[0].session_version).toBe(2); // se aplicó una sola vez
  });

  it('un restablecimiento exitoso levanta el bloqueo por intentos de acceso de la cuenta', async () => {
    for (let i = 0; i < 5; i++) await login('alice@a.test', 'mala');
    expect((await login('alice@a.test', PW)).status).toBe(429);
    await forgot('alice@a.test');
    await post('/auth/reset', { token: b.mail.lastResetToken('alice@a.test')!, new_password: NEW });
    expect((await login('alice@a.test', NEW)).status).toBe(200);
  });

  it('CAPTCHA inválido → 400 y sin correo; fallo del proveedor de correo → 202', async () => {
    const r = await forgot('alice@a.test', { captcha_token: 'malo' });
    expect(r.status).toBe(400);
    expect(b.mail.resetOutbox).toHaveLength(0);
    b.mail.failNext = true;
    expect((await forgot('alice@a.test')).status).toBe(202);
    expect(b.mail.resetOutbox).toHaveLength(0);
  });

  it('el enlace usa SIEMPRE la URL configurada: un Host/Origin/X-Forwarded-Host hostil no la altera', async () => {
    const r = await fetch(`${b.base}/auth/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http', referer: 'https://evil.test/x' },
      body: JSON.stringify({ email: 'alice@a.test', captcha_token: FAKE_CAPTCHA_PASS }),
    });
    expect(r.status).toBe(202);
    const url = b.mail.lastReset('alice@a.test')!.resetUrl;
    expect(url.startsWith('https://app.ejemplo.test/reset-password#token=')).toBe(true);
    expect(url).not.toContain('evil.test');
  });

  it('límite por correo: pasado el máximo se ignora en silencio (202 sin correo)', async () => {
    let sent = 0;
    for (let i = 0; i < 5; i++) {
      await bypass('alice@a.test');
      const before = b.mail.resetOutbox.length;
      expect((await forgot('alice@a.test')).status).toBe(202);
      sent += b.mail.resetOutbox.length - before;
    }
    expect(sent).toBe(3);
  });

  it('validación: campos desconocidos y formatos inválidos', async () => {
    for (const [p, body] of [['/auth/forgot', { email: 'no-correo', captcha_token: 'x' }], ['/auth/forgot', { email: 'a@a.test' }], ['/auth/reset', { token: 'x', new_password: NEW, user_id: IDS.bob }], ['/auth/reset', { new_password: NEW }]] as const) {
      expect((await post(p, body)).status, p).toBe(400);
    }
  });

  describe('cambio de contraseña autenticado (POST /v1/auth/password)', () => {
    it('requiere autenticación', async () => {
      expect((await post('/auth/password', { current_password: PW, new_password: NEW })).status).toBe(401);
    });

    it('éxito: 204, conserva la sesión actual, revoca las demás y cambia la contraseña', async () => {
      const here = await login('alice@a.test');
      const other = await login('alice@a.test');
      const r = await post('/auth/password', { current_password: PW, new_password: NEW }, here.body.access_token);
      expect(r.status).toBe(204);
      expect((await me(here.body.access_token)).status).toBe(200);   // sigue conectada
      expect((await me(other.body.access_token)).status).toBe(401);  // el otro dispositivo, no
      expect((await post('/auth/refresh', { refresh_token: other.body.refresh_token })).status).toBe(401);
      expect((await post('/auth/refresh', { refresh_token: here.body.refresh_token })).status).toBe(200); // la actual puede refrescar
      // Las demás sesiones quedan REVOCADAS explícitamente (además de invalidadas por session_version) y la actual no
      expect((await admin.query(`SELECT count(*)::int AS n FROM sessions WHERE revoke_reason = 'password_change'`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND user_id = $1`, [IDS.alice])).rows[0].n).toBe(1);
      expect((await login('alice@a.test', PW)).status).toBe(401);
      expect((await login('alice@a.test', NEW)).status).toBe(200);
    });

    it('contraseña actual errónea → 400 y cuenta para el bloqueo (una sesión robada no puede adivinarla sin límite)', async () => {
      const t = (await login('alice@a.test')).body.access_token;
      for (let i = 0; i < 5; i++) expect((await post('/auth/password', { current_password: 'mala', new_password: NEW }, t)).status).toBe(400);
      expect((await post('/auth/password', { current_password: PW, new_password: NEW }, t)).status).toBe(429);
      expect((await admin.query(`SELECT password_hash FROM users WHERE email='alice@a.test'`)).rows[0].password_hash).toBe(hash);
    });

    it('rechaza nueva igual a la actual y nueva demasiado corta', async () => {
      const t = (await login('alice@a.test')).body.access_token;
      expect((await post('/auth/password', { current_password: PW, new_password: PW }, t)).status).toBe(400);
      expect((await post('/auth/password', { current_password: PW, new_password: 'corta' }, t)).status).toBe(400);
    });

    it('no admite ids ajenos: user_id/organization_id en el cuerpo se rechazan y solo cambia el usuario del token (A↔B)', async () => {
      const a = (await login('alice@a.test')).body.access_token;
      expect((await post('/auth/password', { current_password: PW, new_password: NEW, user_id: IDS.bob }, a)).status).toBe(400);
      expect((await post('/auth/password', { current_password: PW, new_password: NEW, organization_id: ORG_B }, a)).status).toBe(400);
      expect((await post('/auth/password', { current_password: PW, new_password: NEW }, a)).status).toBe(204);
      expect((await login('bob@b.test', PW)).status).toBe(200); // Bob intacto
      expect((await admin.query(`SELECT password_hash FROM users WHERE email='bob@b.test'`)).rows[0].password_hash).toBe(hash);
    });

    it('un Súper Admin (principal de plataforma) puede cambiar su propia contraseña', async () => {
      const t = (await login('root@plat.test')).body.access_token;
      expect((await post('/auth/password', { current_password: PW, new_password: NEW }, t)).status).toBe(204);
      expect((await login('root@plat.test', NEW)).status).toBe(200);
    });
  });

  it('app_identity no puede borrar password_resets (sin DELETE/TRUNCATE)', async () => {
    const c = new Client({ connectionString: info.identityUrl });
    await c.connect();
    try {
      for (const q of ['DELETE FROM password_resets', 'TRUNCATE password_resets']) await expect(c.query(q), q).rejects.toThrow(/permission denied/);
    } finally { await c.end(); }
  });
});

describe('límites por IP y sin proveedores', () => {
  let b: Booted;
  const post = (path: string, body: unknown) => fetch(`${b.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    hash = await new Argon2idHasher().hash(PW);
    b = await boot({ ...GENEROUS, RESET_IP_MAX_PER_HOUR: '2', RESET_ATTEMPT_IP_MAX_PER_HOUR: '5' });
  });
  afterAll(async () => { await b.app.close(); await admin.end(); process.env = saved; });
  beforeEach(seed);

  it('forgot: la 3.ª solicitud desde la misma IP recibe 429 con Retry-After', async () => {
    for (let i = 0; i < 2; i++) expect((await post('/auth/forgot', { email: `u${i}@a.test`, captcha_token: FAKE_CAPTCHA_PASS })).status).toBe(202);
    const r = await post('/auth/forgot', { email: 'u9@a.test', captcha_token: FAKE_CAPTCHA_PASS });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('reset: tras 5 intentos desde la misma IP responde 429 aunque el token fuera válido', async () => {
    for (let i = 0; i < 5; i++) await post('/auth/reset', { token: 'basura', new_password: NEW });
    expect((await post('/auth/reset', { token: 'basura', new_password: NEW })).status).toBe(429);
  });
});

describe('sin proveedores configurados', () => {
  it('forgot responde 503 PASSWORD_RESET_UNAVAILABLE y no crea nada', async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    hash = await new Argon2idHasher().hash(PW);
    const b = await boot({ MAIL_PROVIDER: 'none', CAPTCHA_PROVIDER: 'none' });
    try {
      await seed();
      const r = await fetch(`${b.base}/auth/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@a.test', captcha_token: 'x' }) });
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: { code: 'PASSWORD_RESET_UNAVAILABLE' } });
      expect((await admin.query('SELECT count(*)::int AS n FROM password_resets')).rows[0].n).toBe(0);
    } finally { await b.app.close(); await admin.end(); process.env = saved; }
  });
});
