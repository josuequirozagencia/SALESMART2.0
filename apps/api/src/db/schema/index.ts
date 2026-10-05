// Esquema de producción. En M0 (bloque 2) NO hay tablas de negocio: se añaden con sus módulos.
// Toda tabla se declara con tenantTable() / platformTable() (helpers.ts) y se registra en db/audit/catalog.ts.
export { tenantTable, platformTable, identityTable } from './helpers';
export { users, organizations, organizationMembers, sessions, authThrottle, emailVerifications, signupAttempts, disposableDomains, passwordResets, roles, permissions, rolePermissions } from './identity';
export { auditLogs, platformAudit } from './audit';
