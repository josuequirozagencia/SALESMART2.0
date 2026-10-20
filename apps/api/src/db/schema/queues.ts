import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Colas y reparto (M5.3, ADR-07/ADR-50). TODAS son tablas de NEGOCIO (tenant): `organization_id` + RLS FORZADA. Una cola es un equipo: decide a qué asesor va una
 * conversación nueva. Borrado LÓGICO (`deleted_at`); `app_rw` no tiene DELETE.
 */

/**
 * Cola o departamento. `distribution_on` apaga o enciende el reparto automático (apagado: las conversaciones quedan «sin asignar» hasta que alguien las tome).
 * Modos: `equal` (rotación), `weighted` (con el peso de cada asesor) y `load` (quien tenga menos conversaciones abiertas). `batch` = cuántas conversaciones
 * seguidas recibe un asesor antes de pasar al siguiente (rotación y ponderado). `daily_cap` = tope diario por asesor (0 = sin tope). `only_unassigned`: si el
 * contacto ya tiene dueño (cartera), la conversación va a él y no entra al reparto.
 */
export const queues = tenantTable(
  'queues',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    color: text('color').notNull().default('#7c5cfa'),
    distributionOn: boolean('distribution_on').notNull().default(false),
    mode: text('mode').notNull().default('equal'),
    batch: integer('batch').notNull().default(1),
    dailyCap: integer('daily_cap').notNull().default(0),
    onlyUnassigned: boolean('only_unassigned').notNull().default(true),
    /** M5.5b: no repartir automáticamente mientras la cola está cerrada (fuera de horario o feriado): el lead espera y se reparte al abrir. */
    respectHours: boolean('respect_hours').notNull().default(false),
    /** M5.5b: minutos de tiempo abierto sin respuesta humana tras los que se reasigna la conversación a otra persona de la cola (0 = no reasignar). */
    reassignMinutes: integer('reassign_minutes').notNull().default(0),
    /** M5.5b: cuántas veces como máximo se reasigna una misma conversación. */
    maxRotations: integer('max_rotations').notNull().default(3),
    /** M5.5c: saludo que se envía al cliente cuando abre una conversación nueva (null = no se envía). Texto plano. */
    greetingText: text('greeting_text'),
    /** M5.5c: aviso que se envía al cliente que escribe con la cola cerrada (null = no se envía). Texto plano. */
    outOfHoursText: text('out_of_hours_text'),
    /** M5.5c: horas sin mensajes tras la última respuesta después de las cuales se finaliza sola una conversación «esperando al cliente» (0 = no finalizar). */
    autoCloseHours: integer('auto_close_hours').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('queues_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 60`),
    check('queues_color_shape', sql`${t['color']!} ~ '^#[0-9a-f]{6}$'`),
    check('queues_mode_valid', sql`${t['mode']!} IN ('equal', 'weighted', 'load')`),
    check('queues_batch_valid', sql`${t['batch']!} BETWEEN 1 AND 50`),
    check('queues_cap_valid', sql`${t['dailyCap']!} BETWEEN 0 AND 1000`),
    check('queues_reassign_valid', sql`${t['reassignMinutes']!} BETWEEN 0 AND 1440`),
    check('queues_rotations_valid', sql`${t['maxRotations']!} BETWEEN 1 AND 10`),
    check('queues_greeting_shape', sql`${t['greetingText']!} IS NULL OR length(btrim(${t['greetingText']!})) BETWEEN 1 AND 1000`),
    check('queues_out_of_hours_shape', sql`${t['outOfHoursText']!} IS NULL OR length(btrim(${t['outOfHoursText']!})) BETWEEN 1 AND 1000`),
    check('queues_auto_close_valid', sql`${t['autoCloseHours']!} BETWEEN 0 AND 720`),
    uniqueIndex('queues_org_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Asesores de una cola, con su PESO en ella (un mismo asesor puede pesar distinto en cada cola: ADR-07). `active` enciende o apaga su participación sin perder su
 * peso. Una persona sin fila no participa. Sin DELETE: quitar a alguien es apagarlo.
 */
export const queueMembers = tenantTable(
  'queue_members',
  {
    queueId: uuid('queue_id').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id),
    active: boolean('active').notNull().default(true),
    weight: integer('weight').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'queue_members_pk', columns: [t['organizationId']!, t['queueId']!, t['userId']!] }),
    foreignKey({ name: 'queue_members_queue_fk', columns: [t['organizationId']!, t['queueId']!], foreignColumns: [queues.organizationId, queues.id] }),
    check('queue_members_weight_valid', sql`${t['weight']!} BETWEEN 1 AND 100`),
    index('queue_members_user_idx').on(t['organizationId']!, t['userId']!),
  ],
);

/**
 * Estado del reparto de UNA cola (a quién le tocó la última vez, cuántas seguidas lleva y los créditos del ponderado). La fila se bloquea (`FOR UPDATE`) al asignar:
 * dos conversaciones que llegan a la vez no se reparten con el mismo estado. Es un dato derivado: si se pierde, el reparto empieza de cero.
 */
export const queueDistributionState = tenantTable(
  'queue_distribution_state',
  {
    queueId: uuid('queue_id').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'queue_distribution_state_pk', columns: [t['organizationId']!, t['queueId']!] }),
    foreignKey({ name: 'queue_distribution_state_queue_fk', columns: [t['organizationId']!, t['queueId']!], foreignColumns: [queues.organizationId, queues.id] }),
  ],
);
