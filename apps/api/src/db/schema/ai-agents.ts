import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, numeric, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { channelAccounts } from './channels';
import { tenantTable } from './helpers';
import { users } from './identity';
import { knowledgeDocuments } from './ai-knowledge';
import { queues } from './queues';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Agente de IA de la empresa (M8.3, ADR-20/53). Su personalidad, objetivo e información adicional van en TRES bloques de texto con variables `{{…}}`; el modelo se elige de la lista de la plataforma
 * (`ai_model_prices`, validado al guardar). `active` decide si puede responder (M8.5); un agente nuevo nace apagado. Los ajustes de comportamiento (dividir respuestas, transferir a una persona,
 * 24/7) se guardan aquí y se aplican cuando el agente responde en vivo. Borrado lógico; el nombre es único entre los vigentes de la empresa.
 */
export const agents = tenantTable(
  'agents',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    /** Qué hace el agente, en una línea («Asesora de ventas de cursos»). */
    role: text('role'),
    /** Clave de la foto en el almacenamiento privado (`org/<empresa>/agents/<id>/<uuid>`); se entrega con URL firmada. */
    photoKey: text('photo_key'),
    /** Color de portada de la tarjeta: una clave de la paleta fija. */
    cover: text('cover').notNull().default('violet'),
    active: boolean('active').notNull().default(false),
    model: text('model').notNull(),
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('0.30'),
    maxTokens: integer('max_tokens').notNull().default(500),
    /** Largo máximo (en caracteres) de cada respuesta al cliente. */
    maxChars: integer('max_chars').notNull().default(800),
    personality: text('personality').notNull().default(''),
    objective: text('objective').notNull().default(''),
    extraInfo: text('extra_info').notNull().default(''),
    /** Al responder con datos de un documento, mencionar de cuál salió. */
    showSource: boolean('show_source').notNull().default(false),
    splitEnabled: boolean('split_enabled').notNull().default(false),
    splitBlocks: integer('split_blocks').notNull().default(2),
    transferEnabled: boolean('transfer_enabled').notNull().default(true),
    /** Cola a la que pasa la conversación cuando el agente transfiere; sin cola, la de la conexión. */
    transferQueueId: uuid('transfer_queue_id'),
    /** Responde a toda hora (sin respetar el horario de la cola). */
    alwaysOn: boolean('always_on').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({ name: 'agents_transfer_queue_fk', columns: [t['organizationId']!, t['transferQueueId']!], foreignColumns: [queues.organizationId, queues.id] }),
    check('agents_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 60`),
    check('agents_role_len', sql`${t['role']!} IS NULL OR length(${t['role']!}) <= 120`),
    check('agents_cover_valid', sql`${t['cover']!} IN ('violet', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'slate')`),
    check('agents_model_shape', sql`${t['model']!} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'`),
    check('agents_temperature_valid', sql`${t['temperature']!} >= 0 AND ${t['temperature']!} <= 1.5`),
    check('agents_max_tokens_valid', sql`${t['maxTokens']!} BETWEEN 100 AND 2000`),
    check('agents_max_chars_valid', sql`${t['maxChars']!} BETWEEN 100 AND 4000`),
    check('agents_blocks_valid', sql`${t['splitBlocks']!} BETWEEN 1 AND 5`),
    check('agents_texts_len', sql`length(${t['personality']!}) <= 4000 AND length(${t['objective']!}) <= 4000 AND length(${t['extraInfo']!}) <= 8000`),
    uniqueIndex('agents_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
    index('agents_list_idx').on(t['organizationId']!, t['createdAt']!, t['id']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/** Documentos de la biblioteca que un agente puede usar (M8.3, ADR-20). Siempre de la MISMA empresa (claves foráneas compuestas). Se borran y se vuelven a escribir al cambiar la selección. */
export const agentDocuments = tenantTable(
  'agent_documents',
  {
    agentId: uuid('agent_id').notNull(),
    documentId: uuid('document_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t['organizationId']!, t['agentId']!, t['documentId']!], name: 'agent_documents_pk' }),
    foreignKey({ name: 'agent_documents_agent_fk', columns: [t['organizationId']!, t['agentId']!], foreignColumns: [agents.organizationId, agents.id] }),
    foreignKey({ name: 'agent_documents_document_fk', columns: [t['organizationId']!, t['documentId']!], foreignColumns: [knowledgeDocuments.organizationId, knowledgeDocuments.id] }),
    index('agent_documents_document_idx').on(t['organizationId']!, t['documentId']!),
  ],
);

/** Conexiones donde responde un agente (M8.3, ADR-20). **Una conexión usa como máximo UN agente** (índice único por conexión). */
export const agentChannels = tenantTable(
  'agent_channels',
  {
    agentId: uuid('agent_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t['organizationId']!, t['agentId']!, t['channelId']!], name: 'agent_channels_pk' }),
    foreignKey({ name: 'agent_channels_agent_fk', columns: [t['organizationId']!, t['agentId']!], foreignColumns: [agents.organizationId, agents.id] }),
    foreignKey({ name: 'agent_channels_channel_fk', columns: [t['organizationId']!, t['channelId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    uniqueIndex('agent_channels_channel_uq').on(t['organizationId']!, t['channelId']!),
  ],
);
