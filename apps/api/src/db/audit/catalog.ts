/**
 * Clasificación explícita de tablas que NO son "tenant" estándar. Toda tabla del esquema `public` debe estar
 * aquí o tener columna `organization_id` (tabla tenant). Una tabla sin clasificar hace fallar `db:audit`.
 */
export interface TableCatalog {
  /** Tablas de plataforma: GRANT solo a app_platform; app_rw sin acceso. */
  readonly platform: readonly string[];
  /** Tablas de referencia globales de solo lectura para app_rw (sin datos de clientes). */
  readonly reference: readonly string[];
  /** Tablas de IDENTIDAD (ADR-25): GRANT solo a app_identity; app_rw y app_platform sin acceso; sin RLS por organización. */
  readonly identity: readonly string[];
  /** Raíz de tenant (p. ej. organizations): la clave de aislamiento es `id`, política `id = app_org()`. */
  readonly tenantRoot: readonly string[];
  /** Funciones SECURITY DEFINER revisadas y aprobadas por ADR. */
  readonly securityDefiner: readonly string[];
}

export const PRODUCTION_CATALOG: TableCatalog = {
  platform: ['platform_audit'],
  identity: ['users', 'organizations', 'organization_members', 'sessions', 'auth_throttle', 'email_verifications', 'signup_attempts', 'disposable_domains', 'password_resets', 'roles', 'permissions', 'role_permissions'],
  reference: [],
  tenantRoot: [],
  securityDefiner: [],
};
