import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { channelAccounts } from './channels';
import { contacts } from './crm';
import { tenantTable } from './helpers';
import { users } from './identity';
import { queues } from './queues';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Conversaciones y mensajes (M5.2, ADR-50). TODAS son tablas de NEGOCIO (tenant): `organization_id` + RLS FORZADA. `app_rw` no tiene DELETE:
 * los mensajes no se borran (retención y borrado de datos personales se deciden aparte) y una conversación solo se cierra.
 */

/**
 * Evento CRUDO que llegó por el webhook de Meta, ya asignado a su empresa. Guarda solo la parte (`value`) que corresponde a UN número, nunca el cuerpo completo
 * de la petición (podría traer datos de otra empresa). La tarea de proceso lo convierte en contacto, conversación y mensajes. El payload se vacía a los 30 días
 * (provisional): `payload` pasa a NULL y la fila queda como registro del evento.
 */
export const webhookEvents = tenantTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    channelAccountId: uuid('channel_account_id').notNull(),
    phoneNumberId: text('phone_number_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /** SHA-256 (hex) del payload: Meta reintenta la misma entrega y no debe procesarse dos veces. */
    payloadHash: text('payload_hash').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    /** Solo códigos y nombres de error: nunca el texto de un mensaje ni un teléfono. */
    lastError: text('last_error'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    redactedAt: ts('redacted_at'),
  },
  (t) => [
    foreignKey({ name: 'webhook_events_channel_fk', columns: [t['organizationId']!, t['channelAccountId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    check('webhook_events_status_valid', sql`${t['status']!} IN ('pending', 'done', 'failed')`),
    check('webhook_events_hash_shape', sql`${t['payloadHash']!} ~ '^[0-9a-f]{64}$'`),
    check('webhook_events_attempts_valid', sql`${t['attempts']!} >= 0`),
    check('webhook_events_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    uniqueIndex('webhook_events_org_hash_uq').on(t['organizationId']!, t['payloadHash']!),
    index('webhook_events_due_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['status']!} = 'pending'`),
    index('webhook_events_redact_idx').on(t['organizationId']!, t['processedAt']!).where(sql`${t['payload']!} IS NOT NULL AND ${t['status']!} <> 'pending'`),
  ],
);

/**
 * Conversación de UN contacto por UN canal. Solo puede haber una ABIERTA (cualquier estado menos `closed`) por contacto y canal: índice único parcial.
 * Estados (ADR-50 #5): `unassigned` sin asesor · `pending` asignada y sin aceptar · `working` · `waiting` esperando al cliente · `closed`.
 * M5.3: la conversación nace en la cola de su conexión; si el reparto de la cola elige a un asesor queda `pending` con su dueño (`owner_id`, `assigned_at`); si el reparto
 * está apagado, no hay asesor disponible o el canal no tiene cola, queda `unassigned`. Salvo `closed`, hay dueño si y solo si el estado no es `unassigned`.
 */
export const conversations = tenantTable(
  'conversations',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    contactId: uuid('contact_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    status: text('status').notNull().default('unassigned'),
    queueId: uuid('queue_id'),
    /** Quién la atiende (asesor). Null = sin asignar. */
    ownerId: uuid('owner_id').references(() => users.id),
    assignedAt: ts('assigned_at'),
    lastMessageAt: ts('last_message_at'),
    /** Último mensaje del CLIENTE: de aquí sale la ventana de 24 h de WhatsApp oficial. */
    lastInboundAt: ts('last_inbound_at'),
    unreadCount: integer('unread_count').notNull().default(0),
    /** Con quién se habla en el canal (el identificador que informó el proveedor, p. ej. el `wa_id` de WhatsApp): a él se le responde. Null en las anteriores a M5.4. */
    peerId: text('peer_id'),
    closedAt: ts('closed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'conversations_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    foreignKey({ name: 'conversations_channel_fk', columns: [t['organizationId']!, t['channelAccountId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    check('conversations_status_valid', sql`${t['status']!} IN ('unassigned', 'pending', 'working', 'waiting', 'closed')`),
    foreignKey({ name: 'conversations_queue_fk', columns: [t['organizationId']!, t['queueId']!], foreignColumns: [queues.organizationId, queues.id] }),
    check('conversations_owner_status', sql`${t['status']!} = 'closed' OR ((${t['status']!} = 'unassigned') = (${t['ownerId']!} IS NULL))`),
    check('conversations_assigned_pair', sql`(${t['ownerId']!} IS NULL) = (${t['assignedAt']!} IS NULL)`),
    check('conversations_unread_valid', sql`${t['unreadCount']!} >= 0`),
    uniqueIndex('conversations_one_open_uq').on(t['organizationId']!, t['contactId']!, t['channelAccountId']!).where(sql`${t['status']!} <> 'closed'`),
    index('conversations_list_idx').on(t['organizationId']!, t['status']!, t['lastMessageAt']!),
    index('conversations_contact_idx').on(t['organizationId']!, t['contactId']!),
    index('conversations_owner_idx').on(t['organizationId']!, t['ownerId']!, t['status']!),
    index('conversations_assigned_idx').on(t['organizationId']!, t['queueId']!, t['assignedAt']!),
  ],
);

/**
 * Mensaje de una conversación. `external_id` (el identificador del proveedor) es único por canal: un mismo mensaje entregado dos veces no se duplica.
 * Las notas internas son mensajes de tipo `note` que NINGÚN camino de envío acepta (M5.4). Los adjuntos entrantes quedan como referencia (`media`) hasta
 * que M5.6 tenga almacenamiento; mientras tanto la interfaz avisa «archivo no disponible todavía».
 */
export const messages = tenantTable(
  'messages',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    conversationId: uuid('conversation_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    externalId: text('external_id'),
    direction: text('direction').notNull(),
    senderType: text('sender_type').notNull(),
    kind: text('kind').notNull(),
    /** Texto del mensaje (o el pie de un adjunto). Dato personal: no va a logs ni a la auditoría. */
    body: text('body'),
    media: jsonb('media').$type<Record<string, unknown>>(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull(),
    error: text('error'),
    /** Cuándo lo envió quien lo escribió (la hora que informa el proveedor). */
    sentAt: ts('sent_at').notNull(),
    deliveredAt: ts('delivered_at'),
    readAt: ts('read_at'),
    /** Quién lo escribió (mensajes humanos y notas); null en los que entran y en los automáticos. */
    createdBy: uuid('created_by').references(() => users.id),
    /** Intentos de envío hechos y cuándo toca el siguiente (solo mensajes en cola). */
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'messages_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'messages_channel_fk', columns: [t['organizationId']!, t['channelAccountId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    check('messages_direction_valid', sql`${t['direction']!} IN ('in', 'out')`),
    check('messages_sender_valid', sql`${t['senderType']!} IN ('contact', 'human', 'ai', 'campaign', 'automation', 'system')`),
    // Lo que entra lo escribe el contacto; lo que sale, nunca
    check('messages_sender_direction', sql`(${t['direction']!} = 'in') = (${t['senderType']!} = 'contact')`),
    check('messages_kind_valid', sql`${t['kind']!} IN ('text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'interactive', 'button', 'template', 'note', 'unsupported')`),
    check('messages_status_valid', sql`${t['status']!} IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'internal')`),
    // Una nota interna es `internal` y solo ella: así ningún camino de envío (que toma `queued`) puede llegar a mandarla al cliente
    check('messages_note_internal', sql`(${t['kind']!} = 'note') = (${t['status']!} = 'internal')`),
    check('messages_attempts_valid', sql`${t['attempts']!} >= 0`),
    check('messages_body_len', sql`${t['body']!} IS NULL OR length(${t['body']!}) <= 8000`),
    check('messages_error_len', sql`${t['error']!} IS NULL OR length(${t['error']!}) <= 300`),
    uniqueIndex('messages_channel_external_uq').on(t['organizationId']!, t['channelAccountId']!, t['externalId']!).where(sql`${t['externalId']!} IS NOT NULL`),
    index('messages_conversation_idx').on(t['organizationId']!, t['conversationId']!, t['sentAt']!, t['id']!),
    index('messages_outbox_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['status']!} = 'queued'`),
  ],
);
