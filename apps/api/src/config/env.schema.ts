import { z } from 'zod';

/**
 * Esquema de variables de entorno de la API y los workers.
 *
 * Reglas (CLAUDE.md / Build Spec §11):
 *  - Los secretos y URLs de conexión NO tienen valor por defecto: si faltan, el proceso no arranca.
 *  - `NODE_ENV` es obligatorio (un `production` olvidado no debe degradar a `development`).
 *  - La URL del rol propietario (`DATABASE_URL_OWNER`) NO existe aquí a propósito: solo las
 *    herramientas de migración la leen (ver FORBIDDEN_RUNTIME_ENV).
 */
const postgresUrl = z
  .string()
  .min(1, 'es obligatoria')
  .refine((u) => /^postgres(ql)?:\/\//i.test(u), 'debe ser una URL postgres:// o postgresql://');

/** Suelo NO configurable de la longitud mínima de contraseña (requisito aprobado): ningún valor válido puede ser menor. */
export const PASSWORD_MIN_LENGTH_FLOOR = 8;
export const PASSWORD_MIN_LENGTH_CEILING = 128;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Puerto que inyectan plataformas como Railway. Solo se usa si no hay HTTP_PORT. */
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /**
   * Saltos de proxy de confianza delante de la API (Railway = 2, validado en staging el 2026-10-12: con 1 el límite por IP no bloqueaba). Con 0 se ignora X-Forwarded-For y
   * `req.ip` es el de la conexión. Con N>0 se toma la IP del cliente N saltos desde el final de la cadena (lo que un cliente
   * escriba al inicio de X-Forwarded-For NO cuenta). Sin esto, detrás de un proxy todos comparten IP en los límites de intentos.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL_APP: postgresUrl,
  DATABASE_URL_PLATFORM: postgresUrl,
  DATABASE_URL_IDENTITY: postgresUrl,
  /** Clave para derivar (HMAC) las claves de limitación de intentos de acceso. Obligatoria, sin valor por defecto; distinta de cualquier otra clave (Build Spec §11.2). */
  AUTH_THROTTLE_KEY: z.string().min(32, 'debe tener al menos 32 caracteres'),
  // ── Parámetros de acceso PROVISIONALES (ADR-26): los valores por defecto son una propuesta, se calibran antes de producción ──
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900), // PROVISIONAL: 15 min (Build Spec §7)
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30), // PROVISIONAL
  AUTH_SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90), // PROVISIONAL
  AUTH_ACCOUNT_LOCK_THRESHOLD: z.coerce.number().int().min(3).max(20).default(5), // PROVISIONAL: 5 (Build Spec §7)
  AUTH_IP_LOCK_THRESHOLD: z.coerce.number().int().min(5).max(500).default(25), // PROVISIONAL
  AUTH_LOCK_BASE_SECONDS: z.coerce.number().int().min(1).max(3600).default(60), // PROVISIONAL
  AUTH_LOCK_MAX_SECONDS: z.coerce.number().int().min(1).max(86400).default(3600), // PROVISIONAL
  AUTH_FAILURE_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24), // PROVISIONAL
  // ── Registro y verificación de correo (M1.2). Proveedores: NINGUNO elegido aún (decisión abierta) ──
  // 'none' = sin proveedor → el registro responde 503. 'console'/'memory'/'fake' son solo desarrollo/pruebas y se rechazan en producción.
  // 'resend' y 'turnstile' son los proveedores reales elegidos (ADR-37); 'console'/'memory'/'fake' solo desarrollo y pruebas.
  MAIL_PROVIDER: z.enum(['none', 'console', 'memory', 'resend']).default('none'),
  CAPTCHA_PROVIDER: z.enum(['none', 'fake', 'turnstile']).default('none'),
  /** Adaptador de WhatsApp (M5, ADR-50): 'meta' = Cloud API real; 'fake' es solo desarrollo y pruebas y se rechaza en producción. */
  WHATSAPP_PROVIDER: z.enum(['meta', 'fake']).default('meta'),
  /** Salida de eventos a la API de Conversiones de Meta (M6.4): `meta` = real con las credenciales de cada empresa; `none` = no enviar nada; `fake` solo para desarrollo/pruebas. */
  CAPI_PROVIDER: z.enum(['meta', 'none', 'fake']).default('meta'),
  /** GoHighLevel (M7, ADR-52): `ghl` = Private Token real con las credenciales de cada empresa; `none` = sin adaptador; `fake` solo para desarrollo/pruebas. */
  GHL_PROVIDER: z.enum(['ghl', 'none', 'fake']).default('ghl'),
  /** Adaptador de IA (M8, ADR-53): `openai` con la clave que el Súper Admin guarda en Proveedores › IA de texto; `fake` solo desarrollo y pruebas. */
  AI_PROVIDER: z.enum(['openai', 'none', 'fake']).default('openai'),
  /** Adjuntos (M5.6d, ADR-50). Almacenamiento: 's3' = el servicio S3-compatible que el Súper Admin configura en «Proveedores»; 'fake' (memoria) es solo desarrollo y pruebas y se rechaza en producción. */
  STORAGE_PROVIDER: z.enum(['s3', 'fake']).default('s3'),
  /** Antivirus: 'clamav' = clamd por TCP (CLAMAV_HOST/CLAMAV_PORT); 'none' = sin revisión (los archivos quedan «sin revisar»: solo para pruebas del piloto); 'fake' solo desarrollo y pruebas. */
  VIRUS_SCANNER: z.enum(['none', 'clamav', 'fake']).default('none'),
  CLAMAV_HOST: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'host inválido').optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  /** Conversión de audio a OGG/Opus (notas de voz de WhatsApp): 'ffmpeg' = el ejecutable FFMPEG_PATH; 'none' = no se aceptan grabaciones que no vengan ya en un formato de WhatsApp. */
  AUDIO_TRANSCODER: z.enum(['none', 'ffmpeg', 'fake']).default('none'),
  FFMPEG_PATH: z.string().min(1).max(300).default('ffmpeg'),
  /** Claves de los proveedores: sin valor por defecto, obligatorias solo si el proveedor está elegido, y sin espacios (se envían en cabeceras). */
  RESEND_API_KEY: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/, 'formato inválido').optional(),
  /** Remitente verificado en Resend: «Sales Smart <no-reply@dominio>» o solo la dirección. */
  MAIL_FROM: z.string().max(200).regex(/^(?:[^<>\r\n]{1,80} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,})$/, 'debe ser «Nombre <correo@dominio>» o «correo@dominio»').optional(),
  TURNSTILE_SECRET_KEY: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/, 'formato inválido').optional(),
  // Clave PÚBLICA de Turnstile (la que se incrusta en las páginas): la usan los formularios embebibles (M9.1). No es un secreto.
  TURNSTILE_SITE_KEY: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/, 'formato inválido').optional(),
  /**
   * Clave maestra (KEK) con la que se envuelven las claves de datos de las credenciales de los proveedores (ADR-42): EXACTAMENTE 32 bytes en base64
   * (`openssl rand -base64 32`). Opcional: sin ella la API arranca, pero guardar credenciales responde 503. Distinta de cualquier otra clave.
   * Rotación: la nueva pasa a PROVIDER_CREDENTIALS_KEY (con su versión mayor) y la anterior a ..._PREVIOUS (con la suya) mientras se re-envuelven las filas.
   */
  PROVIDER_CREDENTIALS_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/, 'debe ser una clave de 32 bytes en base64 (openssl rand -base64 32)').optional(),
  PROVIDER_CREDENTIALS_KEY_VERSION: z.coerce.number().int().min(1).max(1000).default(1),
  PROVIDER_CREDENTIALS_KEY_PREVIOUS: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/, 'debe ser una clave de 32 bytes en base64 (openssl rand -base64 32)').optional(),
  PROVIDER_CREDENTIALS_KEY_PREVIOUS_VERSION: z.coerce.number().int().min(1).max(1000).optional(),
  SIGNUP_CODE_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15), // PROVISIONAL
  SIGNUP_CODE_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5), // PROVISIONAL
  SIGNUP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(60), // PROVISIONAL
  SIGNUP_EMAIL_MAX_PER_HOUR: z.coerce.number().int().min(1).max(20).default(5), // PROVISIONAL: envíos de código por correo
  SIGNUP_IP_MAX_PER_HOUR: z.coerce.number().int().min(1).max(200).default(10), // PROVISIONAL: registros/reenvíos por IP
  SIGNUP_VERIFY_IP_MAX_PER_HOUR: z.coerce.number().int().min(5).max(500).default(30), // PROVISIONAL: intentos de verificación por IP
  SIGNUP_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(PASSWORD_MIN_LENGTH_FLOOR).max(PASSWORD_MIN_LENGTH_CEILING).default(PASSWORD_MIN_LENGTH_FLOOR), // 8 <= valor <= 128 (requisito aprobado); por defecto 8
  // ── URL del frontend para los enlaces de los correos. EXPLÍCITA: jamás se deriva del Host/Origin de la petición ──
  // Obligatoria si MAIL_PROVIDER != 'none'. Solo origen (+ prefijo de ruta opcional): sin credenciales, query ni fragmento; https en producción.
  FRONTEND_BASE_URL: z.string().min(1).max(300).optional(),
  RESET_LINK_PATH: z.string().min(1).max(100).default('/reset-password'),
  // ── Restablecimiento de contraseña (M1.3), PROVISIONALES ──
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  RESET_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  RESET_EMAIL_MAX_PER_HOUR: z.coerce.number().int().min(1).max(20).default(3),
  RESET_IP_MAX_PER_HOUR: z.coerce.number().int().min(1).max(200).default(10), // solicitudes «olvidé» por IP
  RESET_ATTEMPT_IP_MAX_PER_HOUR: z.coerce.number().int().min(5).max(500).default(30), // intentos de /reset por IP
  // ── Invitaciones al dueño de una empresa nueva (M2.3, ADR-39). PROVISIONALES ──
  INVITE_LINK_PATH: z.string().min(1).max(100).default('/accept-invite'),
  INVITATION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  INVITATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  INVITATION_ATTEMPT_IP_MAX_PER_HOUR: z.coerce.number().int().min(5).max(500).default(30), // vista previa y aceptación por IP
  // ── Tareas periódicas (M1.5, ADR-33). JOBS_ENABLED omitido = activas salvo NODE_ENV=test; 'false' las apaga (p. ej. la API cuando exista un worker aparte) ──
  JOBS_ENABLED: z.enum(['true', 'false']).optional(),
  JOBS_TRIAL_EXPIRY_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60), // PROVISIONAL
  JOBS_IDENTITY_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600), // PROVISIONAL (ADR-35)
  // ── Web servida por la API (ADR-36). Omitida = solo API (desarrollo con Vite y proxy) ──
  WEB_DIST_DIR: z.string().min(1).max(500).optional(),
  DB_POOL_MAX_APP: z.coerce.number().int().min(1).max(100).default(10),
  DB_POOL_MAX_PLATFORM: z.coerce.number().int().min(1).max(20).default(3),
  DB_POOL_MAX_IDENTITY: z.coerce.number().int().min(1).max(20).default(3),
});

export type Env = z.infer<typeof envSchema>;

/** Variables que el proceso de aplicación NO debe recibir jamás (credenciales de migración/administración). */
export const FORBIDDEN_RUNTIME_ENV: readonly string[] = ['DATABASE_URL_OWNER', 'DATABASE_URL_ADMIN'];

/** Nombres de rol que la aplicación no puede usar en sus URLs (comprobación temprana; verifyRoles es la definitiva). */
export const FORBIDDEN_RUNTIME_DB_USERS: readonly string[] = ['postgres', 'app_owner'];
