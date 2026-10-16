import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    // Atribución de Meta Ads (M3.3, ADR-45): primer clic (inmutable una vez grabado) y último clic de Click-to-WhatsApp. `ctwa_cl_id` es el del último clic.
    ctwaClId: text('ctwa_cl_id'),
    firstTouchAt: ts('first_touch_at'),
    firstTouchSource: text('first_touch_source'),
    firstTouchCampaign: text('first_touch_campaign'),
    firstTouchAdset: text('first_touch_adset'),
    firstTouchAd: text('first_touch_ad'),
    lastTouchAt: ts('last_touch_at'),
    lastTouchSource: text('last_touch_source'),
    lastTouchCampaign: text('last_touch_campaign'),
    lastTouchAdset: text('last_touch_adset'),
    lastTouchAd: text('last_touch_ad'),
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
    check('contacts_ctwa_cl_id_shape', sql`${t['ctwaClId']!} IS NULL OR length(btrim(${t['ctwaClId']!})) BETWEEN 1 AND 500`),
    check('contacts_touch_source_shape', sql`(${t['firstTouchSource']!} IS NULL OR ${t['firstTouchSource']!} ~ '^[a-z][a-z0-9_]{1,31}$') AND (${t['lastTouchSource']!} IS NULL OR ${t['lastTouchSource']!} ~ '^[a-z][a-z0-9_]{1,31}$')`),
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

/**
 * Etiquetas (M3.3, ADR-45). Las del SISTEMA (`lead`, `appointment`, `sale`) las crea el servicio al primer uso en cada empresa, no se borran ni se renombran
 * y solo las pone el sistema. Las personalizadas llegan en M3.4. `app_rw` no tiene DELETE (borrado lógico).
 */
export const tags = tenantTable(
  'tags',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6a44f2'),
    isSystem: boolean('is_system').notNull().default(false),
    systemKey: text('system_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('tags_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 60`),
    check('tags_color_shape', sql`${t['color']!} ~ '^#[0-9a-fA-F]{6}$'`),
    check('tags_system_key_valid', sql`${t['systemKey']!} IS NULL OR ${t['systemKey']!} IN ('lead', 'appointment', 'sale')`),
    check('tags_system_consistent', sql`${t['isSystem']!} = (${t['systemKey']!} IS NOT NULL)`),
    uniqueIndex('tags_org_system_key_uq').on(t['organizationId']!, t['systemKey']!).where(sql`${t['systemKey']!} IS NOT NULL`),
    uniqueIndex('tags_org_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/** Etiqueta puesta a un contacto. `set_by`: quién la puso (`system` o `user`). */
export const contactTags = tenantTable(
  'contact_tags',
  {
    contactId: uuid('contact_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    setBy: text('set_by').notNull().default('user'),
    setAt: ts('set_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'contact_tags_pk', columns: [t['organizationId']!, t['contactId']!, t['tagId']!] }),
    foreignKey({ name: 'contact_tags_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    foreignKey({ name: 'contact_tags_tag_fk', columns: [t['organizationId']!, t['tagId']!], foreignColumns: [tags.organizationId, tags.id] }),
    check('contact_tags_set_by_valid', sql`${t['setBy']!} IN ('system', 'user')`),
    index('contact_tags_contact_idx').on(t['organizationId']!, t['contactId']!),
  ],
);

/**
 * Salida de eventos a Meta (outbox, Build Spec §6.6). Se escribe en la misma transacción que el cambio que la origina. `event_id` es estable
 * (idempotencia en Meta y aquí). `payload` NO lleva el teléfono en claro: solo su huella SHA-256 (privacidad). El envío real llega en M6.
 */
export const metaEvents = tenantTable(
  'meta_events',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    contactId: uuid('contact_id').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    sendAfter: ts('send_after').notNull(),
    sentAt: ts('sent_at'),
    lastError: text('last_error'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'meta_events_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('meta_events_type_valid', sql`${t['type']!} IN ('Lead', 'Schedule', 'Purchase', 'SaleCanceled')`),
    check('meta_events_status_valid', sql`${t['status']!} IN ('pending', 'sent', 'skipped', 'blocked', 'failed', 'expired', 'cancelled')`),
    check('meta_events_attempts_valid', sql`${t['attempts']!} >= 0`),
    check('meta_events_event_id_shape', sql`length(${t['eventId']!}) BETWEEN 1 AND 200`),
    uniqueIndex('meta_events_org_event_id_uq').on(t['organizationId']!, t['eventId']!),
    index('meta_events_pending_idx').on(t['organizationId']!, t['sendAfter']!).where(sql`${t['status']!} = 'pending'`),
    index('meta_events_contact_idx').on(t['organizationId']!, t['contactId']!, t['type']!, t['createdAt']!),
  ],
);
