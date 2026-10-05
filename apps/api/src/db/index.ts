// API pública del módulo de datos. Es lo ÚNICO que el resto de la aplicación puede importar de db/.
export { Database, type DatabasePools } from './database';
export type { TenantTx, PlatformTx, IdentityTx } from './types';
export { tenantTable, platformTable, identityTable, users, organizations, organizationMembers, sessions, authThrottle, emailVerifications, signupAttempts, disposableDomains, passwordResets, roles, permissions, rolePermissions, auditLogs, platformAudit } from './schema';
export { LeakedTransactionError, DatabaseContextMismatchError } from './errors';
export { DB_ROLES } from './roles';
export { DbModule } from './db.module';
