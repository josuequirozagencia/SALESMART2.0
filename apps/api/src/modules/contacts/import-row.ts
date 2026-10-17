import type { FieldType } from '../custom-fields/field-types';

/**
 * Lectura de UNA fila de un CSV de contactos (M3.5, ADR-47). Código puro, sin BD: la vista previa y el proceso real usan exactamente estas reglas.
 * `mapping[i]` es el destino de la columna i: `ignore`, `name`, `phone`, `email` o `cf:<variable>`.
 */
export interface RowPlan {
  name: string | null;
  /** E.164, el primero es el principal; sin repetidos, hasta 5. */
  phones: string[];
  email: string | null;
  /** Valores de campos personalizados ya convertidos al formato de la API (`variable → valor`); solo los que traen dato. */
  cf: Record<string, unknown>;
  /** Motivos por los que la fila se rechaza (vacío = la fila es válida). */
  errors: string[];
}

export const MAX_ROW_PHONES = 5;
const hasControl = (s: string): boolean => /\p{Cc}/u.test(s);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Número como lo escribe la gente → E.164. Con «+» al inicio se respeta como internacional; sin él se antepone el prefijo del país elegido (quitando el «0»
 * de marcación nacional). null si no tiene la forma de un E.164 (8 a 15 dígitos).
 */
export function toE164(input: string, countryPrefix: string): string | null {
  const t = input.trim();
  if (t === '') return null;
  const digits = t.replace(/\D/g, '').replace(/^0+/, '');
  const e164 = t.startsWith('+') ? `+${digits}` : `${countryPrefix}${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

const TRUE_WORDS = new Set(['si', 'sí', 'true', 'verdadero', 'yes', '1', 'x']);
const FALSE_WORDS = new Set(['no', 'false', 'falso', '0']);

/** Texto de una celda → el valor que espera la API para ese tipo de campo (la validación fina la hace el servicio de campos). */
export function cfValue(type: FieldType | undefined, cell: string): unknown {
  const t = cell.trim();
  if (type === 'boolean') {
    const w = t.toLowerCase();
    return TRUE_WORDS.has(w) ? true : FALSE_WORDS.has(w) ? false : t; // lo que no se entiende pasa tal cual y falla la validación
  }
  if (type === 'multiselect') return t.split(/[|;]/).map((x) => x.trim()).filter(Boolean);
  if (type === 'number' || type === 'currency' || type === 'percent') return t.replace(',', '.');
  return t;
}

export function planRow(cells: readonly string[], mapping: readonly string[], countryPrefix: string, types: ReadonlyMap<string, FieldType>): RowPlan {
  const plan: RowPlan = { name: null, phones: [], email: null, cf: {}, errors: [] };
  let phoneCell = '';
  mapping.forEach((target, i) => {
    // Un archivo exportado por nosotros antepone «'» a lo que parecería una fórmula (p. ej. +593…): se quita al volver a importarlo
    const cell = (cells[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
    if (target === 'name') {
      if (cell === '') return;
      if (cell.length > 200 || hasControl(cell)) plan.errors.push('Nombre no válido');
      else plan.name = cell;
    } else if (target === 'phone') phoneCell = cell;
    else if (target === 'email') {
      if (cell === '') return;
      const e = cell.toLowerCase();
      if (e.length > 254 || !EMAIL.test(e)) plan.errors.push('Correo no válido');
      else plan.email = e;
    } else if (target.startsWith('cf:') && cell !== '') {
      const key = target.slice(3);
      plan.cf[key] = cfValue(types.get(key), cell);
    }
  });
  if (phoneCell === '') plan.errors.push('Falta el teléfono');
  else {
    const pieces = phoneCell.split(/[|;/]/).map((p) => p.trim()).filter(Boolean);
    const valid = [...new Set(pieces.map((p) => toE164(p, countryPrefix)).filter((p): p is string => p !== null))].slice(0, MAX_ROW_PHONES);
    if (valid.length === 0) plan.errors.push('Teléfono no válido');
    else plan.phones = valid;
  }
  return plan;
}
