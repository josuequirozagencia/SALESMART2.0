import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { identityTable } from './helpers';

// Falla al cargar (no al insertar) si @sales-smart/shared está desactualizado: sin esto drizzle omitiría el id por defecto.
if (typeof uuidv7 !== 'function') throw new Error('@sales-smart/shared sin uuidv7: ejecuta `pnpm build`');

/**
 * TABLAS DE IDENTIDAD (ADR-25). Sin `organization_id`/RLS: se leen antes de que exista contexto y cruzan
 * organizaciones. Solo las toca el rol `app_identity` (vía `Database.withIdentity`, desde los módulos auth y
 * organizations). Su aislamiento entre organizaciones es lógica de aplicación + pruebas A↔B (no RLS).
 */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = identityTable(
  'users',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** Siempre normalizado (minúsculas, sin espacios): lo exige el CHECK. */
    email: text('email').notNull().unique('users_email_uq'),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: ts('email_verified_at'),
    status: text('status').notNull().default('pending'),
    /** Perfil capturado en el registro (M1.6, ADR-34). Nulo en cuentas creadas por otras vías (p. ej. el super_admin del bootstrap). */
    fullName: text('full_name'),
    /** WhatsApp del titular en E.164 (+593987654321). Lo ve el Súper Admin en la lista de pruebas para dar seguimiento. */
    phone: text('phone'),
    /** Se incrementa para invalidar TODAS las sesiones del usuario (cambio de contraseña, desactivación). */
    sessionVersion: integer('session_version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('users_email_normalized', sql`${t.email} = lower(btrim(${t.email})) AND length(${t.email}) BETWEEN 3 AND 254`),
    check('users_status_valid', sql`${t.status} IN ('pending', 'active', 'disabled')`),
    check('users_password_hash_argon2id', sql`${t.passwordHash} LIKE '$argon2id$%'`),
    check('users_full_name_len', sql`${t.fullName} IS NULL OR length(btrim(${t.fullName})) BETWEEN 2 AND 100`),
    check('users_phone_e164', sql`${t.phone} IS NULL OR ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
  ],
);

/**
 * Planes de la plataforma (M2.2, ADR-38): catálogo que administra el Súper Admin y que asigna a cada organización
 * (`organizations.plan_id`). Tabla de IDENTIDAD, no de plataforma como decía el Build Spec §4.2: asignarlo, listarlo junto a
 * las empresas y (más adelante) cargar sus módulos al autenticar ocurre con `app_identity` (mismo criterio que ADR-33).
 * Sin precios: «los precios se definen aparte» (prototipo) hasta decidir la pasarela. Un plan en uso no se archiva ni se borra.
 */
export const plans = identityTable(
  'plans',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    description: text('description'),
    /** Límites; NULL = ilimitado. Los aplican los módulos cuando existan (usuarios, conexiones, colas). */
    maxUsers: integer('max_users'),
    maxConnections: integer('max_connections'),
    maxQueues: integer('max_queues'),
    /** Módulos que el plan enciende (clave → booleano). Las claves válidas las fija el servidor (plan-features.ts). */
    features: jsonb('features').notNull().default(sql`'{}'::jsonb`),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('plans_name_len', sql`length(btrim(${t.name})) BETWEEN 2 AND 60`),
    check('plans_description_len', sql`${t.description} IS NULL OR length(${t.description}) <= 200`),
    check('plans_limits_range', sql`(${t.maxUsers} IS NULL OR ${t.maxUsers} BETWEEN 1 AND 100000) AND (${t.maxConnections} IS NULL OR ${t.maxConnections} BETWEEN 1 AND 100000) AND (${t.maxQueues} IS NULL OR ${t.maxQueues} BETWEEN 1 AND 100000)`),
    check('plans_features_object', sql`jsonb_typeof(${t.features}) = 'object'`),
    uniqueIndex('plans_name_uq').on(sql`lower(btrim(${t.name}))`),
  ],
);

export const organizations = identityTable(
  'organizations',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    kind: text('kind').notNull(),
    parentAgencyId: uuid('parent_agency_id').references((): AnyPgColumn => organizations.id),
    createdByAgencyId: uuid('created_by_agency_id').references((): AnyPgColumn => organizations.id),
    name: text('name').notNull(),
    /** Plan y estados de la prueba se definen con ADR-23 en M1; aquí solo se reservan las columnas. */
    planId: uuid('plan_id').references(() => plans.id),
    status: text('status').notNull().default('active'),
    timezone: text('timezone').notNull(),
    /** País (ISO 3166-1 alfa-2). NULL en las empresas del registro propio; el alta por invitación (M2.3, ADR-39) lo exige. */
    country: text('country'),
    /** Moneda de la empresa (ISO 4217): en ella se muestran los precios del catálogo y las ventas (M6, ADR-51). */
    currency: text('currency').notNull().default('USD'),
    /** Nivel con el que el personal de la agencia entra a ESTE cliente (M2.5, ADR-41): read | advisor | admin. Solo tiene efecto si hay `parent_agency_id`. */
    agencyAccessLevel: text('agency_access_level').notNull().default('admin'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('organizations_agency_access_level_valid', sql`${t.agencyAccessLevel} IN ('read', 'advisor', 'admin')`),
    check('organizations_currency_iso4217', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('organizations_country_iso2', sql`${t.country} IS NULL OR ${t.country} ~ '^[A-Z]{2}$'`),
    check('organizations_kind_valid',sql`${t.kind} IN ('platform', 'agency', 'client')`),
    check('organizations_platform_standalone', sql`${t.kind} <> 'platform' OR (${t.parentAgencyId} IS NULL AND ${t.createdByAgencyId} IS NULL)`),
    check('organizations_parent_only_client', sql`${t.parentAgencyId} IS NULL OR ${t.kind} = 'client'`),
    check('organizations_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('organizations_platform_no_plan', sql`${t.kind} <> 'platform' OR ${t.planId} IS NULL`),
    // Existe como máximo UNA organización de plataforma
    uniqueIndex('organizations_single_platform').on(t.kind).where(sql`${t.kind} = 'platform'`),
    index('organizations_parent_agency_idx').on(t.parentAgencyId),
  ],
);

export const organizationMembers = identityTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id').notNull().references(() => users.id),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    role: text('role').notNull(),
    accessLevel: text('access_level'),
    grantedBy: uuid('granted_by').references(() => users.id),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('organization_members_role_valid', sql`${t.role} IN ('super_admin', 'agency', 'client_admin', 'advisor')`),
    // Nivel de acceso de una agencia sobre un cliente (ADR-11; «sin acceso» = no hay membresía). NULL en el resto de roles
    check('organization_members_access_level_valid', sql`${t.accessLevel} IS NULL OR ${t.accessLevel} IN ('read', 'advisor', 'admin')`),
    // Una sola membresía ACTIVA por usuario y organización
    uniqueIndex('organization_members_active_uq').on(t.userId, t.organizationId).where(sql`${t.revokedAt} IS NULL`),
    index('organization_members_org_idx').on(t.organizationId),
    index('organization_members_user_idx').on(t.userId),
  ],
);

/**
 * Historial de quién administra a cada cliente (M2.4, ADR-22/ADR-40): una fila por cambio de `parent_agency_id`. APPEND-ONLY: app_identity
 * solo tiene SELECT/INSERT. `from`/`to` nulos = administración directa. `notify_client` registra si se avisó al administrador del cliente.
 */
export const organizationOwnershipHistory = identityTable(
  'organization_ownership_history',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    fromAgencyId: uuid('from_agency_id').references(() => organizations.id),
    toAgencyId: uuid('to_agency_id').references(() => organizations.id),
    reason: text('reason'),
    notifyClient: boolean('notify_client').notNull().default(true),
    changedBy: uuid('changed_by').notNull().references(() => users.id),
    changedAt: ts('changed_at').notNull().defaultNow(),
  },
  (t) => [
    check('ownership_history_changed', sql`${t.fromAgencyId} IS DISTINCT FROM ${t.toAgencyId}`),
    check('ownership_history_reason_len', sql`${t.reason} IS NULL OR length(btrim(${t.reason})) BETWEEN 1 AND 300`),
    index('ownership_history_org_idx').on(t.organizationId, t.changedAt),
    index('ownership_history_from_idx').on(t.fromAgencyId),
    index('ownership_history_to_idx').on(t.toAgencyId),
  ],
);

/**
 * Historial de accesos (M2.5, ADR-22/ADR-41): una fila por cada vez que un Súper Admin o una persona de agencia ENTRA al contexto de otra
 * organización. Solo la lee el Súper Admin (permiso `platform.access_log.read`; ni la agencia ni el cliente). `session_id` NO es clave foránea
 * a propósito: la limpieza de sesiones (ADR-35) no debe borrar la historia. `ended_at`/`end_reason` se escriben una sola vez (UPDATE solo de esas dos columnas).
 */
export const accessSessions = identityTable(
  'access_sessions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    sessionId: uuid('session_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
    actorRole: text('actor_role').notNull(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
    endReason: text('end_reason'),
    /** HMAC de la IP (nunca la IP en claro). */
    ipHash: text('ip_hash'),
  },
  (t) => [
    check('access_sessions_actor_role_valid', sql`${t.actorRole} IN ('super_admin', 'agency')`),
    check('access_sessions_end_reason_valid', sql`${t.endReason} IS NULL OR ${t.endReason} IN ('switch', 'return', 'access_removed', 'session_ended')`),
    check('access_sessions_end_consistent', sql`(${t.endedAt} IS NULL) = (${t.endReason} IS NULL) AND (${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt})`),
    check('access_sessions_ip_hash_hex', sql`${t.ipHash} IS NULL OR ${t.ipHash} ~ '^[0-9a-f]{64}$'`),
    index('access_sessions_org_idx').on(t.organizationId, t.startedAt),
    index('access_sessions_actor_idx').on(t.actorUserId, t.startedAt),
    index('access_sessions_started_idx').on(t.startedAt, t.id),
    // Las filas ABIERTAS de una sesión (se cierran al cambiar de contexto) y las abiertas en general (limpieza de sesiones muertas)
    index('access_sessions_open_idx').on(t.sessionId).where(sql`${t.endedAt} IS NULL`),
  ],
);

/**
 * Sesión = un inicio de sesión (dispositivo). Los tokens son opacos (`<sessionId>.<secreto>`) y aquí solo se guarda
 * su hash SHA-256. El refresh rota en cada uso; presentar un refresh que no coincide revoca la sesión (ADR-26).
 */
export const sessions = identityTable(
  'sessions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id').notNull().references(() => users.id),
    /** Organización activa de la sesión (la valida el resolvedor en cada petición contra organization_members). */
    activeOrgId: uuid('active_org_id').notNull().references(() => organizations.id),
    /** Organización con la que se inició la sesión (M2.5, ADR-41): a ella vuelve «Volver a mi agencia» y el origen de `acting_org_id`. */
    homeOrgId: uuid('home_org_id').notNull().references(() => organizations.id),
    /** Copia de users.session_version al crearla: si difiere del actual, la sesión ya no vale. */
    userSessionVersion: integer('user_session_version').notNull(),
    accessHash: text('access_hash').notNull(),
    accessExpiresAt: ts('access_expires_at').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    refreshExpiresAt: ts('refresh_expires_at').notNull(),
    /** Fin absoluto: ni rotando el refresh se extiende más allá. */
    absoluteExpiresAt: ts('absolute_expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastRefreshedAt: ts('last_refreshed_at'),
    revokedAt: ts('revoked_at'),
    revokeReason: text('revoke_reason'),
    userAgent: text('user_agent'),
  },
  (t) => [
    check('sessions_hashes_hex', sql`${t.accessHash} ~ '^[0-9a-f]{64}$' AND ${t.refreshHash} ~ '^[0-9a-f]{64}$'`),
    check('sessions_revoked_consistent', sql`(${t.revokedAt} IS NULL) = (${t.revokeReason} IS NULL)`),
    check('sessions_user_agent_len', sql`${t.userAgent} IS NULL OR length(${t.userAgent}) <= 200`),
    index('sessions_user_idx').on(t.userId),
  ],
);

/** Limitación de intentos de acceso. La clave es un HMAC (correo o IP), nunca el dato en claro. */
export const authThrottle = identityTable(
  'auth_throttle',
  {
    key: text('key').primaryKey(),
    failures: integer('failures').notNull().default(0),
    lockedUntil: ts('locked_until'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('auth_throttle_key_shape', sql`${t.key} ~ '^[ei]:[0-9a-f]{64}$'`), check('auth_throttle_failures_nonneg', sql`${t.failures} >= 0`)],
);

/**
 * Verificación de correo (M1.2). UNA fila por usuario (se reutiliza al reenviar): la tabla no crece con los reenvíos.
 * El código de 6 dígitos solo existe en claro en el correo; aquí se guarda su HMAC. La organización del registro NO se
 * crea hasta verificar: los datos pendientes viven aquí.
 */
export const emailVerifications = identityTable(
  'email_verifications',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id').notNull().references(() => users.id).unique('email_verifications_user_uq'),
    codeHmac: text('code_hmac').notNull(),
    expiresAt: ts('expires_at').notNull(),
    /** Intentos fallidos con el código vigente; al llegar al máximo el código se invalida (hay que reenviar). */
    attempts: integer('attempts').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(1),
    lastSentAt: ts('last_sent_at').notNull().defaultNow(),
    pendingOrgName: text('pending_org_name').notNull(),
    pendingTimezone: text('pending_timezone').notNull(),
    consumedAt: ts('consumed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('email_verifications_code_hmac_hex', sql`${t.codeHmac} ~ '^[0-9a-f]{64}$'`),
    check('email_verifications_attempts_nonneg', sql`${t.attempts} >= 0`),
    check('email_verifications_org_name_len', sql`length(btrim(${t.pendingOrgName})) BETWEEN 2 AND 100`),
  ],
);

/** Contadores de ventana fija para el registro (por IP y por correo, siempre HMAC). */
export const signupAttempts = identityTable(
  'signup_attempts',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    windowStartedAt: ts('window_started_at').notNull().defaultNow(),
  },
  (t) => [check('signup_attempts_key_shape', sql`${t.key} ~ '^[svmfrxi]:[0-9a-f]{64}$'`), check('signup_attempts_count_nonneg', sql`${t.count} >= 0`)],
);

/** Dominios de correo desechable rechazados en el registro. Lista global gestionada por operación (fuente de la lista: pendiente de decisión). */
export const disposableDomains = identityTable(
  'disposable_domains',
  {
    domain: text('domain').primaryKey(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('disposable_domains_normalized', sql`${t.domain} = lower(btrim(${t.domain})) AND ${t.domain} ~ '^[a-z0-9.-]+$'`)],
);

/**
 * Restablecimiento de contraseña (M1.3). UNA fila por usuario (se reutiliza). Token opaco `<id>.<secreto>` enviado por
 * correo; aquí solo su SHA-256. De un solo uso, con caducidad.
 */
export const passwordResets = identityTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id').notNull().references(() => users.id).unique('password_resets_user_uq'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    sentCount: integer('sent_count').notNull().default(1),
    lastSentAt: ts('last_sent_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('password_resets_token_hash_hex', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`)],
);

/**
 * Invitaciones a una organización (M2.3, ADR-39). UNA fila por (organización, correo): reenviar reemplaza el id y el token
 * (el enlace anterior deja de existir). Token opaco `<id>.<secreto>` enviado por correo (en el fragmento del enlace); aquí solo su
 * SHA-256. De un solo uso, con caducidad. `consumed_at` + `accepted_user_id` son el registro de la aceptación.
 */
export const invitations = identityTable(
  'invitations',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    /** Siempre normalizado (minúsculas, sin espacios). */
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    acceptedUserId: uuid('accepted_user_id').references(() => users.id),
    invitedBy: uuid('invited_by').notNull().references(() => users.id),
    sentCount: integer('sent_count').notNull().default(1),
    lastSentAt: ts('last_sent_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('invitations_email_normalized', sql`${t.email} = lower(btrim(${t.email})) AND length(${t.email}) BETWEEN 3 AND 254`),
    check('invitations_role_valid', sql`${t.role} IN ('client_admin', 'advisor', 'agency')`),
    check('invitations_token_hash_hex', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('invitations_consumed_consistent', sql`(${t.consumedAt} IS NULL) = (${t.acceptedUserId} IS NULL)`),
    uniqueIndex('invitations_org_email_uq').on(t.organizationId, t.email),
    index('invitations_email_idx').on(t.email),
  ],
);

/**
 * RBAC (M1.4): datos de referencia GLOBALES (sin datos de clientes). Tablas de identidad: las lee solo app_identity
 * (el resolvedor de acceso carga los permisos del rol al autenticar). Se modifican únicamente por migración.
 * `roles` refleja los 4 roles de sistema (organization_members.role); los roles personalizados por organización son V1.
 */
export const roles = identityTable(
  'roles',
  { key: text('key').primaryKey(), scope: text('scope').notNull(), description: text('description').notNull() },
  (t) => [check('roles_scope_valid', sql`${t.scope} IN ('platform', 'tenant')`)],
);

export const permissions = identityTable(
  'permissions',
  { key: text('key').primaryKey(), scope: text('scope').notNull(), description: text('description').notNull() },
  (t) => [check('permissions_scope_valid', sql`${t.scope} IN ('platform', 'tenant')`), check('permissions_key_shape', sql`${t.key} ~ '^[a-z][a-z_]*(\\.[a-z_]+)*$'`)],
);

export const rolePermissions = identityTable(
  'role_permissions',
  {
    roleKey: text('role_key').notNull().references(() => roles.key),
    permissionKey: text('permission_key').notNull().references(() => permissions.key),
  },
  (t) => [uniqueIndex('role_permissions_uq').on(t.roleKey, t.permissionKey)],
);

/**
 * Parámetros de la prueba gratuita (ADR-23, ADR-33). UNA sola fila (CHECK de singleton) sembrada por la migración con
 * valores PROVISIONALES; nunca viven en código. Es tabla de identidad (no de plataforma) porque el ciclo de vida de la
 * prueba se ejecuta con `app_identity` (alta al verificar el correo, evaluación en cada petición, vencimiento): ver ADR-33.
 * app_identity solo la LEE; se cambia por migración o con el rol propietario.
 */
export const trialConfig = identityTable(
  'trial_config',
  {
    id: boolean('id').primaryKey().default(true),
    days: integer('days').notNull(),
    extensionDays: integer('extension_days').notNull(),
    retentionDays: integer('retention_days').notNull(),
    /** Créditos IA de bienvenida (ADR-23 #7). Inerte hasta M8 (libro de créditos); se guarda aquí para no hardcodearlo. */
    welcomeCredits: integer('welcome_credits').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('trial_config_singleton', sql`${t.id} = true`),
    check('trial_config_ranges', sql`${t.days} BETWEEN 1 AND 90 AND ${t.extensionDays} BETWEEN 1 AND 30 AND ${t.retentionDays} BETWEEN 1 AND 365 AND ${t.welcomeCredits} >= 0`),
  ],
);

/**
 * Prueba gratuita de una organización cliente (M1.5, ADR-23/ADR-33). Una fila por organización; la extensión es UNA
 * sola por cuenta: la modela la propia fila (`ext_status`), el CHECK exige estados coherentes y el trigger
 * `trials_ext_transition` impide cualquier transición distinta de none → pending → approved|denied.
 * `ends_at` es el fin vigente. El acceso se decide por la HORA (ends_at), no por `status`: `status` solo lo materializa
 * el job de vencimiento, así que un job caído nunca deja una cuenta vencida con acceso.
 */
export const trials = identityTable(
  'trials',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id).unique('trials_org_uq'),
    ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
    startedAt: ts('started_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    status: text('status').notNull().default('active'),
    expiredAt: ts('expired_at'),
    extStatus: text('ext_status').notNull().default('none'),
    extReason: text('ext_reason'),
    extRequestedAt: ts('ext_requested_at'),
    extDecidedBy: uuid('ext_decided_by').references(() => users.id),
    extDecidedAt: ts('ext_decided_at'),
    extDaysGranted: integer('ext_days_granted'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('trials_status_valid', sql`${t.status} IN ('active', 'expired')`),
    check('trials_expired_consistent', sql`(${t.status} = 'expired') = (${t.expiredAt} IS NOT NULL)`),
    check('trials_period_valid', sql`${t.endsAt} > ${t.startedAt}`),
    check('trials_ext_status_valid', sql`${t.extStatus} IN ('none', 'pending', 'approved', 'denied')`),
    check('trials_ext_reason_len', sql`${t.extReason} IS NULL OR length(btrim(${t.extReason})) BETWEEN 10 AND 500`),
    // Estados coherentes de la extensión (una sola por cuenta)
    check(
      'trials_ext_consistent',
      sql`(${t.extStatus} = 'none' AND ${t.extReason} IS NULL AND ${t.extRequestedAt} IS NULL AND ${t.extDecidedBy} IS NULL AND ${t.extDecidedAt} IS NULL AND ${t.extDaysGranted} IS NULL)
        OR (${t.extStatus} = 'pending' AND ${t.extReason} IS NOT NULL AND ${t.extRequestedAt} IS NOT NULL AND ${t.extDecidedBy} IS NULL AND ${t.extDecidedAt} IS NULL AND ${t.extDaysGranted} IS NULL)
        OR (${t.extStatus} = 'approved' AND ${t.extReason} IS NOT NULL AND ${t.extRequestedAt} IS NOT NULL AND ${t.extDecidedBy} IS NOT NULL AND ${t.extDecidedAt} IS NOT NULL AND ${t.extDaysGranted} > 0)
        OR (${t.extStatus} = 'denied' AND ${t.extReason} IS NOT NULL AND ${t.extRequestedAt} IS NOT NULL AND ${t.extDecidedBy} IS NOT NULL AND ${t.extDecidedAt} IS NOT NULL AND ${t.extDaysGranted} IS NULL)`,
    ),
    index('trials_ends_active_idx').on(t.endsAt).where(sql`${t.status} = 'active'`),
    index('trials_ext_pending_idx').on(t.extRequestedAt).where(sql`${t.extStatus} = 'pending'`),
  ],
);

/**
 * Punto de entrada de atribución de una empresa (M3.3, ADR-45). Tabla de IDENTIDAD: el webhook llega SIN sesión y hay que resolver la empresa a partir
 * del identificador opaco de la URL (un v4 aleatorio, no secuencial) antes de que exista contexto de organización. Una fila por empresa (regenerar reemplaza
 * el secreto). El secreto solo se guarda como hash SHA-256 y se muestra una vez.
 */
export const attributionEndpoints = identityTable(
  'attribution_endpoints',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    secretHash: text('secret_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    rotatedAt: ts('rotated_at'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    check('attribution_endpoints_secret_hash_hex', sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('attribution_endpoints_org_uq').on(t.organizationId),
  ],
);

/**
 * Punto de entrada del webhook de GoHighLevel de una empresa (M7.1, ADR-52). Igual que `attribution_endpoints`: tabla de IDENTIDAD porque el Workflow de GHL llega SIN sesión y hay
 * que saber de qué empresa es antes de que exista contexto. Identificador opaco (v4 aleatorio) en la URL; una fila por empresa (rotar reemplaza el secreto); el secreto solo se guarda
 * como hash SHA-256 y se muestra una vez.
 */
export const ghlRoutes = identityTable(
  'ghl_routes',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    secretHash: text('secret_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    rotatedAt: ts('rotated_at'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    check('ghl_routes_secret_hash_hex', sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('ghl_routes_org_uq').on(t.organizationId),
  ],
);

/**
 * Punto de entrada PÚBLICO de cada formulario (M9.1, ADR-09/54). Tabla de IDENTIDAD: el visitante de una landing llega sin sesión y hay que saber de qué empresa y formulario es antes de que exista
 * contexto. El identificador es un UUID v4 aleatorio (el «token» de la URL: solo permite ENVIAR; nada se lee con él). Una fila por formulario; el formulario mismo (estado, campos, destino) vive en `forms`.
 */
export const formRoutes = identityTable(
  'form_routes',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    formId: uuid('form_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('form_routes_form_uq').on(t.organizationId, t.formId)],
);

/**
 * Punto de entrada del webhook de una conexión de WhatsApp por QR (M9.6, ADR-54/ADR-31). Tabla de IDENTIDAD: Evolution API avisa SIN sesión y hay que saber de qué empresa y conexión es antes de
 * que exista contexto. Identificador opaco (v4 aleatorio) en la URL + token que solo se guarda como hash SHA-256 y se entrega a Evolution UNA vez (al crear la instancia o rotarlo). Una fila por conexión.
 */
export const qrRoutes = identityTable(
  'qr_routes',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    channelAccountId: uuid('channel_account_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    rotatedAt: ts('rotated_at'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    check('qr_routes_token_hash_hex', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('qr_routes_channel_uq').on(t.organizationId, t.channelAccountId),
  ],
);
