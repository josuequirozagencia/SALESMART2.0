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
  ],
);
