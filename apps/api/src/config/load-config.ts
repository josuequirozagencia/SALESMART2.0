import { envSchema, FORBIDDEN_RUNTIME_DB_USERS, FORBIDDEN_RUNTIME_ENV } from './env.schema';

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly logLevel: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly httpPort: number;
  readonly auth: {
    readonly throttleKey: string;
    /** Todo lo siguiente es PROVISIONAL (ADR-26) y configurable por entorno. */
    readonly accessTtlMs: number;
    readonly refreshTtlMs: number;
    readonly sessionAbsoluteTtlMs: number;
    readonly accountLockThreshold: number;
    readonly ipLockThreshold: number;
    readonly lockBaseMs: number;
    readonly lockMaxMs: number;
    readonly failureWindowMs: number;
  };
  readonly signup: {
    readonly mailProvider: 'none' | 'console' | 'memory';
    readonly captchaProvider: 'none' | 'fake';
    /** PROVISIONAL (M1.2): configurables por entorno. */
    readonly codeTtlMs: number;
    readonly codeMaxAttempts: number;
    readonly resendCooldownMs: number;
    readonly emailMaxPerHour: number;
    readonly ipMaxPerHour: number;
    readonly verifyIpMaxPerHour: number;
    readonly passwordMinLength: number;
  };
  readonly frontend: {
    /** Base explícita (sin barra final) o undefined si no se configuró. Nunca se deriva de la petición. */
    readonly baseUrl: string | undefined;
    /** Base del enlace de restablecimiento (baseUrl + RESET_LINK_PATH) o undefined. */
    readonly resetLinkBase: string | undefined;
  };
  readonly reset: {
    /** PROVISIONAL (M1.3). */
    readonly tokenTtlMs: number;
    readonly cooldownMs: number;
    readonly emailMaxPerHour: number;
    readonly ipMaxPerHour: number;
    readonly attemptIpMaxPerHour: number;
  };
  readonly jobs: {
    readonly enabled: boolean;
    /** PROVISIONAL (M1.5). */
    readonly trialExpiryIntervalMs: number;
  };
  readonly db: {
    readonly appUrl: string;
    readonly platformUrl: string;
    readonly identityUrl: string;
    readonly appPoolMax: number;
    readonly platformPoolMax: number;
    readonly identityPoolMax: number;
  };
}

/** Error de configuración: lista variables y motivos, NUNCA valores. */
export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Configuración inválida:\n - ${issues.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

function dbUser(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return null;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const issues: string[] = [];

  for (const name of FORBIDDEN_RUNTIME_ENV) {
    if (env[name] !== undefined && env[name] !== '') {
      issues.push(`${name}: no debe estar presente en el entorno de la aplicación (solo herramientas de migración)`);
    }
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push(`${i.path.join('.') || '(raíz)'}: ${i.message}`);
    throw new ConfigError(issues);
  }
  const e = parsed.data;

  const appUser = dbUser(e.DATABASE_URL_APP);
  const platformUser = dbUser(e.DATABASE_URL_PLATFORM);
  const identityUser = dbUser(e.DATABASE_URL_IDENTITY);
  if (appUser === null) issues.push('DATABASE_URL_APP: URL ilegible');
  if (platformUser === null) issues.push('DATABASE_URL_PLATFORM: URL ilegible');
  if (identityUser === null) issues.push('DATABASE_URL_IDENTITY: URL ilegible');
  const users = [appUser, platformUser, identityUser].filter((u): u is string => u !== null);
  if (new Set(users).size !== users.length) {
    issues.push('DATABASE_URL_APP, DATABASE_URL_PLATFORM y DATABASE_URL_IDENTITY: deben usar tres roles distintos (mínimo privilegio, ADR-24/ADR-25)');
  }
  for (const [name, user] of [['DATABASE_URL_APP', appUser], ['DATABASE_URL_PLATFORM', platformUser], ['DATABASE_URL_IDENTITY', identityUser]] as const) {
    if (user && FORBIDDEN_RUNTIME_DB_USERS.includes(user)) {
      issues.push(`${name}: el rol "${user}" no está permitido en la aplicación (superusuario/propietario)`);
    }
  }
  if (e.AUTH_LOCK_MAX_SECONDS < e.AUTH_LOCK_BASE_SECONDS) issues.push('AUTH_LOCK_MAX_SECONDS: no puede ser menor que AUTH_LOCK_BASE_SECONDS');
  if (e.AUTH_SESSION_ABSOLUTE_TTL_DAYS < e.AUTH_REFRESH_TTL_DAYS) issues.push('AUTH_SESSION_ABSOLUTE_TTL_DAYS: no puede ser menor que AUTH_REFRESH_TTL_DAYS');
  let frontendBase: string | undefined;
  if (e.FRONTEND_BASE_URL !== undefined) {
    try {
      const u = new URL(e.FRONTEND_BASE_URL);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') issues.push('FRONTEND_BASE_URL: debe ser http(s)');
      else if (u.username || u.password || u.search || u.hash) issues.push('FRONTEND_BASE_URL: no puede incluir credenciales, query ni fragmento');
      else if (e.NODE_ENV === 'production' && u.protocol !== 'https:') issues.push('FRONTEND_BASE_URL: en producción debe ser https');
      else frontendBase = (u.origin + u.pathname).replace(/\/+$/, '');
    } catch {
      issues.push('FRONTEND_BASE_URL: URL ilegible');
    }
  }
  if (e.MAIL_PROVIDER !== 'none' && e.FRONTEND_BASE_URL === undefined) issues.push('FRONTEND_BASE_URL: obligatoria cuando MAIL_PROVIDER no es "none" (los enlaces de los correos no se derivan de la petición)');
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(e.RESET_LINK_PATH) || e.RESET_LINK_PATH.includes('//') || e.RESET_LINK_PATH.includes('..')) issues.push('RESET_LINK_PATH: debe empezar por "/" y contener solo caracteres de ruta seguros');
  if (e.NODE_ENV === 'production') {
    if (e.MAIL_PROVIDER === 'console' || e.MAIL_PROVIDER === 'memory') issues.push(`MAIL_PROVIDER: "${e.MAIL_PROVIDER}" es solo para desarrollo/pruebas y no se permite en producción`);
    if (e.CAPTCHA_PROVIDER === 'fake') issues.push('CAPTCHA_PROVIDER: "fake" es solo para desarrollo/pruebas y no se permite en producción');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return deepFreeze({
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    httpPort: e.HTTP_PORT,
    auth: {
      throttleKey: e.AUTH_THROTTLE_KEY,
      accessTtlMs: e.AUTH_ACCESS_TTL_SECONDS * 1000,
      refreshTtlMs: e.AUTH_REFRESH_TTL_DAYS * 86_400_000,
      sessionAbsoluteTtlMs: e.AUTH_SESSION_ABSOLUTE_TTL_DAYS * 86_400_000,
      accountLockThreshold: e.AUTH_ACCOUNT_LOCK_THRESHOLD,
      ipLockThreshold: e.AUTH_IP_LOCK_THRESHOLD,
      lockBaseMs: e.AUTH_LOCK_BASE_SECONDS * 1000,
      lockMaxMs: e.AUTH_LOCK_MAX_SECONDS * 1000,
      failureWindowMs: e.AUTH_FAILURE_WINDOW_HOURS * 3_600_000,
    },
    signup: {
      mailProvider: e.MAIL_PROVIDER,
      captchaProvider: e.CAPTCHA_PROVIDER,
      codeTtlMs: e.SIGNUP_CODE_TTL_MINUTES * 60_000,
      codeMaxAttempts: e.SIGNUP_CODE_MAX_ATTEMPTS,
      resendCooldownMs: e.SIGNUP_RESEND_COOLDOWN_SECONDS * 1000,
      emailMaxPerHour: e.SIGNUP_EMAIL_MAX_PER_HOUR,
      ipMaxPerHour: e.SIGNUP_IP_MAX_PER_HOUR,
      verifyIpMaxPerHour: e.SIGNUP_VERIFY_IP_MAX_PER_HOUR,
      passwordMinLength: e.SIGNUP_PASSWORD_MIN_LENGTH,
    },
    frontend: { baseUrl: frontendBase, resetLinkBase: frontendBase === undefined ? undefined : frontendBase + e.RESET_LINK_PATH },
    reset: {
      tokenTtlMs: e.RESET_TOKEN_TTL_MINUTES * 60_000,
      cooldownMs: e.RESET_COOLDOWN_SECONDS * 1000,
      emailMaxPerHour: e.RESET_EMAIL_MAX_PER_HOUR,
      ipMaxPerHour: e.RESET_IP_MAX_PER_HOUR,
      attemptIpMaxPerHour: e.RESET_ATTEMPT_IP_MAX_PER_HOUR,
    },
    jobs: { enabled: e.JOBS_ENABLED === undefined ? e.NODE_ENV !== 'test' : e.JOBS_ENABLED === 'true', trialExpiryIntervalMs: e.JOBS_TRIAL_EXPIRY_INTERVAL_SECONDS * 1000 },
    db: {
      appUrl: e.DATABASE_URL_APP,
      platformUrl: e.DATABASE_URL_PLATFORM,
      identityUrl: e.DATABASE_URL_IDENTITY,
      appPoolMax: e.DB_POOL_MAX_APP,
      platformPoolMax: e.DB_POOL_MAX_PLATFORM,
      identityPoolMax: e.DB_POOL_MAX_IDENTITY,
    },
  });
}

/** Resumen seguro para registrar: rol/host/base, sin contraseñas ni URLs completas. */
export function describeConfig(c: AppConfig): Record<string, unknown> {
  const parts = (u: string) => {
    try {
      const x = new URL(u);
      return { role: decodeURIComponent(x.username), host: x.host, database: x.pathname.replace(/^\//, '') };
    } catch {
      return { role: '(ilegible)' };
    }
  };
  return {
    nodeEnv: c.nodeEnv,
    logLevel: c.logLevel,
    httpPort: c.httpPort,
    db: { app: parts(c.db.appUrl), platform: parts(c.db.platformUrl), identity: parts(c.db.identityUrl), appPoolMax: c.db.appPoolMax, platformPoolMax: c.db.platformPoolMax, identityPoolMax: c.db.identityPoolMax },
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
