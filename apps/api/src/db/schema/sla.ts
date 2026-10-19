import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { conversations, messages } from './conversations';
import { tenantTable } from './helpers';
import { users } from './identity';
import { queues } from './queues';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * SLA y horario laboral (M5.5b, ADR-50). TODAS son tablas de NEGOCIO (tenant): `organization_id` + RLS FORZADA. La zona horaria de la empresa vive en identidad
 * (`organizations.timezone`) y llega por fuera de la transacción. `app_rw` no tiene DELETE salvo en `business_hours` (el horario propio de una cola se quita): un feriado se quita con borrado lógico y los cronómetros conservan su historial.
 */

/** Política de respuesta de la empresa (una fila): objetivo de respuesta y cuántos minutos antes del vencimiento se avisa «en riesgo». Sin fila rigen los valores por omisión (15 y 3). */
export const slaPolicies = tenantTable(
  'sla_policies',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    targetMinutes: integer('target_minutes').notNull().default(15),
    riskMinutes: integer('risk_minutes').notNull().default(3),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('sla_policies_target_valid', sql`${t['targetMinutes']!} BETWEEN 1 AND 1440`),
    check('sla_policies_risk_valid', sql`${t['riskMinutes']!} BETWEEN 0 AND 1440`),
    uniqueIndex('sla_policies_org_uq').on(t['organizationId']!),
  ],
);

/**
 * Horario laboral: el de la EMPRESA (`scope = org`, uno) o el propio de una COLA (`scope = queue`, uno por cola; sin él la cola usa el de la empresa). `days` son siete
 * arreglos (domingo = 0) de tramos [inicio, fin] en minutos desde la medianoche local. Sin fila de empresa, la empresa está abierta siempre.
 */
export const businessHours = tenantTable(
  'business_hours',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    scope: text('scope').notNull(),
    queueId: uuid('queue_id'),
    days: jsonb('days').$type<number[][][]>().notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'business_hours_queue_fk', columns: [t['organizationId']!, t['queueId']!], foreignColumns: [queues.organizationId, queues.id] }),
    check('business_hours_scope_valid', sql`(${t['scope']!} = 'org' AND ${t['queueId']!} IS NULL) OR (${t['scope']!} = 'queue' AND ${t['queueId']!} IS NOT NULL)`),
    check('business_hours_days_shape', sql`jsonb_typeof(${t['days']!}) = 'array' AND jsonb_array_length(${t['days']!}) = 7`),
    uniqueIndex('business_hours_org_uq').on(t['organizationId']!).where(sql`${t['scope']!} = 'org'`),
    uniqueIndex('business_hours_queue_uq').on(t['organizationId']!, t['queueId']!).where(sql`${t['scope']!} = 'queue'`),
  ],
);

/** Feriado de la empresa: una fecha (o una fecha que se repite cada año) en la que no corre el reloj del SLA. Borrado LÓGICO. */
export const holidays = tenantTable(
  'holidays',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    day: date('day', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    yearly: boolean('yearly').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('holidays_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 80`),
    uniqueIndex('holidays_org_day_uq').on(t['organizationId']!, t['day']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Cronómetro de respuesta de una conversación. `first` = la primera respuesta de quien la tiene asignada (corre desde que se asigna); `followup` = la respuesta a un
 * mensaje posterior del cliente (corre desde ese mensaje). `due_at` es la fecha límite en TIEMPO ABIERTO (horario laboral, feriados y zona horaria); `reassign_at`, cuándo
 * toca reasignar si nadie respondió (solo `first`). Se detiene con el primer mensaje HUMANO (no automático, no nota), al finalizar, al transferir o al reasignar; el
 * tiempo de respuesta (también en tiempo abierto) queda guardado. A lo sumo UNO abierto por conversación. Sin DELETE: conserva su historial.
 */
export const responseTimers = tenantTable(
  'response_timers',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    conversationId: uuid('conversation_id').notNull(),
    kind: text('kind').notNull(),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    startedAt: ts('started_at').notNull(),
    dueAt: ts('due_at').notNull(),
    reassignAt: ts('reassign_at'),
    stoppedAt: ts('stopped_at'),
    stopReason: text('stop_reason'),
    responseSeconds: integer('response_seconds'),
    repliedMessageId: uuid('replied_message_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'response_timers_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'response_timers_message_fk', columns: [t['organizationId']!, t['repliedMessageId']!], foreignColumns: [messages.organizationId, messages.id] }),
    check('response_timers_kind_valid', sql`${t['kind']!} IN ('first', 'followup')`),
    check('response_timers_stop_reason_valid', sql`${t['stopReason']!} IS NULL OR ${t['stopReason']!} IN ('human_reply', 'closed', 'transferred', 'reassigned')`),
    check('response_timers_stopped_pair', sql`(${t['stoppedAt']!} IS NULL) = (${t['stopReason']!} IS NULL)`),
    check('response_timers_response_pair', sql`(${t['responseSeconds']!} IS NOT NULL) = (${t['stopReason']!} IS NOT DISTINCT FROM 'human_reply')`),
    check('response_timers_response_valid', sql`${t['responseSeconds']!} IS NULL OR ${t['responseSeconds']!} >= 0`),
    check('response_timers_reassign_first_only', sql`${t['reassignAt']!} IS NULL OR ${t['kind']!} = 'first'`),
    uniqueIndex('response_timers_one_open_uq').on(t['organizationId']!, t['conversationId']!).where(sql`${t['stoppedAt']!} IS NULL`),
    index('response_timers_due_idx').on(t['organizationId']!, t['dueAt']!).where(sql`${t['stoppedAt']!} IS NULL`),
    index('response_timers_reassign_idx').on(t['organizationId']!, t['reassignAt']!).where(sql`${t['stoppedAt']!} IS NULL AND ${t['reassignAt']!} IS NOT NULL`),
    index('response_timers_conversation_idx').on(t['organizationId']!, t['conversationId']!, t['startedAt']!),
  ],
);
