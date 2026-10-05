import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
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
    planId: uuid('plan_id'),
    status: text('status').notNull().default('active'),
    timezone: text('timezone').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('organizations_kind_valid', sql`${t.kind} IN ('platform', 'agency', 'client')`),
    check('organizations_platform_standalone', sql`${t.kind} <> 'platform' OR (${t.parentAgencyId} IS NULL AND ${t.createdByAgencyId} IS NULL)`),
    check('organizations_parent_only_client', sql`${t.parentAgencyId} IS NULL OR ${t.kind} = 'client'`),
    check('organizations_name_not_blank', sql`length(btrim(${t.name})) > 0`),
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
    // Una sola membresía ACTIVA por usuario y organización
    uniqueIndex('organization_members_active_uq').on(t.userId, t.organizationId).where(sql`${t.revokedAt} IS NULL`),
    index('organization_members_org_idx').on(t.organizationId),
    index('organization_members_user_idx').on(t.userId),
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
  (t) => [check('signup_attempts_key_shape', sql`${t.key} ~ '^[svmfrx]:[0-9a-f]{64}$'`), check('signup_attempts_count_nonneg', sql`${t.count} >= 0`)],
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
