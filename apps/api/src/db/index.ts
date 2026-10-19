// API pública del módulo de datos. Es lo ÚNICO que el resto de la aplicación puede importar de db/.
export { Database, type DatabasePools } from './database';
export type { TenantTx, PlatformTx, IdentityTx } from './types';
export { tenantTable, platformTable, identityTable, users, organizations, organizationMembers, sessions, authThrottle, emailVerifications, signupAttempts, disposableDomains, passwordResets, roles, permissions, rolePermissions, trials, trialConfig, plans, invitations, organizationOwnershipHistory, accessSessions, auditLogs, platformAudit, providerCredentials, providerSelection, contacts, contactPhones, tags, contactTags, metaEvents, contactLists, contactListMembers, contactImports, contactImportRows, companies, contactCompanies, notes, tasks, pipelines, pipelineStages, opportunities, stageHistory, channelAccounts, whatsappAccounts, channelRoutes, webhookEvents, conversations, conversationParticipants, messages, queues, queueMembers, queueDistributionState, slaPolicies, businessHours, holidays, responseTimers, attributionEndpoints, customFieldDefinitions, customFieldValues } from './schema';
export { LeakedTransactionError, DatabaseContextMismatchError } from './errors';
export { DB_ROLES } from './roles';
export { DbModule } from './db.module';
