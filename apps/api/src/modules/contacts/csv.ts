/**
 * Escritura de CSV (RFC 4180) para exportaciones y reportes (M3.5, ADR-47). Dos protecciones:
 *  - Comillas dobles, comas y saltos de línea dentro de una celda se escapan como pide el formato.
 *  - **Inyección de fórmulas:** un TEXTO que empieza por `=`, `+`, `-`, `@`, tabulación o retorno de carro se interpretaría como fórmula al abrirlo en una
 *    hoja de cálculo; se le antepone una comilla simple. Los números (aunque sean negativos) no se tocan. La importación quita esa comilla al volver a leer.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: readonly unknown[]): string => cells.map(csvCell).join(',');

/** Archivo completo: BOM UTF-8 (para que Excel respete los acentos) y líneas con CRLF. */
export const csvFile = (lines: readonly (readonly unknown[])[]): string => `\uFEFF${lines.map(csvLine).join('\r\n')}\r\n`;
