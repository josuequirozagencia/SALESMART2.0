import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { conversations, messages } from './conversations';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Mensajes programados (M5.6c, ADR-50): un texto que una persona deja para que salga solo, a una hora, dentro de la ventana de 24 h de WhatsApp. TABLA DE NEGOCIO (tenant): `organization_id`
 * + RLS FORZADA; sin DELETE: un mensaje se resuelve (`sent`, `cancelled` o `failed`) y queda como historial, con el motivo. `body` es dato personal: no va a logs ni a la auditoría.
 * Al salir se convierte en un mensaje normal (`message_id`), enviado en nombre de quien lo programó.
 */
export const scheduledMessages = tenantTable(
  'scheduled_messages',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    conversationId: uuid('conversation_id').notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    body: text('body').notNull(),
    sendAt: ts('send_at').notNull(),
    /** scheduled → sent | cancelled | failed. */
    status: text('status').notNull().default('scheduled'),
    /** Por qué se canceló o falló (código; la interfaz lo redacta). */
    reason: text('reason'),
    /** El mensaje en que se convirtió, cuando salió. */
    messageId: uuid('message_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    foreignKey({ name: 'scheduled_messages_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'scheduled_messages_message_fk', columns: [t['organizationId']!, t['messageId']!], foreignColumns: [messages.organizationId, messages.id] }),
    check('scheduled_messages_status_valid', sql`${t['status']!} IN ('scheduled', 'sent', 'cancelled', 'failed')`),
    check('scheduled_messages_body_shape', sql`length(btrim(${t['body']!})) BETWEEN 1 AND 4096`),
    check('scheduled_messages_reason_len', sql`${t['reason']!} IS NULL OR length(${t['reason']!}) <= 60`),
    // Pendiente ⇒ sin resolver; resuelto ⇒ con fecha; enviado ⇒ con su mensaje
    check('scheduled_messages_resolved_consistent', sql`(${t['status']!} = 'scheduled') = (${t['resolvedAt']!} IS NULL)`),
    check('scheduled_messages_sent_has_message', sql`(${t['status']!} = 'sent') = (${t['messageId']!} IS NOT NULL)`),
    // Lo que la tarea busca cada pasada: los pendientes por vencer
    index('scheduled_messages_due_idx').on(t['organizationId']!, t['sendAt']!).where(sql`${t['status']!} = 'scheduled'`),
    index('scheduled_messages_conversation_idx').on(t['organizationId']!, t['conversationId']!, t['createdAt']!),
  ],
);
