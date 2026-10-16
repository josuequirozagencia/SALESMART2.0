import { z } from 'zod';

/**
 * Tipos de campo personalizado y validación/normalización de sus valores (M3.2, ADR-44). Código PURO (sin BD): la regla vive aquí y la usan el servicio
 * de definiciones y el de valores. El servidor valida siempre; la web solo ayuda.
 */

export const ENTITIES = ['contact', 'opportunity', 'company'] as const;
export type CustomEntity = (typeof ENTITIES)[number];
/** Entidades que la API acepta HOY (oportunidades y empresas llegan con sus módulos; la BD ya las admite). */
export const ACTIVE_ENTITIES = ['contact'] as const;

export const FIELD_TYPES = ['text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'email', 'phone', 'url', 'select', 'multiselect'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const isOptionType = (t: FieldType): boolean => t === 'select' || t === 'multiselect';
const isNumberType = (t: FieldType): boolean => t === 'number' || t === 'currency' || t === 'percent';

/** Límites (PROVISIONALES: los planes podrán fijar el tope de campos). */
export const MAX_FIELDS_PER_ENTITY = 50;
export const MAX_OPTIONS = 50;
export const MAX_OPTION_LENGTH = 100;
const MAX_TEXT = 500;
const MAX_LONG_TEXT = 5000;
const MAX_URL = 2000;
const MAX_ABS_NUMBER = 1_000_000_000;
const MAX_DECIMALS = 6;

/** Valor tal como se envía y se devuelve por la API. `null` = vacío. */
export type CustomValue = string | number | boolean | string[];
export type CustomValues = Record<string, CustomValue>;

/** Variables que ya significan otra cosa en plantillas y automatizaciones (campos estándar del contacto): un campo personalizado no puede llamarse así. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'id', 'name', 'nombre', 'email', 'correo', 'phone', 'telefono', 'whatsapp', 'owner', 'responsable', 'asignado', 'source', 'fuente', 'origen',
  'consent', 'consentimiento', 'tags', 'etiquetas', 'company', 'empresa', 'created_at', 'updated_at', 'creado', 'actualizado',
]);

/** «Fecha de nacimiento» → `fecha_de_nacimiento`: sin acentos, minúsculas, `_`, empieza con letra, hasta 40 caracteres. Vacío → `campo`. */
export function slugifyKey(name: string): string {
  let k = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (k === '') k = 'campo';
  if (!/^[a-z]/.test(k)) k = `campo_${k}`;
  return k.slice(0, 40).replace(/_+$/g, '');
}

/** Opciones de una lista: sin vacías, recortadas, sin repetidos (sin distinguir mayúsculas), 1..50 de hasta 100 caracteres. null si no son válidas. */
export function cleanOptions(raw: readonly string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    const t = o.trim();
    if (t === '') continue;
    if (t.length > MAX_OPTION_LENGTH || /\p{Cc}/u.test(t)) return null;
    const k = t.toLowerCase();
    if (seen.has(k)) return null;
    seen.add(k);
    out.push(t);
  }
  return out.length >= 1 && out.length <= MAX_OPTIONS ? out : null;
}

/** Valor normalizado a las columnas tipadas de `custom_field_values`. */
export type Normalized =
  | { kind: 'text'; v: string }
  | { kind: 'number'; v: string }
  | { kind: 'bool'; v: boolean }
  | { kind: 'date'; v: string }
  | { kind: 'datetime'; v: Date }
  | { kind: 'json'; v: string[] };

export type Coerced = { ok: true; value: Normalized | null } | { ok: false; code: string; message: string };
const bad = (code: string, message: string): Coerced => ({ ok: false, code, message });
const good = (value: Normalized | null): Coerced => ({ ok: true, value });

/** Vacío: null, texto en blanco o lista vacía. `false` y `0` SON valores. */
const isEmpty = (raw: unknown): boolean => raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);

const emailSchema = z.email();
const hasControl = (s: string): boolean => /\p{Cc}/u.test(s);

function parseNumber(raw: unknown): string | null {
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    s = String(raw);
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null; // sin notación científica, sin separadores de miles
  const [int = '', dec = ''] = s.replace(/^-/, '').split('.');
  if (dec.length > MAX_DECIMALS) return null;
  if (Math.abs(Number(s)) >= MAX_ABS_NUMBER) return null;
  // «-0», «007» → forma canónica
  const canon = `${Number(s) < 0 ? '-' : ''}${int.replace(/^0+(?=\d)/, '')}${dec ? `.${dec.replace(/0+$/, '')}` : ''}`.replace(/\.$/, '');
  return canon === '-0' ? '0' : canon;
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Valida y normaliza el valor recibido para un campo de ese tipo. `options` solo se usa en `select`/`multiselect`.
 * Devuelve `value: null` para «vaciar». Los mensajes son para la persona (sin datos internos).
 */
export function coerceValue(type: FieldType, options: readonly string[] | null, raw: unknown): Coerced {
  if (isEmpty(raw)) return good(null);
  switch (type) {
    case 'text':
    case 'long_text': {
      if (typeof raw !== 'string') return bad('invalid', 'Escribe un texto');
      const max = type === 'text' ? MAX_TEXT : MAX_LONG_TEXT;
      const s = raw.trim();
      if (s.length > max) return bad('too_long', `Usa como máximo ${max} caracteres`);
      if (hasControl(type === 'long_text' ? s.replace(/[\n\r\t]/g, ' ') : s)) return bad('invalid', 'Contiene caracteres no permitidos');
      return good({ kind: 'text', v: s });
    }
    case 'number':
    case 'currency':
    case 'percent': {
      const n = parseNumber(raw);
      return n === null ? bad('invalid', `Escribe un número (hasta ${MAX_DECIMALS} decimales, menor que mil millones)`) : good({ kind: 'number', v: n });
    }
    case 'boolean':
      return typeof raw === 'boolean' ? good({ kind: 'bool', v: raw }) : bad('invalid', 'Elige Sí o No');
    case 'date':
      return typeof raw === 'string' && validDate(raw.trim()) ? good({ kind: 'date', v: raw.trim() }) : bad('invalid', 'Escribe una fecha válida (AAAA-MM-DD)');
    case 'datetime': {
      if (typeof raw !== 'string') return bad('invalid', 'Escribe una fecha y hora válidas');
      const ok = z.iso.datetime({ offset: true }).safeParse(raw.trim());
      return ok.success ? good({ kind: 'datetime', v: new Date(ok.data) }) : bad('invalid', 'Escribe una fecha y hora válidas con zona horaria');
    }
    case 'email': {
      if (typeof raw !== 'string') return bad('invalid', 'Escribe un correo válido');
      const s = raw.trim();
      return s.length <= 254 && emailSchema.safeParse(s).success ? good({ kind: 'text', v: s.toLowerCase() }) : bad('invalid', 'Escribe un correo válido');
    }
    case 'phone': {
      if (typeof raw !== 'string') return bad('invalid', 'Escribe un teléfono en formato internacional');
      const s = raw.trim();
      return /^\+[1-9]\d{7,14}$/.test(s) ? good({ kind: 'text', v: s }) : bad('invalid', 'Escribe el teléfono en formato internacional, por ejemplo +593987654321');
    }
    case 'url': {
      if (typeof raw !== 'string') return bad('invalid', 'Escribe una dirección web válida');
      const s = raw.trim();
      if (s.length > MAX_URL) return bad('too_long', `Usa como máximo ${MAX_URL} caracteres`);
      try {
        const u = new URL(s);
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '') return bad('invalid', 'Escribe una dirección web que empiece con http:// o https://');
      } catch {
        return bad('invalid', 'Escribe una dirección web válida');
      }
      return good({ kind: 'text', v: s });
    }
    case 'select': {
      if (typeof raw !== 'string') return bad('invalid', 'Elige una de las opciones');
      const s = raw.trim();
      return options?.includes(s) ? good({ kind: 'text', v: s }) : bad('invalid_option', 'Elige una de las opciones');
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return bad('invalid', 'Elige una o más opciones');
      const picked = new Set((raw as string[]).map((x) => x.trim()));
      if (picked.size !== raw.length) return bad('invalid', 'Hay opciones repetidas');
      const allowed = options ?? [];
      if ([...picked].some((x) => !allowed.includes(x))) return bad('invalid_option', 'Elige solo entre las opciones');
      return good({ kind: 'json', v: allowed.filter((o) => picked.has(o)) }); // en el orden de las opciones: determinista
    }
  }
}

/** Columnas de `custom_field_values` para un valor (todas en NULL salvo la suya). */
export interface ValueColumns {
  valueText: string | null;
  valueNumber: string | null;
  valueBool: boolean | null;
  valueDate: string | null;
  valueDatetime: Date | null;
  valueJson: string[] | null;
}
export const EMPTY_COLUMNS: ValueColumns = { valueText: null, valueNumber: null, valueBool: null, valueDate: null, valueDatetime: null, valueJson: null };

export function toColumns(n: Normalized | null): ValueColumns {
  if (n === null) return { ...EMPTY_COLUMNS };
  switch (n.kind) {
    case 'text': return { ...EMPTY_COLUMNS, valueText: n.v };
    case 'number': return { ...EMPTY_COLUMNS, valueNumber: n.v };
    case 'bool': return { ...EMPTY_COLUMNS, valueBool: n.v };
    case 'date': return { ...EMPTY_COLUMNS, valueDate: n.v };
    case 'datetime': return { ...EMPTY_COLUMNS, valueDatetime: n.v };
    case 'json': return { ...EMPTY_COLUMNS, valueJson: n.v };
  }
}

/** Valor tal como lo ve la API a partir de las columnas guardadas (null = vacío). */
export function fromColumns(type: FieldType, c: ValueColumns): CustomValue | null {
  if (c.valueJson !== null) return c.valueJson;
  if (c.valueBool !== null) return c.valueBool;
  if (c.valueDatetime !== null) return c.valueDatetime.toISOString();
  if (c.valueDate !== null) return c.valueDate;
  if (c.valueNumber !== null) return isNumberType(type) ? Number(c.valueNumber) : c.valueNumber;
  return c.valueText;
}

/** Valor normalizado → valor de la API (para compararlo con el guardado y para la auditoría). */
export function display(n: Normalized | null): CustomValue | null {
  if (n === null) return null;
  switch (n.kind) {
    case 'number': return Number(n.v);
    case 'datetime': return n.v.toISOString();
    default: return n.v;
  }
}
