// Los parámetros PROVISIONALES de duración y bloqueo (ADR-26) viven en la configuración validada (`cfg.auth`,
// variables AUTH_*), con sus valores por defecto en config/env.schema.ts. Aquí solo quedan constantes de protocolo.
export const REFRESH_COOKIE = 'ss_refresh';
/** La cookie solo viaja a los endpoints de acceso versionados. */
export const REFRESH_COOKIE_PATH = '/v1/auth';
export const CSRF_HEADER = 'x-requested-by';
export const CSRF_VALUE = 'sales-smart-web';
