import { sql } from 'drizzle-orm';
import { boolean, check, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

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
