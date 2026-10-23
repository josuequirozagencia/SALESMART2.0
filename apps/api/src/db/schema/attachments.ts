import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { conversations, messages } from './conversations';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Archivos adjuntos de los mensajes (M5.6d, ADR-50). TABLA DE NEGOCIO (tenant): `organization_id` + RLS FORZADA. El binario NO vive aquí: está en el almacenamiento
 * (`storage_key`, siempre bajo `org/<organización>/…`) y solo se entrega con una URL firmada de vida corta. Sin DELETE: un adjunto que ya no sirve (huérfano, infectado)
 * pasa a `expired`/`infected` y su archivo se borra del almacenamiento.
 *  - ENTRANTE (`direction = 'in'`): nace `pending` junto con el mensaje, con el identificador del archivo en el proveedor (`source_media_id`); una tarea lo descarga,
 *    lo revisa con el antivirus y lo guarda (`ready`), o lo deja `failed`/`infected`.
 *  - SALIENTE (`direction = 'out'`): la persona lo sube ANTES de escribir el mensaje (queda `ready` si pasó el antivirus) y `message_id` se llena al enviarlo; los que
 *    nadie envió en 24 h pasan a `expired`.
 * `scan_status`: `clean` (el antivirus lo revisó), `skipped` (no hay antivirus configurado), `infected`, `pending`/`error` (no se pudo revisar: no se entrega).
 */
export const messageAttachments = tenantTable(
  'message_attachments',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    conversationId: uuid('conversation_id').notNull(),
    messageId: uuid('message_id'),
    direction: text('direction').notNull(),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    /** Nombre original, limpio (sin rutas). Solo para mostrar: la clave del almacenamiento nunca sale de él. */
    filename: text('filename'),
    sizeBytes: integer('size_bytes'),
    storageKey: text('storage_key'),
    /** SHA-256 del contenido, en hexadecimal. */
    checksum: text('checksum'),
    state: text('state').notNull().default('pending'),
    scanStatus: text('scan_status').notNull().default('pending'),
    /** Entrante: identificador del archivo en el proveedor. */
    sourceMediaId: text('source_media_id'),
    /** Por qué no quedó listo (texto para la persona; sin datos del cliente). */
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'message_attachments_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'message_attachments_message_fk', columns: [t['organizationId']!, t['messageId']!], foreignColumns: [messages.organizationId, messages.id] }),
    check('message_attachments_direction_valid', sql`${t['direction']!} IN ('in', 'out')`),
    check('message_attachments_kind_valid', sql`${t['kind']!} IN ('image', 'video', 'audio', 'document', 'sticker')`),
    check('message_attachments_state_valid', sql`${t['state']!} IN ('pending', 'ready', 'infected', 'failed', 'expired')`),
    check('message_attachments_scan_valid', sql`${t['scanStatus']!} IN ('pending', 'clean', 'skipped', 'infected', 'error')`),
    check('message_attachments_size_valid', sql`${t['sizeBytes']!} IS NULL OR ${t['sizeBytes']!} BETWEEN 0 AND 104857600`),
    check('message_attachments_mime_shape', sql`length(${t['mimeType']!}) BETWEEN 3 AND 127`),
    check('message_attachments_filename_len', sql`${t['filename']!} IS NULL OR length(${t['filename']!}) BETWEEN 1 AND 200`),
    check('message_attachments_error_len', sql`${t['error']!} IS NULL OR length(${t['error']!}) <= 300`),
    check('message_attachments_attempts_valid', sql`${t['attempts']!} >= 0`),
    // Solo se entrega lo que está guardado Y no es sospechoso: «listo» exige archivo, y que el antivirus lo haya dado por limpio o no haya antivirus
    check('message_attachments_ready_complete', sql`${t['state']!} <> 'ready' OR (${t['storageKey']!} IS NOT NULL AND ${t['sizeBytes']!} IS NOT NULL AND ${t['scanStatus']!} IN ('clean', 'skipped'))`),
    // Un adjunto infectado jamás se marca limpio
    check('message_attachments_infected_consistent', sql`(${t['state']!} = 'infected') = (${t['scanStatus']!} = 'infected')`),
    // Un mensaje lleva a lo sumo un adjunto
    uniqueIndex('message_attachments_message_uq').on(t['organizationId']!, t['messageId']!).where(sql`${t['messageId']!} IS NOT NULL`),
    index('message_attachments_conversation_idx').on(t['organizationId']!, t['conversationId']!),
    // Lo que las tareas buscan cada pasada: descargas entrantes pendientes y subidas sin enviar
    index('message_attachments_pending_in_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['direction']!} = 'in' AND ${t['state']!} = 'pending'`),
    index('message_attachments_orphan_out_idx').on(t['organizationId']!, t['createdAt']!).where(sql`${t['direction']!} = 'out' AND ${t['messageId']!} IS NULL AND ${t['state']!} = 'ready'`),
  ],
);
