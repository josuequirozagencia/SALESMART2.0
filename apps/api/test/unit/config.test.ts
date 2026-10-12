import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '../../src/config';
import { envSchema } from '../../src/config/env.schema';

const good = {
  NODE_ENV: 'test',
  DATABASE_URL_APP: 'postgresql://app_rw:S3cr3t-pw@db.internal:5432/ss',
  DATABASE_URL_PLATFORM: 'postgresql://app_platform:Other-S3cr3t@db.internal:5432/ss',
  AUTH_THROTTLE_KEY: 'k'.repeat(40),
  DATABASE_URL_IDENTITY: 'postgresql://app_identity:Third-S3cr3t@db.internal:5432/ss',
};

describe('configuración validada', () => {
  it('acepta una configuración válida y aplica valores por defecto no sensibles', () => {
    const c = loadConfig(good);
    expect(c).toMatchObject({ nodeEnv: 'test', logLevel: 'info', httpPort: 3000, db: { appPoolMax: 10, platformPoolMax: 3, identityPoolMax: 3 } });
  });
  it('los parámetros de acceso PROVISIONALES tienen valores por defecto y son configurables dentro de rangos', () => {
    expect(loadConfig(good).auth).toMatchObject({ accessTtlMs: 900_000, refreshTtlMs: 30 * 86_400_000, sessionAbsoluteTtlMs: 90 * 86_400_000, accountLockThreshold: 5, ipLockThreshold: 25, lockBaseMs: 60_000, lockMaxMs: 3_600_000 });
    const c = loadConfig({ ...good, AUTH_ACCESS_TTL_SECONDS: '300', AUTH_ACCOUNT_LOCK_THRESHOLD: '3', AUTH_REFRESH_TTL_DAYS: '7' });
    expect(c.auth).toMatchObject({ accessTtlMs: 300_000, accountLockThreshold: 3, refreshTtlMs: 7 * 86_400_000 });
  });
  it.each([['AUTH_ACCESS_TTL_SECONDS', '5'], ['AUTH_ACCESS_TTL_SECONDS', '999999'], ['AUTH_ACCOUNT_LOCK_THRESHOLD', '1'], ['AUTH_REFRESH_TTL_DAYS', '0']])('rechaza %s=%s fuera de rango', (k, v) => {
    expect(() => loadConfig({ ...good, [k]: v })).toThrow(new RegExp(k));
  });
  it('rechaza combinaciones incoherentes (bloqueo máximo < base; sesión absoluta < refresh)', () => {
    expect(() => loadConfig({ ...good, AUTH_LOCK_BASE_SECONDS: '600', AUTH_LOCK_MAX_SECONDS: '60' })).toThrow(/AUTH_LOCK_MAX_SECONDS/);
    expect(() => loadConfig({ ...good, AUTH_REFRESH_TTL_DAYS: '60', AUTH_SESSION_ABSOLUTE_TTL_DAYS: '30' })).toThrow(/AUTH_SESSION_ABSOLUTE_TTL_DAYS/);
  });
  it('registro (M1.2): sin proveedores por defecto; parámetros PROVISIONALES configurables y validados', () => {
    expect(loadConfig(good).signup).toMatchObject({ mailProvider: 'none', captchaProvider: 'none', codeTtlMs: 15 * 60_000, codeMaxAttempts: 5, resendCooldownMs: 60_000, emailMaxPerHour: 5, ipMaxPerHour: 10, passwordMinLength: 8 });
    expect(loadConfig({ ...good, SIGNUP_CODE_TTL_MINUTES: '10', SIGNUP_CODE_MAX_ATTEMPTS: '3' }).signup).toMatchObject({ codeTtlMs: 600_000, codeMaxAttempts: 3 });
    for (const [k, v] of [['SIGNUP_CODE_TTL_MINUTES', '1'], ['SIGNUP_CODE_MAX_ATTEMPTS', '99'], ['MAIL_PROVIDER', 'sendgrid'], ['CAPTCHA_PROVIDER', 'recaptcha']]) {
      expect(() => loadConfig({ ...good, [k as string]: v as string }), `${k}=${v}`).toThrow(new RegExp(k as string));
    }
  });
  it('los proveedores falsos (console, memory, fake) se rechazan en producción; "none" es válido', () => {
    const prod = { ...good, NODE_ENV: 'production' };
    expect(() => loadConfig({ ...prod, MAIL_PROVIDER: 'console', FRONTEND_BASE_URL: 'https://x.test' })).toThrow(/MAIL_PROVIDER/);
    expect(() => loadConfig({ ...prod, MAIL_PROVIDER: 'memory', FRONTEND_BASE_URL: 'https://x.test' })).toThrow(/MAIL_PROVIDER/);
    expect(() => loadConfig({ ...prod, CAPTCHA_PROVIDER: 'fake' })).toThrow(/CAPTCHA_PROVIDER/);
    expect(loadConfig(prod).signup).toMatchObject({ mailProvider: 'none', captchaProvider: 'none' });
    expect(loadConfig({ ...good, MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', FRONTEND_BASE_URL: 'http://localhost:5173' }).signup.mailProvider).toBe('console');
  });
  describe('proveedores reales: Resend y Turnstile (ADR-37)', () => {
    const real = { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_1234567890abcdef', MAIL_FROM: 'Sales Smart <no-reply@growthconsulting.digital>', FRONTEND_BASE_URL: 'https://app.growthconsulting.digital', CAPTCHA_PROVIDER: 'turnstile', TURNSTILE_SECRET_KEY: '0x4AAAAAAAbcdefgh1234567' };
    it('configuración completa válida, también en producción (los fakes siguen prohibidos allí)', () => {
      const c = loadConfig({ ...good, NODE_ENV: 'production', ...real });
      expect(c.signup).toMatchObject({ mailProvider: 'resend', captchaProvider: 'turnstile' });
      expect(c.providers).toEqual({ resendApiKey: real.RESEND_API_KEY, mailFrom: real.MAIL_FROM, turnstileSecret: real.TURNSTILE_SECRET_KEY });
    });
    it('exige la clave y el remitente de Resend y el secreto de Turnstile cuando se eligen', () => {
      const without = (key: string): Record<string, string> => Object.fromEntries(Object.entries(real).filter(([k]) => k !== key));
      const noKey = without('RESEND_API_KEY');
      const noFrom = without('MAIL_FROM');
      const noSecret = without('TURNSTILE_SECRET_KEY');
      expect(() => loadConfig({ ...good, ...noKey })).toThrow(/RESEND_API_KEY/);
      expect(() => loadConfig({ ...good, ...noFrom })).toThrow(/MAIL_FROM/);
      expect(() => loadConfig({ ...good, ...noSecret })).toThrow(/TURNSTILE_SECRET_KEY/);
    });
    it('rechaza claves con espacios o saltos de línea (van en cabeceras) y remitentes mal formados', () => {
      for (const k of ['re_ con espacio', 'corta', 're_abc\r\nX-Evil: 1', '']) expect(() => loadConfig({ ...good, ...real, RESEND_API_KEY: k }), k).toThrow(/RESEND_API_KEY/);
      for (const f of ['sin-arroba', 'Nombre <x@y>', '<x@y.com>', 'a b@y.com', 'Nombre <x@y.com>\r\nBcc: z@z.com', 'x@y.com, z@z.com']) expect(() => loadConfig({ ...good, ...real, MAIL_FROM: f }), f).toThrow(/MAIL_FROM/);
      for (const f of ['no-reply@growthconsulting.digital', 'Sales Smart <no-reply@growthconsulting.digital>']) expect(() => loadConfig({ ...good, ...real, MAIL_FROM: f }), f).not.toThrow();
    });
    it('los secretos NO salen en describeConfig (lo que se registra al arrancar)', () => {
      const text = JSON.stringify(describeConfig(loadConfig({ ...good, ...real })));
      for (const secret of [real.RESEND_API_KEY, real.TURNSTILE_SECRET_KEY]) expect(text).not.toContain(secret);
    });
    it('por defecto no hay proveedor real (503 en el registro) y los secretos no tienen valor por defecto', () => {
      const c = loadConfig(good);
      expect(c.signup).toMatchObject({ mailProvider: 'none', captchaProvider: 'none' });
      expect(c.providers).toEqual({ resendApiKey: undefined, mailFrom: undefined, turnstileSecret: undefined });
    });
  });

  describe('puerto y proxy (despliegue en Railway)', () => {
    it('usa PORT cuando no hay HTTP_PORT; HTTP_PORT manda sobre PORT; por defecto 3000', () => {
      expect(loadConfig(good).httpPort).toBe(3000);
      expect(loadConfig({ ...good, PORT: '8080' }).httpPort).toBe(8080);
      expect(loadConfig({ ...good, PORT: '8080', HTTP_PORT: '4000' }).httpPort).toBe(4000);
      expect(() => loadConfig({ ...good, PORT: '0' })).toThrow(/PORT/);
    });
    it('TRUST_PROXY_HOPS: 0 por defecto (no se confía en X-Forwarded-For) y de 0 a 5', () => {
      expect(loadConfig(good).trustProxyHops).toBe(0);
      expect(loadConfig({ ...good, TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
      for (const bad of ['-1', '6', 'x', '1.5']) expect(() => loadConfig({ ...good, TRUST_PROXY_HOPS: bad }), bad).toThrow(/TRUST_PROXY_HOPS/);
    });
    it('WEB_DIST_DIR es opcional', () => {
      expect(loadConfig(good).web.distDir).toBeUndefined();
      expect(loadConfig({ ...good, WEB_DIST_DIR: 'apps/web/dist' }).web.distDir).toBe('apps/web/dist');
    });
  });

  describe('tareas periódicas (M1.5)', () => {
    it('por defecto: apagadas en test, encendidas en desarrollo y producción; intervalo PROVISIONAL de 60 s', () => {
      expect(loadConfig(good).jobs).toEqual({ enabled: false, trialExpiryIntervalMs: 60_000, identityCleanupIntervalMs: 3_600_000 });
      expect(loadConfig({ ...good, NODE_ENV: 'development' }).jobs.enabled).toBe(true);
    });
    it('JOBS_ENABLED explícito manda sobre el valor por defecto', () => {
      expect(loadConfig({ ...good, JOBS_ENABLED: 'true' }).jobs.enabled).toBe(true);
      expect(loadConfig({ ...good, NODE_ENV: 'development', JOBS_ENABLED: 'false' }).jobs.enabled).toBe(false);
    });
    it.each([['JOBS_ENABLED', 'si'], ['JOBS_TRIAL_EXPIRY_INTERVAL_SECONDS', '1'], ['JOBS_TRIAL_EXPIRY_INTERVAL_SECONDS', '99999'], ['JOBS_TRIAL_EXPIRY_INTERVAL_SECONDS', 'abc'], ['JOBS_IDENTITY_CLEANUP_INTERVAL_SECONDS', '10'], ['JOBS_IDENTITY_CLEANUP_INTERVAL_SECONDS', '999999']])('rechaza %s=%s', (k, v) => {
      expect(() => loadConfig({ ...good, [k]: v })).toThrow(new RegExp(k));
    });
  });

  describe('longitud mínima de contraseña: 8 <= SIGNUP_PASSWORD_MIN_LENGTH <= 128', () => {
    it('por defecto es 8', () => {
      expect(loadConfig(good).signup.passwordMinLength).toBe(8);
    });
    it.each(['-1', '0', '1', '5', '6', '7', '7.9', ''])('rechaza %j (cualquier valor menor que 8 o no entero)', (v) => {
      expect(() => loadConfig({ ...good, SIGNUP_PASSWORD_MIN_LENGTH: v }), `valor ${v}`).toThrow(/SIGNUP_PASSWORD_MIN_LENGTH/);
    });
    it.each(['129', '1000', 'abc'])('rechaza %j (por encima de 128 o no numérico)', (v) => {
      expect(() => loadConfig({ ...good, SIGNUP_PASSWORD_MIN_LENGTH: v })).toThrow(/SIGNUP_PASSWORD_MIN_LENGTH/);
    });
    it.each([['8', 8], ['9', 9], ['12', 12], ['64', 64], ['128', 128]])('acepta %s', (v, n) => {
      expect(loadConfig({ ...good, SIGNUP_PASSWORD_MIN_LENGTH: v }).signup.passwordMinLength).toBe(n);
    });
    it('el esquema de entorno aplica el mismo rango (ningún valor < 8 es válido)', () => {
      const base = { NODE_ENV: 'test', DATABASE_URL_APP: 'postgresql://a:b@h/d', DATABASE_URL_PLATFORM: 'postgresql://c:d@h/d', DATABASE_URL_IDENTITY: 'postgresql://e:f@h/d', AUTH_THROTTLE_KEY: 'k'.repeat(40) };
      for (let n = -5; n < 8; n++) expect(envSchema.safeParse({ ...base, SIGNUP_PASSWORD_MIN_LENGTH: String(n) }).success, `n=${n}`).toBe(false);
      for (const n of [8, 9, 50, 128]) expect(envSchema.safeParse({ ...base, SIGNUP_PASSWORD_MIN_LENGTH: String(n) }).success, `n=${n}`).toBe(true);
      expect(envSchema.safeParse({ ...base, SIGNUP_PASSWORD_MIN_LENGTH: '129' }).success).toBe(false);
    });
  });
  describe('URL base del frontend (enlaces de correo)', () => {
    const withMail = { ...good, MAIL_PROVIDER: 'console' };
    it('sin MAIL_PROVIDER no es obligatoria; con un proveedor de correo sí (no se deriva de la petición)', () => {
      expect(loadConfig(good).frontend).toEqual({ baseUrl: undefined, resetLinkBase: undefined });
      expect(() => loadConfig(withMail)).toThrow(/FRONTEND_BASE_URL/);
    });
    it('normaliza y compone el enlace de restablecimiento', () => {
      expect(loadConfig({ ...withMail, FRONTEND_BASE_URL: 'https://app.ejemplo.test/' }).frontend).toEqual({ baseUrl: 'https://app.ejemplo.test', resetLinkBase: 'https://app.ejemplo.test/reset-password' });
      expect(loadConfig({ ...withMail, FRONTEND_BASE_URL: 'https://x.test/crm', RESET_LINK_PATH: '/auth/reset' }).frontend.resetLinkBase).toBe('https://x.test/crm/auth/reset');
    });
    it.each(['ftp://x.test', 'no-es-url', 'https://u:p@x.test', 'https://x.test/?a=1', 'https://x.test/#frag'])('rechaza FRONTEND_BASE_URL=%s', (v) => {
      expect(() => loadConfig({ ...good, FRONTEND_BASE_URL: v })).toThrow(/FRONTEND_BASE_URL/);
    });
    it('en producción exige https', () => {
      expect(() => loadConfig({ ...good, NODE_ENV: 'production', FRONTEND_BASE_URL: 'http://x.test' })).toThrow(/https/);
      expect(loadConfig({ ...good, NODE_ENV: 'production', FRONTEND_BASE_URL: 'https://x.test' }).frontend.baseUrl).toBe('https://x.test');
    });
    it.each(['reset', '//evil.test', '/a/../b', '/a?x=1', '/a#b'])('rechaza RESET_LINK_PATH=%s', (v) => {
      expect(() => loadConfig({ ...good, RESET_LINK_PATH: v })).toThrow(/RESET_LINK_PATH/);
    });
  });
  it('la configuración es inmutable (congelada en profundidad)', () => {
    const c = loadConfig(good);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.db)).toBe(true);
    expect(() => ((c.db as { appUrl: string }).appUrl = 'x')).toThrow();
  });
  it('NO hay valores por defecto para entorno ni credenciales de base de datos', () => {
    for (const key of ['NODE_ENV', 'DATABASE_URL_APP', 'DATABASE_URL_PLATFORM', 'DATABASE_URL_IDENTITY', 'AUTH_THROTTLE_KEY']) {
      const shape = (envSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>)[key]!;
      expect(shape.safeParse(undefined).success, key).toBe(false);
    }
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
  it.each([
    ['DATABASE_URL_OWNER', { DATABASE_URL_OWNER: 'postgresql://app_owner:x@h/db' }],
    ['DATABASE_URL_ADMIN', { DATABASE_URL_ADMIN: 'postgresql://postgres:x@h/db' }],
  ])('rechaza %s en el entorno de la aplicación', (name, extra) => {
    expect(() => loadConfig({ ...good, ...extra })).toThrow(new RegExp(name));
  });
  it.each(['postgres', 'app_owner'])('rechaza conectar la app como "%s"', (user) => {
    expect(() => loadConfig({ ...good, DATABASE_URL_APP: `postgresql://${user}:pw@h:5432/ss` })).toThrow(/no está permitido/);
    expect(() => loadConfig({ ...good, DATABASE_URL_PLATFORM: `postgresql://${user}:pw@h:5432/ss` })).toThrow(/no está permitido/);
    expect(() => loadConfig({ ...good, DATABASE_URL_IDENTITY: `postgresql://${user}:pw@h:5432/ss` })).toThrow(/no está permitido/);
  });
  it('exige roles distintos para app y plataforma', () => {
    expect(() => loadConfig({ ...good, DATABASE_URL_PLATFORM: good.DATABASE_URL_APP })).toThrow(/roles distintos/);
    expect(() => loadConfig({ ...good, DATABASE_URL_IDENTITY: good.DATABASE_URL_APP })).toThrow(/roles distintos/);
    expect(() => loadConfig({ ...good, DATABASE_URL_IDENTITY: good.DATABASE_URL_PLATFORM })).toThrow(/roles distintos/);
  });
  it('los errores NUNCA incluyen valores (contraseñas/URLs)', () => {
    const attempts = [
      { ...good, DATABASE_URL_APP: 'postgresql://postgres:LEAK-ME-123@h:5432/ss' },
      { ...good, DATABASE_URL_OWNER: 'postgresql://app_owner:LEAK-ME-456@h/db' },
      { ...good, DATABASE_URL_PLATFORM: 'esto-no-es-una-url-LEAK-ME-789' },
      { ...good, HTTP_PORT: 'LEAK-ME-000' },
    ];
    for (const env of attempts) {
      let msg = '';
      try { loadConfig(env); } catch (e) { msg = String((e as Error).message); }
      expect(msg).not.toBe('');
      expect(msg).not.toMatch(/LEAK-ME/);
    }
  });
  it('describeConfig no expone contraseñas', () => {
    const text = JSON.stringify(describeConfig(loadConfig(good)));
    expect(text).not.toMatch(/S3cr3t|Other-S3cr3t|password/i);
    expect(JSON.parse(text).db.app).toEqual({ role: 'app_rw', host: 'db.internal:5432', database: 'ss' });
  });
});
