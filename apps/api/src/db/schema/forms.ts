import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { channelAccounts } from './channels';
import { messageTemplates } from './templates';
import { contacts, tags } from './crm';
import { tenantTable } from './helpers';
import { users } from './identity';
import { pipelineStages, pipelines } from './pipelines';
import { queues } from './queues';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Formulario embebible de la empresa (M9.1, ADR-09/54; F07). `draft` (se arma) → `published` (recibe envíos) ⇄ `paused`. El destino de cada envío: `queue_id` (reparte al responsable con la regla de la cola),
 * `pipeline_id`/`stage_id` (la oportunidad que se abre; sin etapa, la primera abierta) y `extra_tag_id` (una etiqueta personalizada además de «Lead»). `allowed_domains`: dominios desde los que se acepta el
 * envío (comprobación de `Origin`; vacío = ninguno). `phone_prefix`: prefijo para teléfonos escritos sin código de país. El token público vive en la tabla de identidad `form_routes`. Borrado lógico.
 */
export const forms = tenantTable(
  'forms',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'),
    queueId: uuid('queue_id'),
    pipelineId: uuid('pipeline_id'),
    stageId: uuid('stage_id'),
    extraTagId: uuid('extra_tag_id'),
    consentText: text('consent_text').notNull().default('Acepto que me contacten por WhatsApp y por teléfono para atender mi solicitud.'),
    thanksMessage: text('thanks_message').notNull().default('¡Gracias! Recibimos tus datos y te contactaremos en breve.'),
    redirectUrl: text('redirect_url'),
    allowedDomains: text('allowed_domains').array().notNull().default(sql`'{}'::text[]`),
    phonePrefix: text('phone_prefix').notNull().default('+593'),
    /** Seguimiento (M9.2): una tarea para el responsable del lead (también es el aviso y el plan B si no puede salir la plantilla). */
    followUpTask: boolean('follow_up_task').notNull().default(true),
    /** Seguimiento por WhatsApp: la conexión y la plantilla aprobada que se le envían al lead; ambas o ninguna. */
    followUpChannelId: uuid('follow_up_channel_id'),
    followUpTemplateId: uuid('follow_up_template_id'),
    /** Valores de las variables de la plantilla: texto con `{{nombre}}`, `{{primer_nombre}}` o `{{formulario}}`. */
    followUpParams: jsonb('follow_up_params').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({ name: 'forms_queue_fk', columns: [t['organizationId']!, t['queueId']!], foreignColumns: [queues.organizationId, queues.id] }),
    foreignKey({ name: 'forms_pipeline_fk', columns: [t['organizationId']!, t['pipelineId']!], foreignColumns: [pipelines.organizationId, pipelines.id] }),
    foreignKey({ name: 'forms_stage_fk', columns: [t['organizationId']!, t['pipelineId']!, t['stageId']!], foreignColumns: [pipelineStages.organizationId, pipelineStages.pipelineId, pipelineStages.id] }),
    foreignKey({ name: 'forms_follow_up_channel_fk', columns: [t['organizationId']!, t['followUpChannelId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    foreignKey({ name: 'forms_follow_up_template_fk', columns: [t['organizationId']!, t['followUpTemplateId']!], foreignColumns: [messageTemplates.organizationId, messageTemplates.id] }),
    check('forms_follow_up_pair', sql`(${t['followUpChannelId']!} IS NULL) = (${t['followUpTemplateId']!} IS NULL)`),
    check('forms_follow_up_params_shape', sql`jsonb_typeof(${t['followUpParams']!}) = 'object' AND length(${t['followUpParams']!}::text) <= 4000`),
    foreignKey({ name: 'forms_extra_tag_fk', columns: [t['organizationId']!, t['extraTagId']!], foreignColumns: [tags.organizationId, tags.id] }),
    check('forms_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 80`),
    check('forms_description_len', sql`${t['description']!} IS NULL OR length(${t['description']!}) <= 300`),
    check('forms_status_valid', sql`${t['status']!} IN ('draft', 'published', 'paused')`),
    check('forms_stage_needs_pipeline', sql`${t['stageId']!} IS NULL OR ${t['pipelineId']!} IS NOT NULL`),
    check('forms_consent_len', sql`length(btrim(${t['consentText']!})) BETWEEN 10 AND 500`),
    check('forms_thanks_len', sql`length(btrim(${t['thanksMessage']!})) BETWEEN 1 AND 300`),
    check('forms_redirect_https', sql`${t['redirectUrl']!} IS NULL OR (${t['redirectUrl']!} ~ '^https://[^\\s]+$' AND length(${t['redirectUrl']!}) <= 500)`),
    check('forms_domains_valid', sql`cardinality(${t['allowedDomains']!}) <= 20`),
    check('forms_prefix_shape', sql`${t['phonePrefix']!} ~ '^\\+[1-9][0-9]{0,3}$'`),
    uniqueIndex('forms_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
    index('forms_list_idx').on(t['organizationId']!, t['createdAt']!, t['id']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Campos de un formulario, en orden. `key` es el nombre estable con el que viaja el valor (único en el formulario); `maps_to` dice dónde se guarda: `name`, `phone`, `email`, `custom:<variable>` (campo
 * personalizado del contacto) o `note` (solo queda en el envío). El servidor exige exactamente un `name` y un `phone` obligatorios (un lead sin WhatsApp no sirve) y a lo sumo uno de `email`.
 */
export const formFields = tenantTable(
  'form_fields',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    formId: uuid('form_id').notNull(),
    position: integer('position').notNull(),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    mapsTo: text('maps_to').notNull(),
    required: boolean('required').notNull().default(false),
    options: text('options').array(),
    placeholder: text('placeholder'),
  },
  (t) => [
    foreignKey({ name: 'form_fields_form_fk', columns: [t['organizationId']!, t['formId']!], foreignColumns: [forms.organizationId, forms.id] }),
    check('form_fields_key_shape', sql`${t['key']!} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check('form_fields_kind_valid', sql`${t['kind']!} IN ('text', 'long_text', 'email', 'phone', 'number', 'select')`),
    check('form_fields_label_len', sql`length(btrim(${t['label']!})) BETWEEN 1 AND 100`),
    check('form_fields_maps_to_valid', sql`${t['mapsTo']!} ~ '^(name|phone|email|note|custom:[a-z][a-z0-9_]{0,39})$'`),
    check('form_fields_placeholder_len', sql`${t['placeholder']!} IS NULL OR length(${t['placeholder']!}) <= 100`),
    check('form_fields_options_by_kind', sql`(${t['kind']!} = 'select') = (${t['options']!} IS NOT NULL AND cardinality(${t['options']!}) BETWEEN 1 AND 30)`),
    check('form_fields_position_valid', sql`${t['position']!} BETWEEN 0 AND 29`),
    uniqueIndex('form_fields_key_uq').on(t['organizationId']!, t['formId']!, t['key']!),
    uniqueIndex('form_fields_position_uq').on(t['organizationId']!, t['formId']!, t['position']!),
  ],
);

/**
 * Cada envío recibido (M9.1). **Solo inserción**: es la evidencia de qué mandó quién y desde dónde. `idempotency_key` (único por formulario) hace que un reintento devuelva el mismo resultado sin
 * duplicar nada. `payload` lleva solo los valores que el servidor validó (por clave de campo); `utm` los parámetros de campaña y `fbclid`; `ip_hash` es la huella de la IP (nunca la IP).
 * `event_id` es el identificador del evento Lead enviado a Meta (el mismo que usa el Pixel de la página para deduplicar).
 */
export const formSubmissions = tenantTable(
  'form_submissions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    formId: uuid('form_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    utm: jsonb('utm').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    sourceUrl: text('source_url'),
    ipHash: text('ip_hash'),
    eventId: text('event_id').notNull(),
    contactCreated: boolean('contact_created').notNull().default(false),
    /** Qué seguimiento se hizo con este envío: `template` (plantilla en cola), `task` (tarea para el responsable), ambos o ninguno. */
    followUp: text('follow_up').notNull().default('none'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'form_submissions_form_fk', columns: [t['organizationId']!, t['formId']!], foreignColumns: [forms.organizationId, forms.id] }),
    foreignKey({ name: 'form_submissions_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('form_submissions_follow_up_valid', sql`${t['followUp']!} IN ('none', 'task', 'template', 'template_task')`),
    check('form_submissions_key_len', sql`length(${t['idempotencyKey']!}) BETWEEN 8 AND 100`),
    check('form_submissions_source_len', sql`${t['sourceUrl']!} IS NULL OR length(${t['sourceUrl']!}) <= 500`),
    uniqueIndex('form_submissions_idem_uq').on(t['organizationId']!, t['formId']!, t['idempotencyKey']!),
    index('form_submissions_form_idx').on(t['organizationId']!, t['formId']!, t['createdAt']!),
    index('form_submissions_contact_idx').on(t['organizationId']!, t['contactId']!),
  ],
);
