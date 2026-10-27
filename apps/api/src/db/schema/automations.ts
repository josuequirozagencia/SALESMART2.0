import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { contacts } from './crm';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Ajustes de las automatizaciones de la empresa (M9.5b, ADR-54). Una fila por empresa, que se crea al primer cambio. `http_allowed_hosts` es la **lista de permitidos** de la acción «llamada HTTP»:
 * solo se puede llamar a estos dominios (exactos o `*.dominio`). Sin fila no hay ninguno: la acción no puede llamar a nada hasta que el administrador autorice un dominio. Sin DELETE.
 */
export const automationSettings = tenantTable(
  'automation_settings',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    httpAllowedHosts: text('http_allowed_hosts').array().notNull().default(sql`'{}'::text[]`),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('automation_settings_hosts_len', sql`cardinality(${t['httpAllowedHosts']!}) <= 20`),
    uniqueIndex('automation_settings_org_uq').on(t['organizationId']!),
  ],
);

export const AUTOMATION_TRIGGERS = ['contact_created', 'message_received', 'opportunity_created', 'stage_changed', 'field_changed', 'sale_created'] as const;

/**
 * Regla de automatización de la empresa (M9.3, ADR-54; F20): «cuando ocurre ESTO, si se cumple AQUELLO, haz ESTO OTRO». `trigger_type` es el hecho que la dispara y `trigger_filter` lo acota
 * (un canal, una etapa…); `conditions` son condiciones sobre el contacto que se evalúan al ejecutar (todas deben cumplirse); `actions` son los pasos, en orden. Las tres últimas columnas son JSON
 * validado en el servidor con esquemas estrictos (la base solo comprueba la forma general). `draft` → `active` ⇄ `paused`; solo `active` reacciona. `version` sube con cada cambio de la definición.
 */
export const automations = tenantTable(
  'automations',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'),
    triggerType: text('trigger_type').notNull(),
    triggerFilter: jsonb('trigger_filter').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    conditions: jsonb('conditions').$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    actions: jsonb('actions').$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('automations_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 80`),
    check('automations_description_len', sql`${t['description']!} IS NULL OR length(${t['description']!}) <= 300`),
    check('automations_status_valid', sql`${t['status']!} IN ('draft', 'active', 'paused')`),
    check('automations_trigger_valid', sql`${t['triggerType']!} IN ('contact_created', 'message_received', 'opportunity_created', 'stage_changed', 'field_changed', 'sale_created')`),
    check('automations_shape', sql`jsonb_typeof(${t['triggerFilter']!}) = 'object' AND jsonb_typeof(${t['conditions']!}) = 'array' AND jsonb_typeof(${t['actions']!}) = 'array' AND jsonb_array_length(${t['conditions']!}) <= 10 AND jsonb_array_length(${t['actions']!}) <= 10`),
    uniqueIndex('automations_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
    index('automations_trigger_idx').on(t['organizationId']!, t['triggerType']!).where(sql`${t['status']!} = 'active' AND ${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Una ejecución de una regla por un hecho (M9.3). Se crea DENTRO de la transacción del hecho (atómica con él) en estado `queued` y la tarea `automation-runs` la ejecuta. `event_key` identifica el
 * hecho: la misma regla no corre dos veces por el mismo (índice único). `depth` y `chain` son la defensa contra ciclos: lo que una regla provoca puede disparar otras reglas, hasta una
 * profundidad máxima y NUNCA a una regla que ya participó en la cadena. `skipped` y `failed` explican por qué en `reason` (condiciones sin cumplir, ciclo, tope por hora, un paso que falló).
 */
export const automationRuns = tenantTable(
  'automation_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    automationId: uuid('automation_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    eventType: text('event_type').notNull(),
    eventKey: text('event_key').notNull(),
    /** Lo mínimo del hecho que se usa al ejecutar (canal, etapas, campo y valor…); nunca texto de mensajes. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('queued'),
    reason: text('reason'),
    depth: integer('depth').notNull().default(0),
    chain: uuid('chain').array().notNull().default(sql`'{}'::uuid[]`),
    causeRunId: uuid('cause_run_id'),
    /** Las acciones que faltan por hacer cuando la ejecución está ESPERANDO (M9.5, ADR-54): una acción «esperar» deja la ejecución en cola con la hora en que sigue (`next_attempt_at`) y estas acciones, tal como eran al empezar (editar la regla no cambia lo que ya empezó). Nulo = no está esperando. */
    resumeActions: jsonb('resume_actions').$type<Array<Record<string, unknown>>>(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'automation_runs_automation_fk', columns: [t['organizationId']!, t['automationId']!], foreignColumns: [automations.organizationId, automations.id] }),
    foreignKey({ name: 'automation_runs_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('automation_runs_status_valid', sql`${t['status']!} IN ('queued', 'done', 'skipped', 'failed')`),
    check('automation_runs_depth_valid', sql`${t['depth']!} BETWEEN 0 AND 10 AND ${t['attempts']!} >= 0`),
    check('automation_runs_context_shape', sql`jsonb_typeof(${t['context']!}) = 'object' AND length(${t['context']!}::text) <= 2000`),
    check('automation_runs_resume_shape', sql`${t['resumeActions']!} IS NULL OR (jsonb_typeof(${t['resumeActions']!}) = 'array' AND jsonb_array_length(${t['resumeActions']!}) BETWEEN 1 AND 10)`),
    check('automation_runs_reason_len', sql`${t['reason']!} IS NULL OR length(${t['reason']!}) <= 500`),
    uniqueIndex('automation_runs_event_uq').on(t['organizationId']!, t['automationId']!, t['eventKey']!),
    index('automation_runs_due_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['status']!} = 'queued'`),
    index('automation_runs_automation_idx').on(t['organizationId']!, t['automationId']!, t['createdAt']!),
    index('automation_runs_contact_idx').on(t['organizationId']!, t['automationId']!, t['contactId']!, t['createdAt']!),
  ],
);

/** Lo que hizo cada paso de una ejecución (M9.3). **Solo inserción**: es el historial que se ve en «ejecuciones» y la evidencia de qué cambió la regla. */
export const automationRunSteps = tenantTable(
  'automation_run_steps',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    runId: uuid('run_id').notNull(),
    position: integer('position').notNull(),
    actionType: text('action_type').notNull(),
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'automation_run_steps_run_fk', columns: [t['organizationId']!, t['runId']!], foreignColumns: [automationRuns.organizationId, automationRuns.id] }),
    check('automation_run_steps_outcome_valid', sql`${t['outcome']!} IN ('done', 'skipped', 'failed')`),
    check('automation_run_steps_detail_len', sql`${t['detail']!} IS NULL OR length(${t['detail']!}) <= 500`),
    uniqueIndex('automation_run_steps_pos_uq').on(t['organizationId']!, t['runId']!, t['position']!),
  ],
);
