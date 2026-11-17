import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { channelAccounts } from './channels';
import { conversations, messages } from './conversations';
import { contacts } from './crm';
import { tenantTable } from './helpers';
import { users } from './identity';
import { messageTemplates } from './templates';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const;
export const RECIPIENT_STATUSES = ['pending', 'queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped'] as const;
export const SKIP_REASONS = ['revoked', 'no_consent', 'no_phone', 'duplicate', 'out_of_scope', 'excluded', 'missing_variable', 'cancelled'] as const;

/**
 * Campañas masivas (v17, ADR-72). TABLA DE NEGOCIO (tenant): `organization_id` + RLS FORZADA. Un envío a muchos contactos por UNA conexión: por WhatsApp oficial con una plantilla aprobada
 * (`mode = 'template'`) o por QR con texto libre (`mode = 'text'`). `audience` guarda de DÓNDE salen los destinatarios (todos, una lista o filtros guardados, más los excluidos a mano); los
 * destinatarios reales se CONGELAN al lanzar (17.3) en `campaign_recipients`. Los contadores NO son columnas: se derivan de los destinatarios. `idempotency_key` evita crear dos veces la misma
 * campaña por un doble clic o un reintento. Borrado lógico; `app_rw` no tiene DELETE. Nunca se guarda ni se audita el texto de los mensajes de los destinatarios, solo ids, conteos y nombres de variables.
 */
export const campaigns = tenantTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    /** `template`: plantilla aprobada de WhatsApp oficial · `text`: texto libre por QR. */
    mode: text('mode').notNull(),
    templateId: uuid('template_id'),
    /** Variable de la plantilla (`body:1`, `button:0:1`…) → texto con variables del modelo de respuestas rápidas (`{{primer_nombre}}`, `{{contact.ciudad}}`). */
    templateParams: jsonb('template_params').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** El texto libre (solo `mode = 'text'`), con las mismas variables. */
    body: text('body'),
    /** De dónde salen los destinatarios: `{ source: 'all' | 'list' | 'filters', list_id?, filters?, excluded_contact_ids? }`. Validado en el servidor. */
    audience: jsonb('audience').$type<Record<string, unknown>>().notNull(),
    includeUnknownConsent: boolean('include_unknown_consent').notNull().default(false),
    status: text('status').notNull().default('draft'),
    scheduledAt: ts('scheduled_at'),
    /** Pausa entre mensajes, en segundos (mínimo 45 en QR y 5 en oficial: lo exige el servidor). */
    gapSeconds: integer('gap_seconds').notNull(),
    /** Máximo de mensajes de ESTA campaña por día. */
    dailyCap: integer('daily_cap').notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Cuándo se lanzó (se congeló la audiencia) y cuándo terminó. */
    /** Cuándo puede salir el próximo mensaje de la campaña (la pausa entre mensajes, o la espera de un tope diario alcanzado). */
    nextSendAt: ts('next_send_at'),
    launchedAt: ts('launched_at'),
    finishedAt: ts('finished_at'),
    /** Por qué quedó pausada o falló (texto fijo del sistema, sin datos de clientes). */
    statusReason: text('status_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({ name: 'campaigns_channel_fk', columns: [t['organizationId']!, t['channelAccountId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    foreignKey({ name: 'campaigns_template_fk', columns: [t['organizationId']!, t['templateId']!], foreignColumns: [messageTemplates.organizationId, messageTemplates.id] }),
    check('campaigns_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 80`),
    check('campaigns_mode_valid', sql`${t['mode']!} IN ('template', 'text')`),
    check('campaigns_status_valid', sql`${t['status']!} IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')`),
    check('campaigns_mode_content', sql`(${t['mode']!} = 'template' AND ${t['templateId']!} IS NOT NULL AND ${t['body']!} IS NULL) OR (${t['mode']!} = 'text' AND ${t['templateId']!} IS NULL AND ${t['body']!} IS NOT NULL AND length(btrim(${t['body']!})) BETWEEN 1 AND 1000)`),
    check('campaigns_params_object', sql`jsonb_typeof(${t['templateParams']!}) = 'object'`),
    check('campaigns_audience_object', sql`jsonb_typeof(${t['audience']!}) = 'object'`),
    check('campaigns_gap_valid', sql`${t['gapSeconds']!} BETWEEN 5 AND 3600`),
    check('campaigns_cap_valid', sql`${t['dailyCap']!} BETWEEN 1 AND 10000`),
    check('campaigns_key_shape', sql`length(${t['idempotencyKey']!}) BETWEEN 8 AND 100`),
    check('campaigns_reason_len', sql`${t['statusReason']!} IS NULL OR length(${t['statusReason']!}) <= 200`),
    uniqueIndex('campaigns_org_key_uq').on(t['organizationId']!, t['idempotencyKey']!),
    index('campaigns_org_idx').on(t['organizationId']!, t['createdAt']!).where(sql`${t['deletedAt']!} IS NULL`),
    index('campaigns_creator_idx').on(t['organizationId']!, t['createdBy']!, t['createdAt']!).where(sql`${t['deletedAt']!} IS NULL`),
    index('campaigns_due_idx').on(t['organizationId']!, t['status']!, t['scheduledAt']!).where(sql`${t['deletedAt']!} IS NULL AND ${t['status']!} IN ('scheduled', 'running')`),
  ],
);

/**
 * Un destinatario de una campaña, CONGELADO al lanzarla (17.3): el teléfono se guarda tal como estaba, y los cambios posteriores del contacto no mueven la campaña. `status` avanza
 * `pending → queued → sent → delivered → read → replied` (o `failed`/`skipped` con su motivo); los estados de entrega salen de los avisos de WhatsApp. Un contacto aparece una sola vez por
 * campaña. Sin DELETE. `error` es un texto fijo del sistema (nunca la respuesta cruda del proveedor).
 */
export const campaignRecipients = tenantTable(
  'campaign_recipients',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    campaignId: uuid('campaign_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    /** Teléfono E.164 al congelar la audiencia. */
    phone: text('phone'),
    status: text('status').notNull().default('pending'),
    skipReason: text('skip_reason'),
    error: text('error'),
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    queuedAt: ts('queued_at'),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    readAt: ts('read_at'),
    repliedAt: ts('replied_at'),
    failedAt: ts('failed_at'),
    /** El contacto respondió pidiendo la baja («BAJA», «STOP»…) a un mensaje de la campaña (17.5): pasó a `revoked`. */
    optedOutAt: ts('opted_out_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'campaign_recipients_campaign_fk', columns: [t['organizationId']!, t['campaignId']!], foreignColumns: [campaigns.organizationId, campaigns.id] }),
    foreignKey({ name: 'campaign_recipients_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    foreignKey({ name: 'campaign_recipients_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'campaign_recipients_message_fk', columns: [t['organizationId']!, t['messageId']!], foreignColumns: [messages.organizationId, messages.id] }),
    check('campaign_recipients_status_valid', sql`${t['status']!} IN ('pending', 'queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped')`),
    check('campaign_recipients_skip_valid', sql`(${t['status']!} = 'skipped') = (${t['skipReason']!} IS NOT NULL) AND (${t['skipReason']!} IS NULL OR ${t['skipReason']!} IN ('revoked', 'no_consent', 'no_phone', 'duplicate', 'out_of_scope', 'excluded', 'missing_variable', 'cancelled'))`),
    check('campaign_recipients_error_len', sql`${t['error']!} IS NULL OR length(${t['error']!}) <= 200`),
    uniqueIndex('campaign_recipients_contact_uq').on(t['organizationId']!, t['campaignId']!, t['contactId']!),
    index('campaign_recipients_pending_idx').on(t['organizationId']!, t['campaignId']!, t['id']!).where(sql`${t['status']!} = 'pending'`),
    index('campaign_recipients_status_idx').on(t['organizationId']!, t['campaignId']!, t['status']!),
    uniqueIndex('campaign_recipients_message_uq').on(t['organizationId']!, t['messageId']!).where(sql`${t['messageId']!} IS NOT NULL`),
    /** Para anotar la respuesta de un contacto a sus mensajes de campaña sin recorrer la campaña entera (17.5). */
    index('campaign_recipients_contact_idx').on(t['organizationId']!, t['contactId']!).where(sql`${t['messageId']!} IS NOT NULL`),
    index('campaign_recipients_queued_idx').on(t['organizationId']!, t['queuedAt']!).where(sql`${t['queuedAt']!} IS NOT NULL`),
  ],
);

/** Tope diario de mensajes de campaña de un asesor, fijado por quien administra al equipo (`users.manage`). Sin fila = sin tope propio (rige el de la conexión). */
export const campaignAdvisorLimits = tenantTable(
  'campaign_advisor_limits',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    dailyCap: integer('daily_cap').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'campaign_advisor_limits_pk', columns: [t['organizationId']!, t['userId']!] }),
    check('campaign_advisor_limits_cap_valid', sql`${t['dailyCap']!} BETWEEN 1 AND 10000`),
  ],
);

/** Tope diario de mensajes de campaña por WhatsApp oficial de la empresa (una sola fila por empresa). Sin fila rige el provisional de 1 000 (ADR-72 #5). */
export const campaignSettings = tenantTable(
  'campaign_settings',
  {
    officialDailyCap: integer('official_daily_cap').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'campaign_settings_pk', columns: [t['organizationId']!] }),
    check('campaign_settings_cap_valid', sql`${t['officialDailyCap']!} BETWEEN 1 AND 100000`),
  ],
);

