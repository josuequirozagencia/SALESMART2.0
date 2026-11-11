import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { agents } from './ai-agents';
import { automations } from './automations';
import { conversations } from './conversations';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Seguimientos automáticos de un agente de IA (v11 S5, ADR-68). Una fila por agente y escenario (hoy solo `stopped_replying`: «El contacto dejó de responder»). Sin DELETE: se apaga con `enabled`.
 * La secuencia de pasos vive en `agent_follow_up_steps`.
 */
export const agentFollowUps = tenantTable(
  'agent_follow_ups',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    agentId: uuid('agent_id').notNull(),
    scenario: text('scenario').notNull().default('stopped_replying'),
    enabled: boolean('enabled').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'agent_follow_ups_agent_fk', columns: [t['organizationId']!, t['agentId']!], foreignColumns: [agents.organizationId, agents.id] }),
    uniqueIndex('agent_follow_ups_agent_scenario_uq').on(t['organizationId']!, t['agentId']!, t['scenario']!),
    check('agent_follow_ups_scenario_valid', sql`${t['scenario']!} IN ('stopped_replying')`),
  ],
);

/**
 * Los pasos de la secuencia (hasta 5). Cada uno espera `delay_minutes` (de 5 minutos a 7 días) desde el mensaje anterior y hace una de estas cosas, o las dos: enviar un mensaje (`ai`: lo escribe la IA al
 * momento; `fixed_text`: un texto con variables) y/o iniciar una automatización existente (`start_automation_id`). Al guardar la secuencia se reemplaza entera (por eso esta tabla sí lleva DELETE: son filas de
 * configuración, no historial; lo que ocurrió queda en `agent_follow_up_runs`).
 */
export const agentFollowUpSteps = tenantTable(
  'agent_follow_up_steps',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    followUpId: uuid('follow_up_id').notNull(),
    position: smallint('position').notNull(),
    delayMinutes: integer('delay_minutes').notNull(),
    /** `ai`: la IA escribe el mensaje · `fixed_text`: texto fijo con variables · `none`: no envía mensaje (solo inicia una automatización). */
    mode: text('mode').notNull(),
    fixedText: text('fixed_text'),
    startAutomationId: uuid('start_automation_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'agent_follow_up_steps_follow_up_fk', columns: [t['organizationId']!, t['followUpId']!], foreignColumns: [agentFollowUps.organizationId, agentFollowUps.id] }),
    foreignKey({ name: 'agent_follow_up_steps_automation_fk', columns: [t['organizationId']!, t['startAutomationId']!], foreignColumns: [automations.organizationId, automations.id] }),
    uniqueIndex('agent_follow_up_steps_position_uq').on(t['followUpId']!, t['position']!),
    check('agent_follow_up_steps_position_valid', sql`${t['position']!} BETWEEN 1 AND 5`),
    check('agent_follow_up_steps_delay_valid', sql`${t['delayMinutes']!} BETWEEN 5 AND 10080`),
    check('agent_follow_up_steps_mode_valid', sql`${t['mode']!} IN ('ai', 'fixed_text', 'none')`),
    check('agent_follow_up_steps_text_valid', sql`(${t['mode']!} = 'fixed_text' AND ${t['fixedText']!} IS NOT NULL AND length(btrim(${t['fixedText']!})) BETWEEN 1 AND 1000) OR (${t['mode']!} <> 'fixed_text' AND ${t['fixedText']!} IS NULL)`),
    check('agent_follow_up_steps_does_something', sql`${t['mode']!} <> 'none' OR ${t['startAutomationId']!} IS NOT NULL`),
  ],
);

/**
 * Lo que ocurre en cada conversación (v11 S5, ADR-68): un paso programado o ya resuelto. **Un solo paso pendiente por conversación y escenario** (índice único parcial) y **una sola vez cada paso de cada cadena**
 * (índice único): repetir o reintentar nunca duplica. `chain_inbound_at` es la hora del último mensaje del cliente al armar la cadena: cada mensaje del cliente gana a lo sumo UNA cadena. `anchor_at` es la hora del
 * mensaje (de la IA o del paso anterior) desde el que se cuenta la espera; `owner_id` es el responsable al armarla (si cambia, se cancela). Sin DELETE.
 */
export const agentFollowUpRuns = tenantTable(
  'agent_follow_up_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    agentId: uuid('agent_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    scenario: text('scenario').notNull().default('stopped_replying'),
    chainInboundAt: ts('chain_inbound_at').notNull(),
    anchorAt: ts('anchor_at').notNull(),
    ownerId: uuid('owner_id').references(() => users.id),
    stepPosition: smallint('step_position').notNull(),
    dueAt: ts('due_at').notNull(),
    /** `pending` → `sent` (salió el mensaje y/o se inició la automatización) | `skipped` (no se pudo, con motivo) | `cancelled` (ya no hacía falta, con motivo). */
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    /** Arrendamiento de la tarea que lo está procesando (una tarea que murió a medias se retoma). */
    processingStartedAt: ts('processing_started_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
  },
  (t) => [
    foreignKey({ name: 'agent_follow_up_runs_agent_fk', columns: [t['organizationId']!, t['agentId']!], foreignColumns: [agents.organizationId, agents.id] }),
    foreignKey({ name: 'agent_follow_up_runs_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    uniqueIndex('agent_follow_up_runs_step_uq').on(t['organizationId']!, t['conversationId']!, t['scenario']!, t['chainInboundAt']!, t['stepPosition']!),
    uniqueIndex('agent_follow_up_runs_one_pending_uq').on(t['organizationId']!, t['conversationId']!, t['scenario']!).where(sql`${t['status']!} = 'pending'`),
    index('agent_follow_up_runs_due_idx').on(t['organizationId']!, t['status']!, t['dueAt']!),
    check('agent_follow_up_runs_scenario_valid', sql`${t['scenario']!} IN ('stopped_replying')`),
    check('agent_follow_up_runs_step_valid', sql`${t['stepPosition']!} BETWEEN 1 AND 5`),
    check('agent_follow_up_runs_status_valid', sql`${t['status']!} IN ('pending', 'sent', 'skipped', 'cancelled')`),
    check('agent_follow_up_runs_reason_len', sql`${t['reason']!} IS NULL OR length(${t['reason']!}) <= 80`),
  ],
);
