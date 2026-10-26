// Esquema de producción. En M0 (bloque 2) NO hay tablas de negocio: se añaden con sus módulos.
// Toda tabla se declara con tenantTable() / platformTable() (helpers.ts) y se registra en db/audit/catalog.ts.
export { tenantTable, platformTable, identityTable } from './helpers';
export { users, organizations, organizationMembers, sessions, authThrottle, emailVerifications, signupAttempts, disposableDomains, passwordResets, roles, permissions, rolePermissions, trials, trialConfig, plans, invitations, organizationOwnershipHistory, accessSessions, attributionEndpoints, ghlRoutes } from './identity';
export { auditLogs, platformAudit } from './audit';
export { providerCredentials, providerSelection } from './providers';
export { contacts, contactPhones, tags, contactTags, metaEvents, contactLists, contactListMembers, contactImports, contactImportRows, companies, contactCompanies, notes, tasks } from './crm';
export { customFieldDefinitions, customFieldValues } from './custom-fields';
export { pipelines, pipelineStages, opportunities, stageHistory } from './pipelines';
export { channelAccounts, whatsappAccounts, channelRoutes } from './channels';
export { webhookEvents, conversations, messages, conversationParticipants } from './conversations';
export { messageTemplates } from './templates';
export { quickReplies } from './quick-replies';
export { scheduledMessages } from './scheduled-messages';
export { messageAttachments } from './attachments';
export { queues, queueMembers, queueDistributionState, queueProducts } from './queues';
export { sales, salePayments, saleStatusHistory, saleChangeRequests } from './sales';
export { appointments, appointmentReminders } from './appointments';
export { metaSettings } from './meta';
export { analyticsSettings, analyticsExports } from './analytics';
export { ghlConnections } from './ghl';
export { ghlEvents, ghlContactLinks, ghlOutbox, ghlEnrollments } from './ghl-events';
export { slaPolicies, businessHours, holidays, responseTimers } from './sla';
export { aiWallets, aiLedger, aiHolds, aiPricing, aiOrgPricing } from './ai';
export { knowledgeDocuments, documentChunks, aiModelPrices } from './ai-knowledge';
