import { z } from 'zod';
import { contactFiltersSchema } from './contact-filters';
import { SORTS } from './contacts.dto';

const name = z.string().trim().min(1).max(60).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
/** Columnas del catálogo (ADR-46 #5): las fijas y `cf:<variable>` para un campo personalizado. */
const columnKey = z.string().regex(/^(?:name|phone|email|company|owner|source|consent|tags|created_at|updated_at|campaign|cf:[a-z][a-z0-9_]{0,39})$/);
const columns = z.array(columnKey).min(1).max(40).refine((a) => new Set(a).size === a.length, 'hay columnas repetidas');
const sort = z.object({ key: z.enum(SORTS), order: z.enum(['asc', 'desc']) }).strict();
const contactIds = z.array(z.uuid()).min(1).max(500).refine((a) => new Set(a).size === a.length, 'hay contactos repetidos');

export const MAX_LISTS_PER_OWNER = 100;
export const MAX_LIST_MEMBERS = 5000;

/** Lista nueva. Dinámica: filtros (se recalcula sola). Fija: los contactos elegidos (hasta 500 al crearla). Ambas pueden guardar columnas y orden. */
export const createListSchema = z
  .object({
    name,
    kind: z.enum(['dynamic', 'fixed']),
    filters: contactFiltersSchema.optional(),
    columns: columns.optional(),
    sort: sort.optional(),
    shared: z.boolean().optional(),
    contact_ids: contactIds.optional(),
  })
  .strict()
  .refine((b) => b.kind === 'fixed' || b.contact_ids === undefined, { path: ['contact_ids'], message: 'solo las listas fijas tienen contactos' })
  .refine((b) => b.kind === 'dynamic' || b.filters === undefined, { path: ['filters'], message: 'solo las listas dinámicas tienen filtros' });
export type CreateListDto = z.infer<typeof createListSchema>;

/** Cambio PARCIAL. El tipo no cambia. `null` quita las columnas o el orden guardados. */
export const updateListSchema = z
  .object({ name: name.optional(), shared: z.boolean().optional(), filters: contactFiltersSchema.optional(), columns: columns.nullable().optional(), sort: sort.nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateListDto = z.infer<typeof updateListSchema>;

export const membersSchema = z.object({ contact_ids: contactIds }).strict();
export type MembersDto = z.infer<typeof membersSchema>;
