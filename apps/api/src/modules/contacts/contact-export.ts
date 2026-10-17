import { z } from 'zod';
import { contactFiltersShape } from './contact-filters';
import type { ContactView } from './contacts.service';
import { SORTS } from './contacts.dto';

/** Topes provisionales (ADR-47 #8). */
export const MAX_EXPORT_ROWS = 20_000;
export const MAX_EXPORT_SELECTION = 5_000;

const columnKey = z.string().regex(/^(?:name|phone|email|owner|source|consent|tags|created_at|updated_at|campaign|cf:[a-z][a-z0-9_]{0,39})$/);

/** Qué exportar: la selección, la vista actual (filtros, búsqueda y lista abierta) o todo lo que la persona puede ver; y con qué columnas. */
export const exportSchema = z
  .object({
    scope: z.enum(['selection', 'view', 'all']),
    ids: z.array(z.uuid()).min(1).max(MAX_EXPORT_SELECTION).optional(),
    columns: z.array(columnKey).min(1).max(60).refine((a) => new Set(a).size === a.length, 'hay columnas repetidas').optional(),
    ...contactFiltersShape,
    list: z.uuid().optional(),
    sort: z.enum(SORTS).default('created_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine((b) => b.scope !== 'selection' || (b.ids !== undefined && b.ids.length > 0), { path: ['ids'], message: 'elige al menos un contacto' });
export type ExportDto = z.infer<typeof exportSchema>;

/** Columnas fijas y su rótulo (las mismas del catálogo de la tabla). Cada campo personalizado activo suma la suya: `cf:<variable>`. */
export const FIXED_EXPORT: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'name', label: 'Nombre' },
  { key: 'phone', label: 'Teléfono' },
  { key: 'email', label: 'Correo' },
  { key: 'owner', label: 'Responsable' },
  { key: 'source', label: 'Origen' },
  { key: 'consent', label: 'Consentimiento' },
  { key: 'tags', label: 'Etiquetas' },
  { key: 'campaign', label: 'Último anuncio' },
  { key: 'created_at', label: 'Creado' },
  { key: 'updated_at', label: 'Actualizado' },
];
const CONSENT: Record<string, string> = { granted: 'Con consentimiento', revoked: 'Sin consentimiento', unknown: 'Sin definir' };
const SEP = ' | ';

/** Valor de una celda de la exportación. Los campos personalizados salen en forma legible (Sí/No, listas con « | »). */
export function exportCell(c: ContactView, key: string): unknown {
  switch (key) {
    case 'name': return c.name;
    case 'phone': return c.phones.map((p) => p.e164).join(SEP);
    case 'email': return c.email ?? '';
    case 'owner': return c.owner?.name ?? '';
    case 'source': return c.source;
    case 'consent': return CONSENT[c.consent] ?? c.consent;
    case 'tags': return c.tags.map((t) => t.name).join(SEP);
    case 'campaign': return c.attribution?.last_touch?.campaign ?? '';
    case 'created_at': return c.created_at;
    case 'updated_at': return c.updated_at;
    default: {
      const v = c.custom_fields[key.slice(3)];
      if (v === undefined || v === null) return '';
      if (typeof v === 'boolean') return v ? 'Sí' : 'No';
      if (Array.isArray(v)) return v.join(SEP);
      return v;
    }
  }
}
