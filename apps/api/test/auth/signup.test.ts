// M1.2 — registro, verificación de correo y reenvío. Correo y CAPTCHA son fakes (puertos); no hay proveedor real.
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { CAPTCHA_VERIFIER, FAKE_CAPTCHA_PASS, MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
let admin: Client;
const saved = { ...process.env };

interface Booted { app: INestApplication; base: string; mail: MemoryMailProvider }
async function boot(env: Record<string, string>): Promise<Booted> {
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, ...env });
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
  return { app, base: `${await app.getUrl()}/v1`, mail };
}
const GENEROUS = { FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', SIGNUP_IP_MAX_PER_HOUR: '200', SIGNUP_VERIFY_IP_MAX_PER_HOUR: '500', SIGNUP_EMAIL_MAX_PER_HOUR: '5' };

const mk = (b: Booted) => ({
  post: (path: string, body: unknown) => fetch(`${b.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const scrub = (o: unknown) => JSON.stringify(o, (k, v) => (k === 'request_id' ? undefined : v));
const reg = (email: string, extra: Record<string, unknown> = {}) => ({ email, password: PW, organization_name: 'Mi Empresa SA', timezone: 'America/Guayaquil', captcha_token: FAKE_CAPTCHA_PASS, ...extra });
const wrongCode = (real: string) => (real === '000000' ? '000001' : '000000');
const bypassCooldown = (email: string) => admin.query(`UPDATE email_verifications SET last_sent_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]);

async function clean() {
  await admin.query('TRUNCATE sessions, auth_throttle, email_verifications, signup_attempts, disposable_domains, organization_members, organizations, users CASCADE');
}

describe('registro y verificación (proveedores fake)', () => {
  let b: Booted;
  let api: ReturnType<typeof mk>;
  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    b = await boot(GENEROUS);
    api = mk(b);
  });
  afterAll(async () => { await b.app.close(); await admin.end(); process.env = saved; });
  beforeEach(async () => { await clean(); b.mail.outbox.length = 0; });

  it('flujo feliz: signup → correo con código → verify crea organización client + membresía client_admin → login', async () => {
    const r = await api.post('/auth/signup', reg('Nueva@Empresa.test'));
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ status: 'verification_requested' });
    const mail = b.mail.last('nueva@empresa.test')!;
    expect(mail.code).toMatch(/^\d{6}$/);
    expect(mail.expiresInMinutes).toBe(15);

    // Antes de verificar: usuario pendiente, SIN organización ni membresía, y no puede iniciar sesión
    expect((await admin.query(`SELECT status, email_verified_at FROM users WHERE email='nueva@empresa.test'`)).rows[0]).toMatchObject({ status: 'pending', email_verified_at: null });
    expect((await admin.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n).toBe(0);
    expect((await api.post('/auth/login', { email: 'nueva@empresa.test', password: PW })).status).toBe(401);

    const v = await api.post('/auth/verify', { email: 'nueva@empresa.test', code: mail.code });
    expect(v.status).toBe(200);
    expect(await v.json()).toEqual({ status: 'verified' });

    const org = (await admin.query(`SELECT o.kind, o.name, o.timezone, m.role, m.granted_by, u.status, u.email_verified_at FROM organizations o JOIN organization_members m ON m.organization_id=o.id JOIN users u ON u.id=m.user_id WHERE u.email='nueva@empresa.test'`)).rows;
    expect(org).toHaveLength(1);
    expect(org[0]).toMatchObject({ kind: 'client', name: 'Mi Empresa SA', timezone: 'America/Guayaquil', role: 'client_admin', granted_by: null, status: 'active' });
    expect(org[0].email_verified_at).not.toBeNull();

    const l = await api.post('/auth/login', { email: 'nueva@empresa.test', password: PW, token_transport: 'body' });
    expect(l.status).toBe(200);
    expect(await l.json()).toMatchObject({ role: 'client_admin', organization: { kind: 'client', name: 'Mi Empresa SA' } });
  });

  it('en BD solo hay el HMAC del código y un hash Argon2id; ninguno contiene el valor original', async () => {
    await api.post('/auth/signup', reg('x@y.test'));
    const code = b.mail.last('x@y.test')!.code;
    const dump = JSON.stringify((await admin.query('SELECT * FROM email_verifications')).rows) + JSON.stringify((await admin.query('SELECT password_hash FROM users')).rows) + JSON.stringify((await admin.query('SELECT * FROM signup_attempts')).rows);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain('x@y.test'); // los contadores usan HMAC, no el correo
    expect((await admin.query('SELECT code_hmac FROM email_verifications')).rows[0].code_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect((await admin.query('SELECT password_hash FROM users')).rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('respuesta de signup UNIFORME: correo nuevo, pendiente o con cuenta activa devuelven lo mismo y la cuenta existente no cambia', async () => {
    await api.post('/auth/signup', reg('activo@a.test'));
    await api.post('/auth/verify', { email: 'activo@a.test', code: b.mail.last('activo@a.test')!.code });
    const before = (await admin.query(`SELECT password_hash, session_version FROM users WHERE email='activo@a.test'`)).rows[0];
    await bypassCooldown('activo@a.test'); // sin el cooldown de por medio: la protección debe venir de la regla de cuenta activa
    b.mail.outbox.length = 0;

    const bodies: string[] = [];
    for (const email of ['activo@a.test', 'nuevo@a.test']) {
      const r = await api.post('/auth/signup', reg(email, { password: 'Otra-Clave-Larga-1' }));
      expect(r.status).toBe(202);
      bodies.push(scrub(await r.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(b.mail.outbox.map((m) => m.to)).toEqual(['nuevo@a.test']); // la cuenta activa NO recibe correo
    expect((await admin.query(`SELECT password_hash, session_version FROM users WHERE email='activo@a.test'`)).rows[0]).toEqual(before);
    expect((await api.post('/auth/login', { email: 'activo@a.test', password: PW })).status).toBe(200); // su contraseña sigue igual
  });

  it('re-registro de un correo pendiente: invalida el código anterior y usa la contraseña/organización nuevas', async () => {
    await api.post('/auth/signup', reg('p@a.test', { organization_name: 'Primera' }));
    const first = b.mail.last('p@a.test')!.code;
    await bypassCooldown('p@a.test');
    await api.post('/auth/signup', reg('p@a.test', { organization_name: 'Segunda', password: 'Segunda-Clave-12345' }));
    const second = b.mail.last('p@a.test')!.code;
    expect(await admin.query(`SELECT count(*)::int AS n FROM users WHERE email='p@a.test'`).then((r) => r.rows[0].n)).toBe(1);
    if (first !== second) expect((await api.post('/auth/verify', { email: 'p@a.test', code: first })).status).toBe(400);
    expect((await api.post('/auth/verify', { email: 'p@a.test', code: second })).status).toBe(200);
    expect((await admin.query(`SELECT o.name FROM organizations o`)).rows.map((r) => r.name)).toEqual(['Segunda']);
    expect((await api.post('/auth/login', { email: 'p@a.test', password: PW })).status).toBe(401);
    expect((await api.post('/auth/login', { email: 'p@a.test', password: 'Segunda-Clave-12345' })).status).toBe(200);
  });

  it('CAPTCHA inválido → 400 CAPTCHA_FAILED y no se crea nada ni se envía correo', async () => {
    const r = await api.post('/auth/signup', reg('c@a.test', { captcha_token: 'malo' }));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: 'CAPTCHA_FAILED' } });
    expect((await admin.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
    expect(b.mail.outbox).toHaveLength(0);
    expect((await api.post('/auth/resend', { email: 'c@a.test', captcha_token: 'malo' })).status).toBe(400);
  });

  it('dominios desechables rechazados (lista en BD, solo lectura para la app)', async () => {
    await admin.query(`INSERT INTO disposable_domains(domain) VALUES ('tempmail.test')`);
    const r = await api.post('/auth/signup', reg('alguien@tempmail.test'));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: 'EMAIL_DOMAIN_NOT_ALLOWED' } });
    expect((await admin.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
    expect((await api.post('/auth/signup', reg('alguien@otro.test'))).status).toBe(202);
  });

  it('validación: campos desconocidos, contraseña corta, correo/zona/código mal formados', async () => {
    const cases: Array<[string, unknown]> = [
      ['/auth/signup', reg('a@a.test', { organization_id: 'x' })],
      ['/auth/signup', reg('a@a.test', { password: 'corta' })], // 5 caracteres: bajo el mínimo de 6
      ['/auth/signup', reg('no-es-correo')],
      ['/auth/signup', reg('a@a.test', { timezone: 'Marte/Olimpo' })],
      ['/auth/signup', reg('a@a.test', { organization_name: 'x' })],
      ['/auth/verify', { email: 'a@a.test', code: '12345' }],
      ['/auth/verify', { email: 'a@a.test', code: 'abcdef' }],
      ['/auth/resend', { email: 'a@a.test' }],
    ];
    for (const [p, body] of cases) expect((await api.post(p, body)).status, `${p} ${JSON.stringify(body)}`).toBe(400);
    expect((await admin.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
  });

  it('contraseña: 8 caracteres es el mínimo por defecto (7 se rechaza)', async () => {
    expect((await api.post('/auth/signup', reg('siete@a.test', { password: 'abc1234' }))).status).toBe(400);
    expect((await api.post('/auth/signup', reg('ocho@a.test', { password: 'abc12345' }))).status).toBe(202);
    expect(b.mail.last('ocho@a.test')).toBeDefined();
  });

  it('zona horaria opcional: por defecto UTC', async () => {
    const body: Record<string, unknown> = reg('tz@a.test');
    delete body['timezone'];
    await api.post('/auth/signup', body);
    await api.post('/auth/verify', { email: 'tz@a.test', code: b.mail.last('tz@a.test')!.code });
    expect((await admin.query('SELECT timezone FROM organizations')).rows[0].timezone).toBe('UTC');
  });

  it('verify: error UNIFORME para correo inexistente, código incorrecto, vencido, agotado y ya verificado', async () => {
    await api.post('/auth/signup', reg('v@a.test'));
    const real = b.mail.last('v@a.test')!.code;
    const bodies: string[] = [];
    const attempt = async (email: string, code: string) => { const r = await api.post('/auth/verify', { email, code }); expect(r.status).toBe(400); bodies.push(scrub(await r.json())); };
    await attempt('nadie@a.test', '123456');
    await attempt('v@a.test', wrongCode(real));
    await admin.query(`UPDATE email_verifications SET expires_at = now() - interval '1 second'`);
    await attempt('v@a.test', real);
    await admin.query(`UPDATE email_verifications SET expires_at = now() + interval '10 minutes', attempts = 5`);
    await attempt('v@a.test', real);
    await admin.query(`UPDATE email_verifications SET attempts = 0`);
    expect((await api.post('/auth/verify', { email: 'v@a.test', code: real })).status).toBe(200);
    await attempt('v@a.test', real); // ya verificado
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('INVALID_CODE');
  });

  it('5 códigos erróneos queman el código aunque después se envíe el correcto; reenviar emite uno nuevo y el anterior deja de valer', async () => {
    await api.post('/auth/signup', reg('f@a.test'));
    const real = b.mail.last('f@a.test')!.code;
    for (let i = 0; i < 5; i++) expect((await api.post('/auth/verify', { email: 'f@a.test', code: wrongCode(real) })).status).toBe(400);
    expect((await admin.query('SELECT attempts FROM email_verifications')).rows[0].attempts).toBe(5);
    expect((await api.post('/auth/verify', { email: 'f@a.test', code: real })).status).toBe(400);
    expect((await admin.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n).toBe(0);

    await bypassCooldown('f@a.test');
    expect((await api.post('/auth/resend', { email: 'f@a.test', captcha_token: FAKE_CAPTCHA_PASS })).status).toBe(202);
    const fresh = b.mail.last('f@a.test')!.code;
    expect((await admin.query('SELECT attempts, sent_count FROM email_verifications')).rows[0]).toMatchObject({ attempts: 0, sent_count: 2 });
    if (fresh !== real) expect((await api.post('/auth/verify', { email: 'f@a.test', code: real })).status).toBe(400);
    expect((await api.post('/auth/verify', { email: 'f@a.test', code: fresh })).status).toBe(200);
  });

  it('dos verificaciones simultáneas con el código correcto: exactamente una crea la organización', async () => {
    await api.post('/auth/signup', reg('k@a.test'));
    const code = b.mail.last('k@a.test')!.code;
    const rs = await Promise.all(Array.from({ length: 6 }, () => api.post('/auth/verify', { email: 'k@a.test', code })));
    const statuses = rs.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400, 400, 400, 400, 400]);
    expect((await admin.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM organization_members')).rows[0].n).toBe(1);
  });

  it('verify toma el bloqueo de fila: espera a una transacción que ya tiene la verificación y luego procede una sola vez', async () => {
    await api.post('/auth/signup', reg('w@a.test'));
    const code = b.mail.last('w@a.test')!.code;
    const holder = new Client({ connectionString: info.adminDbUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM email_verifications WHERE user_id = (SELECT id FROM users WHERE email='w@a.test') FOR UPDATE`);
      let settled = false;
      const pending = api.post('/auth/verify', { email: 'w@a.test', code }).then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // sigue esperando el bloqueo
      await holder.query('COMMIT');
      expect((await pending).status).toBe(200);
    } finally { await holder.end(); }
    expect((await admin.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n).toBe(1);
  });

  it('signup sobre una cuenta ya verificada fuera de cooldown tampoco cambia contraseña ni genera código nuevo', async () => {
    await api.post('/auth/signup', reg('t@a.test'));
    await api.post('/auth/verify', { email: 't@a.test', code: b.mail.last('t@a.test')!.code });
    await bypassCooldown('t@a.test');
    const row = (await admin.query(`SELECT code_hmac, sent_count FROM email_verifications`)).rows[0];
    b.mail.outbox.length = 0;
    await api.post('/auth/signup', reg('t@a.test', { password: 'Intento-De-Secuestro-1' }));
    expect(b.mail.outbox).toHaveLength(0);
    expect((await admin.query(`SELECT code_hmac, sent_count FROM email_verifications`)).rows[0]).toEqual(row);
    expect((await api.post('/auth/login', { email: 't@a.test', password: PW })).status).toBe(200);
    expect((await api.post('/auth/login', { email: 't@a.test', password: 'Intento-De-Secuestro-1' })).status).toBe(401);
  });

  it('reenvío: respuesta uniforme (inexistente, activa, pendiente en cooldown) y sin correo durante el cooldown', async () => {
    await api.post('/auth/signup', reg('r@a.test'));
    await api.post('/auth/verify', { email: 'r@a.test', code: b.mail.last('r@a.test')!.code });
    await api.post('/auth/signup', reg('s@a.test'));
    b.mail.outbox.length = 0;
    const bodies: string[] = [];
    for (const email of ['nadie@a.test', 'r@a.test', 's@a.test']) {
      const r = await api.post('/auth/resend', { email, captcha_token: FAKE_CAPTCHA_PASS });
      expect(r.status).toBe(202);
      bodies.push(scrub(await r.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(b.mail.outbox).toHaveLength(0); // 's' acaba de recibir uno: cooldown
    await bypassCooldown('s@a.test');
    await api.post('/auth/resend', { email: 's@a.test', captcha_token: FAKE_CAPTCHA_PASS });
    expect(b.mail.outbox.map((m) => m.to)).toEqual(['s@a.test']);
  });

  it('límite por correo: pasado el máximo por hora se ignora en silencio (202, sin correo, sin diferencia observable)', async () => {
    let sent = 0;
    for (let i = 0; i < 7; i++) {
      await bypassCooldown('l@a.test').catch(() => undefined);
      const before = b.mail.outbox.length;
      const r = await api.post('/auth/signup', reg('l@a.test'));
      expect(r.status).toBe(202);
      sent += b.mail.outbox.length - before;
    }
    expect(sent).toBe(5);
  });

  it('fallo del proveedor de correo: 202 igualmente, el usuario puede reenviar', async () => {
    b.mail.failNext = true;
    expect((await api.post('/auth/signup', reg('m@a.test'))).status).toBe(202);
    expect(b.mail.outbox).toHaveLength(0);
    await bypassCooldown('m@a.test');
    await api.post('/auth/resend', { email: 'm@a.test', captcha_token: FAKE_CAPTCHA_PASS });
    expect(b.mail.last('m@a.test')).toBeDefined();
  });

  it('aislamiento: dos registros crean organizaciones distintas y cada usuario solo entra en la suya', async () => {
    for (const [email, org] of [['ua@a.test', 'Empresa Uno'], ['ub@b.test', 'Empresa Dos']] as const) {
      await api.post('/auth/signup', reg(email, { organization_name: org }));
      await api.post('/auth/verify', { email, code: b.mail.last(email)!.code });
    }
    const la = (await (await api.post('/auth/login', { email: 'ua@a.test', password: PW })).json()) as { organization: { id: string; name: string } };
    const lb = (await (await api.post('/auth/login', { email: 'ub@b.test', password: PW })).json()) as { organization: { id: string; name: string } };
    expect(la.organization.name).toBe('Empresa Uno');
    expect(lb.organization.name).toBe('Empresa Dos');
    expect(la.organization.id).not.toBe(lb.organization.id);
  });

  it('app_identity no puede borrar ni escribir disposable_domains (sin DELETE; lista de solo lectura)', async () => {
    const c = new Client({ connectionString: info.identityUrl });
    await c.connect();
    try {
      for (const q of ['DELETE FROM email_verifications', 'DELETE FROM signup_attempts', `INSERT INTO disposable_domains(domain) VALUES ('x.test')`, 'TRUNCATE signup_attempts']) {
        await expect(c.query(q), q).rejects.toThrow(/permission denied/);
      }
    } finally { await c.end(); }
  });
});

describe('límites por IP (config reducida)', () => {
  let b: Booted;
  let api: ReturnType<typeof mk>;
  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    b = await boot({ ...GENEROUS, SIGNUP_IP_MAX_PER_HOUR: '3', SIGNUP_VERIFY_IP_MAX_PER_HOUR: '5' });
    api = mk(b);
  });
  afterAll(async () => { await b.app.close(); await admin.end(); process.env = saved; });
  beforeEach(async () => { await clean(); b.mail.outbox.length = 0; });

  it('signup/resend: el 4.º intento desde la misma IP recibe 429 con Retry-After', async () => {
    for (let i = 0; i < 3; i++) expect((await api.post('/auth/signup', reg(`i${i}@a.test`))).status).toBe(202);
    const r = await api.post('/auth/signup', reg('i9@a.test'));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await api.post('/auth/resend', { email: 'i0@a.test', captcha_token: FAKE_CAPTCHA_PASS })).status).toBe(429);
  });

  it('verify: tras 5 intentos desde la misma IP responde 429 aunque el código sea correcto', async () => {
    await api.post('/auth/signup', reg('z@a.test'));
    const real = b.mail.last('z@a.test')!.code;
    for (let i = 0; i < 5; i++) await api.post('/auth/verify', { email: 'z@a.test', code: wrongCode(real) });
    const r = await api.post('/auth/verify', { email: 'z@a.test', code: real });
    expect(r.status).toBe(429);
    expect((await admin.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n).toBe(0);
  });
});

describe('sin proveedores configurados (valor por defecto)', () => {
  let b: Booted;
  let api: ReturnType<typeof mk>;
  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    b = await boot({ MAIL_PROVIDER: 'none', CAPTCHA_PROVIDER: 'none' });
    api = mk(b);
  });
  afterAll(async () => { await b.app.close(); await admin.end(); process.env = saved; });
  beforeEach(clean);

  it('signup y resend responden 503 SIGNUP_UNAVAILABLE y no crean nada (nunca simulan éxito)', async () => {
    for (const [p, body] of [['/auth/signup', reg('n@a.test')], ['/auth/resend', { email: 'n@a.test', captcha_token: 'x' }]] as const) {
      const r = await api.post(p, body);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: { code: 'SIGNUP_UNAVAILABLE' } });
    }
    expect((await admin.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
  });

  it('el CAPTCHA "none" nunca valida (falla cerrado) aunque el token parezca bueno', async () => {
    const v = b.app.get(CAPTCHA_VERIFIER, { strict: false }) as { verify(i: { token: string }): Promise<boolean> };
    expect(await v.verify({ token: FAKE_CAPTCHA_PASS })).toBe(false);
  });
});
