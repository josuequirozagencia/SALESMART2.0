import { z } from 'zod';

/**
 * Filtros de contactos (M3.4, ADR-46): los mismos en `GET /contacts` y en las listas dinámicas guardadas. Esquema estricto. Los campos personalizados se
 * piden como `variable:operador[:valor]` (p. ej. `ciudad:eq:Quito`, `interes:is_set`).
 */
export const CONSENTS = ['unknown', 'granted', 'revoked'] as const;
const arrayOf = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess((v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]), z.array(item).max(max).optional());

export const contactFiltersShape = {
  q: z.string().trim().min(1).max(100).optional(),
  /** «me» (míos), «none» (sin asignar) o el id de una persona. Sin `contacts.view_all` se ignora: el alcance ya es propio. */
  owner: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
  source: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).optional(),
  consent: z.enum(CONSENTS).optional(),
  /** El contacto debe tener TODAS estas etiquetas. */
  tag: arrayOf(z.uuid(), 10),
  /** `variable:operador[:valor]`; todas deben cumplirse. */
  cf: arrayOf(z.string().min(3).max(260), 10),
};
export const contactFiltersSchema = z.object(contactFiltersShape).strict();
export type ContactFilters = z.infer<typeof contactFiltersSchema>;

export const CF_OPS = ['eq', 'contains', 'gte', 'lte', 'is_set', 'is_empty'] as const;
export type CfOp = (typeof CF_OPS)[number];
export interface CfFilter {
  key: string;
  op: CfOp;
  value: string | null;
}
/** Filtro de campo personalizado ya resuelto contra su definición. */
export interface ResolvedCf {
  definitionId: string;
  type: string;
  op: CfOp;
  value: string | null;
}

const TEXTLIKE = new Set(['text', 'long_text', 'email', 'phone', 'url']);
const NUMBERS = new Set(['number', 'currency', 'percent']);
/** Qué operadores admite cada tipo (el operador que no corresponde es un 400, no un resultado vacío silencioso). */
const OPS_BY_TYPE = (type: string): readonly CfOp[] =>
  TEXTLIKE.has(type) ? ['eq', 'contains', 'is_set', 'is_empty'] : type === 'select' ? ['eq', 'is_set', 'is_empty'] : type === 'multiselect' ? ['contains', 'is_set', 'is_empty'] : NUMBERS.has(type) || type === 'date' ? ['eq', 'gte', 'lte', 'is_set', 'is_empty'] : type === 'datetime' ? ['gte', 'lte', 'is_set', 'is_empty'] : ['eq', 'is_set', 'is_empty']; // boolean

export function parseCf(raw: string): CfFilter | null {
  const first = raw.indexOf(':');
  if (first < 1) return null;
  const key = raw.slice(0, first);
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) return null;
  const rest = raw.slice(first + 1);
  const second = rest.indexOf(':');
  const op = (second < 0 ? rest : rest.slice(0, second)) as CfOp;
  if (!CF_OPS.includes(op)) return null;
  const value = second < 0 ? null : rest.slice(second + 1);
  if (op === 'is_set' || op === 'is_empty') return value === null || value === '' ? { key, op, value: null } : null;
  return value !== null && value !== '' && value.length <= 200 ? { key, op, value } : null;
}

/** Mensaje de error si el operador o el valor no sirven para ese tipo de campo; null si están bien. */
export function checkCfValue(type: string, op: CfOp, value: string | null): string | null {
  if (!OPS_BY_TYPE(type).includes(op)) return `El operador «${op}» no se puede usar con un campo de tipo ${type}`;
  if (value === null) return null;
  if (NUMBERS.has(type) && !/^-?\d+(\.\d{1,6})?$/.test(value)) return 'El valor debe ser un número';
  if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'El valor debe ser una fecha AAAA-MM-DD';
  if (type === 'datetime' && Number.isNaN(Date.parse(value))) return 'El valor debe ser una fecha y hora ISO 8601';
  if (type === 'boolean' && value !== 'true' && value !== 'false') return 'El valor debe ser true o false';
  return null;
}

/** Mezcla los filtros guardados de una lista con los que pide la petición: lo escalar de la petición manda y las listas (etiquetas, campos) se suman. */
export function mergeFilters(saved: ContactFilters, asked: ContactFilters): ContactFilters {
  const out: ContactFilters = { ...saved };
  for (const k of ['q', 'owner', 'source', 'consent'] as const) if (asked[k] !== undefined) (out as Record<string, unknown>)[k] = asked[k];
  const tag = [...new Set([...(saved.tag ?? []), ...(asked.tag ?? [])])];
  const cf = [...(saved.cf ?? []), ...(asked.cf ?? [])];
  if (tag.length > 0) out.tag = tag;
  if (cf.length > 0) out.cf = cf;
  return out;
}
