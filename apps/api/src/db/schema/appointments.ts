import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { conversations, messages } from './conversations';
import { contacts } from './crm';
import { tenantTable } from './helpers';
import { users } from './identity';
import { opportunities } from './pipelines';
import { messageTemplates } from './templates';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Citas (M6.3, ADR-13/18/51; F13). TABLAS DE NEGOCIO (tenant): `organization_id` + RLS FORZADA. Una cita nace de una conversación y pertenece a quien la atiende (`owner_id`,
 * el «dueño del lead»). Nunca se borra: se cancela (con motivo) o se completa. `starts_at` es un instante UTC; la hora que ve la persona sale de la zona horaria de la empresa.
 * Si algún recordatorio cae fuera de la ventana de 24 h de WhatsApp, la cita guarda la plantilla aprobada (y sus valores) con la que se enviarán esos recordatorios.
 */
export const appointments = tenantTable(
  'appointments',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    contactId: uuid('contact_id').notNull(),
    conversationId: uuid('conversation_id'),
    /** La oportunidad que se movió a la etapa de cita (si la había). */
    opportunityId: uuid('opportunity_id'),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    startsAt: ts('starts_at').notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(30),
    /** Tipo de cita en texto libre («Corte», «Consulta»…). */
    kind: text('kind').notNull().default('Cita'),
    notes: text('notes'),
    /** scheduled → completed | cancelled. */
    status: text('status').notNull().default('scheduled'),
    /** Los «N minutos antes» configurados (los recordatorios se rehacen desde aquí al reprogramar). */
    reminderOffsets: jsonb('reminder_offsets').$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    reminderTemplateId: uuid('reminder_template_id'),
    reminderParams: jsonb('reminder_params').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** `Idempotency-Key` de la petición que la creó: repetirla devuelve la misma cita. */
    idempotencyKey: text('idempotency_key').notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    foreignKey({ name: 'appointments_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    foreignKey({ name: 'appointments_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'appointments_opportunity_fk', columns: [t['organizationId']!, t['opportunityId']!], foreignColumns: [opportunities.organizationId, opportunities.id] }),
    foreignKey({ name: 'appointments_template_fk', columns: [t['organizationId']!, t['reminderTemplateId']!], foreignColumns: [messageTemplates.organizationId, messageTemplates.id] }),
    check('appointments_status_valid', sql`${t['status']!} IN ('scheduled', 'completed', 'cancelled')`),
    check('appointments_duration_valid', sql`${t['durationMinutes']!} BETWEEN 5 AND 1440`),
    check('appointments_kind_shape', sql`length(btrim(${t['kind']!})) BETWEEN 1 AND 60`),
    check('appointments_notes_len', sql`${t['notes']!} IS NULL OR length(${t['notes']!}) BETWEEN 1 AND 1000`),
    check('appointments_key_shape', sql`length(${t['idempotencyKey']!}) BETWEEN 8 AND 100`),
    // Cancelada ⇔ con fecha, autor y motivo; completada ⇔ con fecha
    check('appointments_cancel_consistent', sql`(${t['status']!} = 'cancelled') = (${t['cancelledAt']!} IS NOT NULL AND ${t['cancelledBy']!} IS NOT NULL AND ${t['cancelReason']!} IS NOT NULL)`),
    check('appointments_cancel_reason_len', sql`${t['cancelReason']!} IS NULL OR length(btrim(${t['cancelReason']!})) BETWEEN 1 AND 500`),
    check('appointments_complete_consistent', sql`(${t['status']!} = 'completed') = (${t['completedAt']!} IS NOT NULL)`),
    uniqueIndex('appointments_org_key_uq').on(t['organizationId']!, t['idempotencyKey']!),
    index('appointments_owner_idx').on(t['organizationId']!, t['ownerId']!, t['startsAt']!),
    index('appointments_starts_idx').on(t['organizationId']!, t['startsAt']!),
    index('appointments_contact_idx').on(t['organizationId']!, t['contactId']!, t['startsAt']!),
  ],
);

/**
 * Recordatorios de una cita (ADR-13): «N minutos antes», por el mismo canal de la conversación, hasta el tope por fuente (3; 5 en QR, Messenger e Instagram, validado en el
 * servidor). Los envía una tarea periódica como mensajes automáticos; el estado de entrega es el del mensaje que se creó. Cancelar o reprogramar la cita cancela los
 * pendientes. Sin DELETE: se resuelven (`sent`, `skipped`, `failed`, `cancelled`).
 */
export const appointmentReminders = tenantTable(
  'appointment_reminders',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    appointmentId: uuid('appointment_id').notNull(),
    offsetMinutes: integer('offset_minutes').notNull(),
    sendAt: ts('send_at').notNull(),
    /** scheduled → sent | skipped | failed | cancelled. */
    status: text('status').notNull().default('scheduled'),
    /** Cómo salió: texto libre (ventana abierta) o plantilla. */
    via: text('via'),
    messageId: uuid('message_id'),
    /** Por qué no salió (código; la interfaz lo redacta). */
    reason: text('reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    foreignKey({ name: 'appointment_reminders_appointment_fk', columns: [t['organizationId']!, t['appointmentId']!], foreignColumns: [appointments.organizationId, appointments.id] }),
    foreignKey({ name: 'appointment_reminders_message_fk', columns: [t['organizationId']!, t['messageId']!], foreignColumns: [messages.organizationId, messages.id] }),
    check('appointment_reminders_status_valid', sql`${t['status']!} IN ('scheduled', 'sent', 'skipped', 'failed', 'cancelled')`),
    check('appointment_reminders_via_valid', sql`${t['via']!} IS NULL OR ${t['via']!} IN ('text', 'template')`),
    check('appointment_reminders_offset_valid', sql`${t['offsetMinutes']!} BETWEEN 1 AND 43200`),
    check('appointment_reminders_reason_len', sql`${t['reason']!} IS NULL OR length(${t['reason']!}) <= 60`),
    check('appointment_reminders_resolved_consistent', sql`(${t['status']!} = 'scheduled') = (${t['resolvedAt']!} IS NULL)`),
    check('appointment_reminders_sent_complete', sql`${t['status']!} <> 'sent' OR (${t['messageId']!} IS NOT NULL AND ${t['via']!} IS NOT NULL)`),
    // Un mismo «N minutos antes» una sola vez entre los pendientes de la cita
    uniqueIndex('appointment_reminders_pending_uq').on(t['organizationId']!, t['appointmentId']!, t['offsetMinutes']!).where(sql`${t['status']!} = 'scheduled'`),
    // Lo que la tarea busca cada pasada: los pendientes por vencer
    index('appointment_reminders_due_idx').on(t['organizationId']!, t['sendAt']!).where(sql`${t['status']!} = 'scheduled'`),
    index('appointment_reminders_appointment_idx').on(t['organizationId']!, t['appointmentId']!, t['offsetMinutes']!),
  ],
);
