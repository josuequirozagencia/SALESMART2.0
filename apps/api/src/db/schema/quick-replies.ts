import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, primaryKey, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';
import { conversations } from './conversations';
import { mediaAssets } from './library';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Respuestas rápidas (M5.6b, ADR-50): textos guardados que se insertan en el redactor escribiendo `/atajo`. TABLA DE NEGOCIO (tenant): `organization_id` + RLS FORZADA.
 * Personal por defecto (`shared = false`: solo la ve y usa su dueño); compartida con toda la empresa solo por quien tiene `quick_replies.manage`. El texto guarda las
 * variables sin resolver (`{{primer_nombre}}`, `{{contact.ciudad}}`…): se resuelven al insertarlas en una conversación. Borrado lógico: `app_rw` no tiene DELETE.
 * El atajo es único entre las vigentes del mismo ámbito (las compartidas de la empresa; las personales de cada dueño).
 */
export const quickReplies = tenantTable(
  'quick_replies',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    /** Lo que se escribe después de la barra: minúsculas, dígitos, guion y guion bajo. */
    shortcut: text('shortcut').notNull(),
    body: text('body').notNull(),
    shared: boolean('shared').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('quick_replies_shortcut_shape', sql`length(${t['shortcut']!}) BETWEEN 1 AND 32 AND ${t['shortcut']!} ~ '^[a-z0-9][a-z0-9_-]*$'`),
    check('quick_replies_body_shape', sql`length(btrim(${t['body']!})) BETWEEN 1 AND 4096`),
    uniqueIndex('quick_replies_shared_shortcut_uq').on(t['organizationId']!, t['shortcut']!).where(sql`${t['shared']!} AND ${t['deletedAt']!} IS NULL`),
    uniqueIndex('quick_replies_owner_shortcut_uq').on(t['organizationId']!, t['ownerId']!, t['shortcut']!).where(sql`NOT ${t['shared']!} AND ${t['deletedAt']!} IS NULL`),
    index('quick_replies_org_idx').on(t['organizationId']!, t['ownerId']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Archivos de una respuesta rápida (V25, ADR-76): hasta 3 de la BIBLIOTECA (referencia, no copia). Tabla de ENLACE: guardar reemplaza el conjunto, así que `app_rw` tiene DELETE y no UPDATE.
 * El tope de 3 lo impone la base: posición 0–2 y única por respuesta. Las claves foráneas compuestas impiden enlazar un archivo de otra empresa.
 */
export const quickReplyAssets = tenantTable(
  'quick_reply_assets',
  {
    quickReplyId: uuid('quick_reply_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    position: smallint('position').notNull(),
  },
  (t) => [
    primaryKey({ name: 'quick_reply_assets_pk', columns: [t['organizationId']!, t['quickReplyId']!, t['position']!] }),
    unique('quick_reply_assets_asset_uq').on(t['organizationId']!, t['quickReplyId']!, t['assetId']!),
    foreignKey({ name: 'quick_reply_assets_reply_fk', columns: [t['organizationId']!, t['quickReplyId']!], foreignColumns: [quickReplies.organizationId, quickReplies.id] }),
    foreignKey({ name: 'quick_reply_assets_asset_fk', columns: [t['organizationId']!, t['assetId']!], foreignColumns: [mediaAssets.organizationId, mediaAssets.id] }),
    check('quick_reply_assets_position_valid', sql`${t['position']!} BETWEEN 0 AND 2`),
    index('quick_reply_assets_asset_idx').on(t['organizationId']!, t['assetId']!),
  ],
);

/**
 * Envíos de una respuesta rápida con su `Idempotency-Key` (V25): repetir la misma petición devuelve los mismos mensajes sin duplicarlos. Solo inserción. No guarda el texto.
 */
export const quickReplySends = tenantTable(
  'quick_reply_sends',
  {
    idempotencyKey: text('idempotency_key').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id),
    conversationId: uuid('conversation_id').notNull(),
    quickReplyId: uuid('quick_reply_id').notNull(),
    requestHash: text('request_hash').notNull(),
    messageIds: uuid('message_ids').array().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'quick_reply_sends_pk', columns: [t['organizationId']!, t['idempotencyKey']!] }),
    foreignKey({ name: 'quick_reply_sends_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'quick_reply_sends_reply_fk', columns: [t['organizationId']!, t['quickReplyId']!], foreignColumns: [quickReplies.organizationId, quickReplies.id] }),
    check('quick_reply_sends_key_shape', sql`length(${t['idempotencyKey']!}) BETWEEN 8 AND 100`),
    check('quick_reply_sends_hash_shape', sql`${t['requestHash']!} ~ '^[0-9a-f]{64}$'`),
  ],
);
