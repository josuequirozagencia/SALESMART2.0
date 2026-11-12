import { sql } from 'drizzle-orm';
import { check, integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { platformTable } from './helpers';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Marca de la PLATAFORMA (v11 S3): hoy solo el favicon que el Súper Admin sube. Tabla de plataforma (solo `app_platform`; la API de cliente y de agencia no la ve), UNA sola fila (`id = 1`).
 * El archivo vive en el almacenamiento bajo `platform/branding/favicon-<uuid>` (nunca bajo una organización); aquí solo la referencia. `favicon_version` cambia en cada subida y hace de
 * ETag. Quitar el favicon pone todo en NULL (no se borra la fila): la plataforma vuelve al icono por omisión.
 */
export const platformBranding = platformTable(
  'platform_branding',
  {
    id: smallint('id').primaryKey().default(1),
    faviconKey: text('favicon_key'),
    faviconContentType: text('favicon_content_type'),
    faviconBytes: integer('favicon_bytes'),
    faviconPx: integer('favicon_px'),
    faviconVersion: uuid('favicon_version'),
    /** Nombre de la plataforma (texto de la pestaña); NULL = «Sales Smart 2.0». Y su versión corta para el manifest (hasta 12). */
    appName: text('app_name'),
    appShortName: text('app_short_name'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('platform_branding_single_row', sql`${t.id} = 1`),
    check('platform_branding_favicon_consistent', sql`(${t.faviconKey} IS NULL) = (${t.faviconVersion} IS NULL) AND (${t.faviconKey} IS NULL) = (${t.faviconContentType} IS NULL)`),
    check('platform_branding_favicon_type', sql`${t.faviconContentType} IS NULL OR ${t.faviconContentType} IN ('image/png', 'image/x-icon', 'image/webp')`),
    check('platform_branding_favicon_key_shape', sql`${t.faviconKey} IS NULL OR ${t.faviconKey} ~ '^platform/branding/favicon-[0-9a-f-]{36}$'`),
    check('platform_branding_favicon_size', sql`${t.faviconBytes} IS NULL OR (${t.faviconBytes} > 0 AND ${t.faviconBytes} <= 262144)`),
    check('platform_branding_favicon_px', sql`${t.faviconPx} IS NULL OR (${t.faviconPx} >= 32 AND ${t.faviconPx} <= 512)`),
    check('platform_branding_name_valid', sql`${t.appName} IS NULL OR (length(${t.appName}) BETWEEN 2 AND 40 AND ${t.appName} !~ '[<>]')`),
    check('platform_branding_short_name_valid', sql`${t.appShortName} IS NULL OR (length(${t.appShortName}) BETWEEN 1 AND 12 AND ${t.appShortName} !~ '[<>]')`),
  ],
);

/**
 * Un archivo de la marca de la PLATAFORMA (tabla de plataforma: solo `app_platform`). Una fila por archivo; el archivo vive en el almacenamiento bajo `platform/branding/<asset>-<uuid>` (nunca bajo
 * una organización) y aquí solo la referencia. `version` cambia en cada subida y hace de ETag y de parámetro `?v=` de las direcciones. Restaurar el valor por defecto borra la fila.
 */
export const platformBrandingAssets = platformTable(
  'platform_branding_assets',
  {
    asset: text('asset').primaryKey(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    px: integer('px'),
    version: uuid('version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('platform_branding_assets_name', sql`${t.asset} IN ('logo-light', 'logo-dark', 'icon-32', 'icon-48', 'icon-180', 'icon-192', 'icon-512', 'badge-96', 'sound')`),
    check('platform_branding_assets_type', sql`${t.contentType} IN ('image/png', 'image/webp', 'audio/mpeg', 'audio/mp4')`),
    check('platform_branding_assets_key', sql`${t.storageKey} ~ '^platform/branding/[a-z0-9-]+-[0-9a-f-]{36}$'`),
    check('platform_branding_assets_size', sql`${t.bytes} > 0 AND ${t.bytes} <= 1048576`),
  ],
);
