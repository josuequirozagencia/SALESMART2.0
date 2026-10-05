/**
 * Roles de PostgreSQL (ADR-24). Se crean en el bootstrap (infra/postgres), NO en migraciones.
 *  - app_owner:    dueño de los objetos; solo migraciones. La app no se conecta con él.
 *  - app_rw:       conexión de la aplicación. NOSUPERUSER, NOBYPASSRLS, no dueño de nada.
 *  - app_platform: conexión de operaciones de plataforma; solo tablas de plataforma.
 *  - app_identity: conexión de identidad (ADR-25); solo tablas de identidad (usuarios, sesiones, organizaciones, membresías).
 */
export const DB_ROLES = { owner: 'app_owner', rw: 'app_rw', platform: 'app_platform', identity: 'app_identity' } as const;
export const APP_CONNECTION_ROLES: readonly string[] = [DB_ROLES.rw, DB_ROLES.platform, DB_ROLES.identity];

/** Atributos que NINGÚN rol de conexión de la aplicación puede tener. */
export const FORBIDDEN_ROLE_ATTRS = ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'] as const;
