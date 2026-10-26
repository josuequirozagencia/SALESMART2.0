import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { agents } from './ai-agents';
import { contacts } from './crm';
import { conversations } from './conversations';
import { tenantTable } from './helpers';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Estado del agente de IA en UNA conversación (M8.5, ADR-53): una fila por conversación que el agente llegó a atender. `active` = responde; `paused` = una persona o un problema lo detuvo y SOLO una persona
 * lo reanuda; `handed_off` = pasó la conversación a una persona. `handled_until` es la hora del último mensaje del cliente que ya se atendió (nada se contesta dos veces); `resumed_at`, cuándo una persona lo
 * reanudó (los mensajes humanos anteriores ya no lo pausan); `version` sube con cada cambio de estado. La tarea toma la fila con `processing_started_at` (arrendamiento) y reintenta con `next_attempt_at`.
 */
export const aiConversationState = tenantTable(
  'ai_conversation_state',
  {
    conversationId: uuid('conversation_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    status: text('status').notNull().default('active'),
    reason: text('reason'),
    version: integer('version').notNull().default(1),
    resumedAt: ts('resumed_at'),
    handledUntil: ts('handled_until'),
    /** Respuestas del agente desde la última vez que una persona intervino (límite contra bucles). */
    turns: integer('turns').notNull().default(0),
    /** Respuestas seguidas sin respaldo en los documentos. */
    unsupportedStreak: integer('unsupported_streak').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    processingStartedAt: ts('processing_started_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t['organizationId']!, t['conversationId']!], name: 'ai_conversation_state_pk' }),
    foreignKey({ name: 'ai_conversation_state_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'ai_conversation_state_agent_fk', columns: [t['organizationId']!, t['agentId']!], foreignColumns: [agents.organizationId, agents.id] }),
    check('ai_conversation_state_status_valid', sql`${t['status']!} IN ('active', 'paused', 'handed_off')`),
    check('ai_conversation_state_reason_valid', sql`${t['reason']!} IS NULL OR ${t['reason']!} IN ('requested', 'turn_limit', 'unsupported_media', 'ai_error', 'no_support', 'agent_decision', 'human_message', 'human_took', 'manual', 'no_credits')`),
    check('ai_conversation_state_reason_by_status', sql`(${t['status']!} = 'active') = (${t['reason']!} IS NULL)`),
    check('ai_conversation_state_counts_valid', sql`${t['version']!} >= 1 AND ${t['turns']!} >= 0 AND ${t['unsupportedStreak']!} >= 0 AND ${t['attempts']!} >= 0`),
    index('ai_conversation_state_due_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['status']!} = 'active'`),
  ],
);

/**
 * Registro de cada herramienta que el agente de IA usó o intentó usar en una conversación (M8.5b, ADR-53; F17). **Solo inserción**: es la evidencia de qué hizo la IA, con qué datos y cómo terminó
 * (`done` hizo algo, `unchanged` no había nada que cambiar, `rejected` el servidor no lo permitió y por qué, `error` falló). `args` lleva solo lo que el servidor validó (nunca texto libre de más).
 * Lo que la herramienta cambió además queda en la auditoría del contacto o de la tarea con origen `ai`.
 */
export const aiToolCalls = tenantTable(
  'ai_tool_calls',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    conversationId: uuid('conversation_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    /** Lo que se creó (la tarea), si aplica. */
    entityId: uuid('entity_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'ai_tool_calls_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'ai_tool_calls_agent_fk', columns: [t['organizationId']!, t['agentId']!], foreignColumns: [agents.organizationId, agents.id] }),
    foreignKey({ name: 'ai_tool_calls_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('ai_tool_calls_tool_valid', sql`${t['tool']!} IN ('update_contact_fields', 'create_task', 'transfer_to_person')`),
    check('ai_tool_calls_outcome_valid', sql`${t['outcome']!} IN ('done', 'unchanged', 'rejected', 'error')`),
    check('ai_tool_calls_detail_len', sql`${t['detail']!} IS NULL OR length(${t['detail']!}) <= 500`),
    index('ai_tool_calls_conversation_idx').on(t['organizationId']!, t['conversationId']!, t['createdAt']!),
  ],
);
