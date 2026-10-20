import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { channelAccounts } from './channels';
import { tenantTable } from './helpers';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Plantillas de WhatsApp (M5.6a, ADR-50): las que Meta tiene aprobadas, pendientes o rechazadas en la cuenta de WhatsApp Business de CADA conexión, sincronizadas desde
 * Meta (no se crean aquí). TABLA DE NEGOCIO (tenant): `organization_id` + RLS FORZADA. Sin DELETE: una plantilla que Meta deja de devolver se marca `deleted_at`
 * (y revive si vuelve). `components` guarda la forma normalizada (encabezado, cuerpo, pie, botones y lo que no se entiende); `variables`, `sendable` y `unsupported_reason`
 * se derivan al sincronizar para que listar y enviar no tengan que volver a analizarla.
 */
export const messageTemplates = tenantTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    channelAccountId: uuid('channel_account_id').notNull(),
    /** Identificador de la plantilla en Meta. */
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: text('category').notNull(),
    status: text('status').notNull(),
    parameterFormat: text('parameter_format').notNull().default('positional'),
    components: jsonb('components').$type<Record<string, unknown>>().notNull(),
    /** El cuerpo con sus variables sin resolver: vista previa y búsqueda. */
    bodyText: text('body_text').notNull().default(''),
    variables: jsonb('variables').$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    sendable: boolean('sendable').notNull().default(false),
    unsupportedReason: text('unsupported_reason'),
    rejectedReason: text('rejected_reason'),
    syncedAt: ts('synced_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({ name: 'message_templates_channel_fk', columns: [t['organizationId']!, t['channelAccountId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    check('message_templates_category_valid', sql`${t['category']!} IN ('marketing', 'utility', 'authentication', 'other')`),
    check('message_templates_status_valid', sql`${t['status']!} IN ('approved', 'pending', 'rejected', 'paused', 'disabled', 'other')`),
    check('message_templates_format_valid', sql`${t['parameterFormat']!} IN ('positional', 'named')`),
    // Minúsculas, dígitos y guion bajo (el largo se mide aparte: PostgreSQL no admite repeticiones de más de 255 en una expresión regular)
    check('message_templates_name_shape', sql`length(${t['name']!}) BETWEEN 1 AND 512 AND ${t['name']!} ~ '^[a-z0-9_]+$'`),
    // Solo una plantilla aprobada y entendida se puede enviar
    check('message_templates_sendable_status', sql`NOT ${t['sendable']!} OR ${t['status']!} = 'approved'`),
    check('message_templates_sendable_clean', sql`NOT ${t['sendable']!} OR ${t['unsupportedReason']!} IS NULL`),
    uniqueIndex('message_templates_channel_name_uq').on(t['organizationId']!, t['channelAccountId']!, t['name']!, t['language']!),
    index('message_templates_channel_idx').on(t['organizationId']!, t['channelAccountId']!, t['deletedAt']!),
  ],
);
