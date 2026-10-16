import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * CRM base (M3, ADR-43). TABLAS DE NEGOCIO (tenant): `organization_id` + RLS FORZADA por `tenantTable()`; el aislamiento entre organizaciones lo da la BD.
 * La visibilidad POR PERSONA (el asesor ve sus contactos) la aplica el servidor en cada consulta (ver `ContactsRepository`), no la RLS.
 */

/**
 * Contacto. Borrado LÓGICO (`deleted_at`): `app_rw` no tiene DELETE. Los teléfonos viven en `contact_phones`. `owner_id` = quién lo atiende (null = sin asignar).
 * `consent` es el consentimiento para escribirle: los contactos importados NO reciben mensajes automáticos sin él (F11).
 */
export const contacts = tenantTable(
  'contacts',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    email: text('email'),
    ownerId: uuid('owner_id').references(() => users.id),
    source: text('source').notNull().default('manual'),
    consent: text('consent').notNull().default('unknown'),
    consentUpdatedAt: ts('consent_updated_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('contacts_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 200`),
    check('contacts_email_shape', sql`${t['email']!} IS NULL OR (${t['email']!} = lower(${t['email']!}) AND length(${t['email']!}) <= 254 AND ${t['email']!} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}$')`),
    check('contacts_source_shape', sql`${t['source']!} ~ '^[a-z][a-z0-9_]{1,31}$'`),
    check('contacts_consent_valid', sql`${t['consent']!} IN ('unknown', 'granted', 'revoked')`),
    index('contacts_org_created_idx').on(t['organizationId']!, t['createdAt']!, t['id']!).where(sql`${t['deletedAt']!} IS NULL`),
    index('contacts_org_name_idx').on(t['organizationId']!, sql`lower(${t['name']!})`, t['id']!).where(sql`${t['deletedAt']!} IS NULL`),
    index('contacts_org_owner_idx').on(t['organizationId']!, t['ownerId']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Teléfono de un contacto, en E.164. Único por organización mientras esté vigente (`deleted_at IS NULL`); al borrar el contacto sus teléfonos
 * se marcan borrados y el número queda libre. A lo sumo UNO es el principal. Sin DELETE para `app_rw`.
 */
export const contactPhones = tenantTable(
  'contact_phones',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    contactId: uuid('contact_id').notNull(),
    e164: text('e164').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    // FK compuesta: un teléfono solo puede colgar de un contacto de SU organización (las FK simples eluden la RLS, M0 §5)
    foreignKey({ name: 'contact_phones_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('contact_phones_e164_shape', sql`${t['e164']!} ~ '^[+][1-9][0-9]{7,14}$'`),
    uniqueIndex('contact_phones_org_e164_uq').on(t['organizationId']!, t['e164']!).where(sql`${t['deletedAt']!} IS NULL`),
    uniqueIndex('contact_phones_one_primary_uq').on(t['organizationId']!, t['contactId']!).where(sql`${t['isPrimary']!} AND ${t['deletedAt']!} IS NULL`),
    index('contact_phones_contact_idx').on(t['organizationId']!, t['contactId']!),
  ],
);
