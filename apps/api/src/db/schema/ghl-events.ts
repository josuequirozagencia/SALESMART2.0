import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { contacts } from './crm';
import { tenantTable } from './helpers';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Aviso que llegó del Workflow de GoHighLevel (M7.2, ADR-52), ya asignado a su empresa. Se guarda solo lo que el contrato conoce (identificador y datos básicos del contacto de GHL), NUNCA
 * el cuerpo completo de la petición. El webhook solo valida y guarda; la tarea de proceso lo aplica. Estados: `pending` · `done` · `skipped` (no había nada que hacer, con su `note`) ·
 * `failed`. El contenido se vacía a los 30 días (provisional): `payload` pasa a NULL y la fila queda como registro. Sin DELETE.
 */
export const ghlEvents = tenantTable(
  'ghl_events',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** Para no procesar dos veces el mismo aviso: el `event_id` que mande el Workflow o, si no, la huella del contenido dentro de una ventana de 10 minutos. */
    dedupeKey: text('dedupe_key').notNull(),
    eventType: text('event_type').notNull(),
    ghlContactId: text('ghl_contact_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    status: text('status').notNull().default('pending'),
    /** Qué se hizo: `contact_created` | `contact_linked` | `contact_updated` | `contact_unchanged` (solo cuando `status = done`). */
    outcome: text('outcome'),
    /** Texto para el administrador (por qué se omitió). Nunca datos personales. */
    note: text('note'),
    contactId: uuid('contact_id'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    /** Solo códigos y nombres de error: nunca un teléfono ni un correo. */
    lastError: text('last_error'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    redactedAt: ts('redacted_at'),
  },
  (t) => [
    foreignKey({ name: 'ghl_events_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('ghl_events_type_valid', sql`${t['eventType']!} IN ('contact', 'message_in')`),
    check('ghl_events_status_valid', sql`${t['status']!} IN ('pending', 'done', 'skipped', 'failed')`),
    check('ghl_events_outcome_valid', sql`${t['outcome']!} IS NULL OR ${t['outcome']!} IN ('contact_created', 'contact_linked', 'contact_updated', 'contact_unchanged', 'message_received')`),
    check('ghl_events_ghl_contact_shape', sql`length(${t['ghlContactId']!}) BETWEEN 1 AND 100`),
    check('ghl_events_dedupe_shape', sql`length(${t['dedupeKey']!}) BETWEEN 1 AND 200`),
    check('ghl_events_attempts_valid', sql`${t['attempts']!} >= 0`),
    check('ghl_events_note_len', sql`${t['note']!} IS NULL OR length(${t['note']!}) <= 200`),
    check('ghl_events_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    uniqueIndex('ghl_events_org_dedupe_uq').on(t['organizationId']!, t['dedupeKey']!),
    index('ghl_events_due_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['status']!} = 'pending'`),
    index('ghl_events_recent_idx').on(t['organizationId']!, t['receivedAt']!, t['id']!),
    index('ghl_events_redact_idx').on(t['organizationId']!, t['processedAt']!).where(sql`${t['payload']!} IS NOT NULL AND ${t['status']!} <> 'pending'`),
  ],
);

/**
 * Vínculo entre un contacto de GoHighLevel y un contacto de la empresa (M7.2, ADR-52; el «external_ids» del Build Spec, con clave foránea compuesta al contacto). Uno a uno: un contacto de GHL
 * apunta a un solo contacto y viceversa. Sin DELETE: si el contacto se borra, el vínculo se reemplaza al volver a llegar.
 */
export const ghlContactLinks = tenantTable(
  'ghl_contact_links',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    ghlContactId: text('ghl_contact_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    /** Estado de sincronización de etiquetas (M7.3, anti-eco): las etiquetas del contacto en GHL la última vez que lo supimos, en minúsculas. Nulo = aún no se sabe. */
    tags: jsonb('tags').$type<string[]>(),
    tagsAt: ts('tags_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'ghl_contact_links_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('ghl_contact_links_ghl_id_shape', sql`length(${t['ghlContactId']!}) BETWEEN 1 AND 100`),
    uniqueIndex('ghl_contact_links_ghl_uq').on(t['organizationId']!, t['ghlContactId']!),
    uniqueIndex('ghl_contact_links_contact_uq').on(t['organizationId']!, t['contactId']!),
    check('ghl_contact_links_tags_array', sql`${t['tags']!} IS NULL OR jsonb_typeof(${t['tags']!}) = 'array'`),
  ],
);

/**
 * Salida hacia GoHighLevel (M7.3, ADR-52): cada etiqueta que se pone o se quita de un contacto —y cada etiqueta que se BORRA— aquí y que GHL debe reflejar. Se escribe en la MISMA transacción que el cambio de etiqueta (nunca se pierde) y
 * la tarea la envía en orden por contacto, con reintentos. Un cambio que VINO de GHL no entra aquí (anti-eco). Estados: `pending` · `done` · `skipped` (con su `note`) · `failed`. Sin DELETE.
 */
export const ghlOutbox = tenantTable(
  'ghl_outbox',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** Nulo solo en `tag_delete` (borrar la etiqueta en GHL no es de un contacto). */
    contactId: uuid('contact_id'),
    op: text('op').notNull(),
    tagName: text('tag_name').notNull(),
    tagKind: text('tag_kind').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    /** Solo códigos y nombres de error: nunca un teléfono ni un correo. */
    lastError: text('last_error'),
    /** Texto para el administrador (por qué se omitió). */
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
  },
  (t) => [
    foreignKey({ name: 'ghl_outbox_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('ghl_outbox_op_valid', sql`${t['op']!} IN ('tag_add', 'tag_remove', 'tag_delete')`),
    check('ghl_outbox_contact_by_op', sql`(${t['op']!} = 'tag_delete' AND ${t['contactId']!} IS NULL) OR (${t['op']!} <> 'tag_delete' AND ${t['contactId']!} IS NOT NULL)`),
    check('ghl_outbox_kind_valid', sql`${t['tagKind']!} IN ('system', 'custom')`),
    check('ghl_outbox_status_valid', sql`${t['status']!} IN ('pending', 'done', 'skipped', 'failed')`),
    check('ghl_outbox_tag_shape', sql`length(btrim(${t['tagName']!})) BETWEEN 1 AND 100`),
    check('ghl_outbox_attempts_valid', sql`${t['attempts']!} >= 0`),
    check('ghl_outbox_note_len', sql`${t['note']!} IS NULL OR length(${t['note']!}) <= 200`),
    check('ghl_outbox_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    index('ghl_outbox_due_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['status']!} = 'pending'`),
    index('ghl_outbox_contact_idx').on(t['organizationId']!, t['contactId']!, t['createdAt']!, t['id']!).where(sql`${t['status']!} = 'pending'`),
    index('ghl_outbox_recent_idx').on(t['organizationId']!, t['createdAt']!, t['id']!),
  ],
);
