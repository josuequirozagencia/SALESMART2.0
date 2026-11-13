import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { conversations, messages } from './conversations';
import { tasks } from './crm';
import { tenantTable } from './helpers';
import { sales } from './sales';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Menciones «@» en las notas internas (F1, ADR-57): a quién nombra cada nota. TABLA DE NEGOCIO (tenant): `organization_id` + RLS FORZADA; SOLO INSERCIÓN (una nota no se edita, así que sus
 * menciones no cambian). El servidor valida cada persona (activa, de la empresa y con acceso a la conversación) antes de guardarla: mencionar no da acceso.
 */
export const messageMentions = tenantTable(
  'message_mentions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'message_mentions_message_fk', columns: [t['organizationId']!, t['messageId']!], foreignColumns: [messages.organizationId, messages.id] }),
    // Una persona se menciona una vez por nota
    uniqueIndex('message_mentions_message_user_uq').on(t['organizationId']!, t['messageId']!, t['userId']!),
  ],
);

/**
 * Centro de avisos dentro de la aplicación (F1, ADR-57). Un aviso es PARA UNA PERSONA (`user_id`): solo ella lo ve (ni el administrador). Por ahora un solo tipo, `mention`; el modelo admite otros
 * (`type`) sin cambiar la tabla. SIN DELETE: se marca leído (`read_at`). El texto NO se copia aquí: el extracto se lee del mensaje al pedir la lista, así el dato personal vive en un solo sitio
 * y desaparece de la lista junto con la visibilidad de la conversación.
 */
export const notifications = tenantTable(
  'notifications',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** El destinatario. */
    userId: uuid('user_id').notNull().references(() => users.id),
    type: text('type').notNull(),
    /** Quien lo provocó (quien escribió la nota). */
    actorId: uuid('actor_id').references(() => users.id),
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    /** Avisos de tareas (F2, ADR-58). */
    taskId: uuid('task_id'),
    /** Avisos de una venta nueva (v13 S4.2). */
    saleId: uuid('sale_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    readAt: ts('read_at'),
  },
  (t) => [
    foreignKey({ name: 'notifications_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'notifications_message_fk', columns: [t['organizationId']!, t['messageId']!], foreignColumns: [messages.organizationId, messages.id] }),
    foreignKey({ name: 'notifications_sale_fk', columns: [t['organizationId']!, t['saleId']!], foreignColumns: [sales.organizationId, sales.id] }),
    foreignKey({ name: 'notifications_task_fk', columns: [t['organizationId']!, t['taskId']!], foreignColumns: [tasks.organizationId, tasks.id] }),
    check('notifications_type_valid', sql`${t['type']!} IN ('mention', 'task_assigned', 'task_due', 'calendar_reconnect', 'sale_created')`),
    // Un aviso de venta nueva lleva su venta y quien la registró; ninguna conversación, nota ni tarea
    check('notifications_sale_shape', sql`${t['type']!} <> 'sale_created' OR (${t['saleId']!} IS NOT NULL AND ${t['actorId']!} IS NOT NULL AND ${t['conversationId']!} IS NULL AND ${t['messageId']!} IS NULL AND ${t['taskId']!} IS NULL)`),
    // Un solo aviso por persona y venta (repetir el registro no duplica)
    uniqueIndex('notifications_sale_uq').on(t['organizationId']!, t['userId']!, t['saleId']!).where(sql`${t['type']!} = 'sale_created'`),
    // Una mención lleva su conversación y su nota
    check('notifications_mention_shape', sql`${t['type']!} <> 'mention' OR (${t['conversationId']!} IS NOT NULL AND ${t['messageId']!} IS NOT NULL AND ${t['actorId']!} IS NOT NULL)`),
    // Un aviso de tarea lleva su tarea (y ninguna conversación)
    check('notifications_task_shape', sql`${t['type']!} NOT IN ('task_assigned', 'task_due') OR (${t['taskId']!} IS NOT NULL AND ${t['conversationId']!} IS NULL AND ${t['messageId']!} IS NULL)`),
    // Un aviso de calendario (v11 67c) no se refiere a nada más: ni conversación, ni nota, ni tarea, ni autor
    check('notifications_calendar_shape', sql`${t['type']!} <> 'calendar_reconnect' OR (${t['conversationId']!} IS NULL AND ${t['messageId']!} IS NULL AND ${t['taskId']!} IS NULL AND ${t['actorId']!} IS NULL)`),
    // Una sola alerta de «reconectar» SIN LEER por persona (si sigue roto no se acumulan)
    uniqueIndex('notifications_calendar_uq').on(t['organizationId']!, t['userId']!).where(sql`${t['type']!} = 'calendar_reconnect' AND ${t['readAt']!} IS NULL`),
    // Un solo aviso por persona, tarea y tipo (repetir la tarea periódica no duplica)
    uniqueIndex('notifications_task_uq').on(t['organizationId']!, t['userId']!, t['taskId']!, t['type']!).where(sql`${t['taskId']!} IS NOT NULL`),
    // Un solo aviso por persona y nota
    uniqueIndex('notifications_mention_uq').on(t['organizationId']!, t['userId']!, t['messageId']!).where(sql`${t['type']!} = 'mention'`),
    // La lista de una persona, lo más reciente primero, y el contador de no leídos
    index('notifications_user_idx').on(t['organizationId']!, t['userId']!, t['createdAt']!, t['id']!),
    index('notifications_unread_idx').on(t['organizationId']!, t['userId']!).where(sql`${t['readAt']!} IS NULL`),
  ],
);
