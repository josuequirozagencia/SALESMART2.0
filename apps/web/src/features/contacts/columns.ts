import type { CustomField, CustomValue } from '../../lib/types';
import { shortDateTime } from '../../lib/format';

export interface ColumnDef {
  key: string;
  label: string;
}

/** Columnas fijas del catálogo (ADR-46 #5). Cada campo personalizado activo suma la suya: \`cf:<variable>\`. */
export const FIXED_COLUMNS: readonly ColumnDef[] = [
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
export const DEFAULT_COLUMNS: readonly string[] = ['name', 'phone', 'owner', 'consent', 'tags', 'created_at'];

export const catalogOf = (fields: readonly CustomField[]): ColumnDef[] => [...FIXED_COLUMNS, ...fields.filter((f) => f.archived_at === null).map((f) => ({ key: `cf:${f.key}`, label: f.name }))];

/** Deja solo columnas que existen, sin repetidas, con «Nombre» siempre primero (es desde donde se abre el contacto). Sin nada válido, las de por defecto. */
export function normalizeColumns(keys: readonly string[] | null | undefined, catalog: readonly ColumnDef[]): string[] {
  const known = new Set(catalog.map((c) => c.key));
  const out = [...new Set((keys ?? []).filter((k) => known.has(k) && k !== 'name'))];
  const base = out.length > 0 ? out : DEFAULT_COLUMNS.filter((k) => k !== 'name' && known.has(k));
  return ['name', ...base];
}

const STORE = 'ss:contacts:columns';
/** Las columnas de «Todos» son una comodidad de cada navegador (ADR-46 #5); si el almacenamiento falla, se usan las de por defecto. */
export function loadColumns(): string[] | null {
  try {
    const raw = window.localStorage.getItem(STORE);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  } catch {
    return null;
  }
}
export function saveColumns(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(keys));
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}

/** Valor de un campo personalizado como texto para la tabla. */
export function customText(field: CustomField | undefined, v: CustomValue | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (field?.type === 'datetime' && typeof v === 'string') return shortDateTime(v);
  if (field?.type === 'date' && typeof v === 'string') return v.split('-').reverse().join('/');
  if (typeof v === 'number') return v.toLocaleString('es-EC', { maximumFractionDigits: 6 });
  return v;
}
