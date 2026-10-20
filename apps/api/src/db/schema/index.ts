// Esquema de producción. En M0 (bloque 2) NO hay tablas de negocio: se añaden con sus módulos.
// Toda tabla se declara con tenantTable() / platformTable() (helpers.ts) y se registra en db/audit/catalog.ts.
export { tenantTable, platformTable, identityTable } from './helpers';
export { users, organizations, organizationMembers, sessions, authThrottle, emailVerifications, signupAttempts, disposableDomains, passwordResets, roles, permissions, rolePermissions, trials, trialConfig, plans, invitations, organizationOwnershipHistory, accessSessions, attributionEndpoints } from './identity';
export { auditLogs, platformAudit } from './audit';
export { providerCredentials, providerSelection } from './providers';
export { contacts, contactPhones, tags, contactTags, metaEvents, contactLists, contactListMembers, contactImports, contactImportRows, companies, contactCompanies, notes, tasks } from './crm';
export { customFieldDefinitions, customFieldValues } from './custom-fields';
export { pipelines, pipelineStages, opportunities, stageHistory } from './pipelines';
export { channelAccounts, whatsappAccounts, channelRoutes } from './channels';
export { webhookEvents, conversations, messages, conversationParticipants } from './conversations';
export { messageTemplates } from './templates';
export { queues, queueMembers, queueDistributionState } from './queues';
export { slaPolicies, businessHours, holidays, responseTimers } from './sla';
