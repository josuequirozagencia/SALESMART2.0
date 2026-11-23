import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Carpetas de la biblioteca de archivos (V21, ADR-75): UN solo nivel (los archivos cuelgan de una carpeta o de la raíz). TABLA DE NEGOCIO: `organization_id` + RLS FORZADA. Sin DELETE: se archiva
 * (`archived_at`). El nombre es único entre las carpetas vigentes de la empresa, sin distinguir mayúsculas.
 */
export const mediaFolders = tenantTable(
  'media_folders',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    archivedAt: ts('archived_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('media_folders_name_len', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 80`),
    uniqueIndex('media_folders_org_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['archivedAt']!} IS NULL`),
  ],
);

/**
 * Archivos de la biblioteca (V21, ADR-75): fotos de productos, catálogos, PDF, audios y videos que el administrador sube y los asesores envían desde el chat (y las automatizaciones adjuntan). El
 * objeto vive bajo `org/<empresa>/library/<id>` y solo se entrega por URL firmada de pocos minutos. Pasó por las mismas reglas que un adjunto (tipo por contenido, tamaño por tipo, antivirus):
 * uno infectado nunca llega aquí. Enviarlo COPIA el objeto a un adjunto propio del mensaje, así que archivarlo no rompe lo ya enviado y el vencimiento de los adjuntos no lo alcanza. Sin DELETE:
 * se archiva y la tarea no borra el objeto (lo hace solo la eliminación definitiva de la empresa). El uso de espacio se DERIVA de `size_bytes` de los `ready`: nunca es un campo editable.
 */
export const mediaAssets = tenantTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    folderId: uuid('folder_id'),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    checksum: text('checksum').notNull(),
    scanStatus: text('scan_status').notNull(),
    state: text('state').notNull().default('ready'),
    /** Los asesores solo ven y envían los archivos marcados para ellos (por omisión, sí). */
    usableByAdvisors: boolean('usable_by_advisors').notNull().default(true),
    /** Reservado para V22 (la IA compartirá archivos): hoy no tiene efecto. */
    usableByAi: boolean('usable_by_ai').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'media_assets_folder_fk', columns: [t['organizationId']!, t['folderId']!], foreignColumns: [mediaFolders.organizationId, mediaFolders.id] }),
    check('media_assets_kind_valid', sql`${t['kind']!} IN ('image', 'video', 'audio', 'document')`),
    check('media_assets_state_valid', sql`${t['state']!} IN ('ready', 'archived')`),
    check('media_assets_scan_valid', sql`${t['scanStatus']!} IN ('clean', 'skipped')`),
    check('media_assets_size_valid', sql`${t['sizeBytes']!} BETWEEN 1 AND 26214400`),
    check('media_assets_name_len', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 200 AND length(${t['mimeType']!}) BETWEEN 3 AND 127 AND (${t['description']!} IS NULL OR length(${t['description']!}) <= 300)`),
    check('media_assets_archived_consistent', sql`(${t['state']!} = 'archived') = (${t['archivedAt']!} IS NOT NULL)`),
    index('media_assets_org_state_idx').on(t['organizationId']!, t['state']!, t['folderId']!),
    index('media_assets_org_created_idx').on(t['organizationId']!, t['createdAt']!, t['id']!),
  ],
);
