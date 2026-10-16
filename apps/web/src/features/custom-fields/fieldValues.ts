import { normalizePhone } from '../../lib/phone';
import type { CustomField, CustomValue } from '../../lib/types';
import { isEmail } from '../../lib/validation';

/**
 * Valor de un campo personalizado tal como vive en el formulario: texto (o lista para la selección múltiple). El Sí/No es '' | 'true' | 'false'
 * (tres estados: sin responder no es lo mismo que «No»). Solo ayuda de interfaz; el servidor valida siempre (ADR-44).
 */
export type RawValue = string | string[];

const pad = (n: number): string => String(n).padStart(2, '0');
/** ISO (UTC) → valor de `<input type="datetime-local">` en la hora del navegador. */
const isoToLocal = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function toRaw(def: CustomField, value: CustomValue | undefined): RawValue {
  if (def.type === 'multiselect') return Array.isArray(value) ? value : [];
  if (value === undefined || value === null) return '';
  if (def.type === 'boolean') return value === true ? 'true' : value === false ? 'false' : '';
  if (def.type === 'datetime' && typeof value === 'string') return isoToLocal(value);
  return String(value);
}

export const isRawEmpty = (raw: RawValue): boolean => (Array.isArray(raw) ? raw.length === 0 : raw.trim() === '');

export type Parsed = { ok: true; value: CustomValue | null } | { ok: false; error: string };
const fail = (error: string): Parsed => ({ ok: false, error });

/** Lo escrito → lo que se envía a la API (`null` = vacío). `prefix` es el país elegido para los teléfonos sin «+». */
export function parseRaw(def: CustomField, raw: RawValue, prefix: string): Parsed {
  if (isRawEmpty(raw)) return { ok: true, value: null };
  if (Array.isArray(raw)) return { ok: true, value: raw };
  const t = raw.trim();
  switch (def.type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = t.replace(',', '.');
      return /^-?\d+(\.\d{1,6})?$/.test(n) && Math.abs(Number(n)) < 1_000_000_000 ? { ok: true, value: n } : fail('Escribe un número (hasta 6 decimales)');
    }
    case 'boolean':
      return { ok: true, value: t === 'true' };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { ok: true, value: t } : fail('Elige una fecha válida');
    case 'datetime': {
      const d = new Date(t);
      return Number.isNaN(d.getTime()) ? fail('Elige una fecha y hora válidas') : { ok: true, value: d.toISOString() };
    }
    case 'email':
      return isEmail(t.toLowerCase()) ? { ok: true, value: t.toLowerCase() } : fail('Escribe un correo válido');
    case 'phone': {
      const e164 = normalizePhone(t, prefix);
      return e164 ? { ok: true, value: e164 } : fail('Número no válido: usa de 8 a 15 dígitos (con el prefijo del país o «+»)');
    }
    case 'url':
      try {
        const u = new URL(t);
        return u.protocol === 'http:' || u.protocol === 'https:' ? { ok: true, value: t } : fail('Escribe una dirección que empiece con http:// o https://');
      } catch {
        return fail('Escribe una dirección web válida');
      }
    case 'text':
      return t.length <= 500 ? { ok: true, value: t } : fail('Usa como máximo 500 caracteres');
    case 'long_text':
      return t.length <= 5000 ? { ok: true, value: t } : fail('Usa como máximo 5000 caracteres');
    default:
      return { ok: true, value: t };
  }
}
