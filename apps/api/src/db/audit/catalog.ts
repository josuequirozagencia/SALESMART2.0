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
  platform: ['platform_audit', 'provider_credentials', 'provider_selection', 'ai_pricing', 'ai_limits', 'ai_org_pricing', 'ai_model_prices', 'platform_branding'],
  identity: ['users', 'organizations', 'organization_members', 'sessions', 'auth_throttle', 'email_verifications', 'signup_attempts', 'disposable_domains', 'password_resets', 'roles', 'permissions', 'role_permissions', 'trials', 'trial_config', 'plans', 'invitations', 'organization_ownership_history', 'organization_deletions', 'company_exports', 'access_sessions', 'view_as_log', 'attribution_endpoints', 'ghl_routes', 'form_routes', 'qr_routes', 'member_permissions', 'member_history', 'channel_routes'],
  reference: [],
  tenantRoot: [],
  // ADR-35: limpieza de tablas de identidad sin dar DELETE a app_identity · ADR-59 (F3c): borrado definitivo de UNA empresa eliminada (negocio e identidad)
  securityDefiner: ['purge_expired_identity_rows', 'purge_company_step', 'purge_company_identity'],
};
