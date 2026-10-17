/**
 * Lectura de archivos CSV en el navegador (M3.5, ADR-47 #1): el servidor nunca recibe el archivo, solo filas ya separadas, por lotes.
 * Código puro (sin DOM) salvo `readFileBytes`/`sha256Hex`, que usan APIs del navegador.
 */

/** Mismos topes que el servidor (ADR-47 #2); si cambian allí, cambian aquí. */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_COLUMNS = 60;
export const MAX_CELL_LENGTH = 1000;
/** Filas por lote y tamaño aproximado del cuerpo (el servidor admite 100 KB por petición). */
export const BATCH_ROWS = 200;
export const BATCH_BYTES = 80_000;

export type Delimiter = ',' | ';' | '\t';

export interface ParsedCsv {
  delimiter: Delimiter;
  headers: string[];
  /** Filas de datos, todas con tantas celdas como encabezados. */
  rows: string[][];
}
export type CsvResult = { ok: true; csv: ParsedCsv } | { ok: false; error: string };

/** Separador más probable según la primera línea (fuera de comillas): coma, punto y coma o tabulación. Excel en español suele guardar con «;». */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch as Delimiter] += 1;
  }
  return counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
}

/** Separa el texto en filas de celdas: comillas dobles, «""» como comilla, saltos de línea dentro de comillas, CR/LF/CRLF. Ignora las líneas en blanco. */
export function splitCsv(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let touched = false; // la línea tiene algo (aunque sea una celda vacía entre comas)
  const endCell = (): void => { row.push(cell); cell = ''; };
  const endRow = (): void => {
    endCell();
    if (touched && !(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
      touched = true;
    } else if (ch === delimiter) {
      endCell();
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      cell += ch;
      touched = true;
    }
  }
  if (touched || cell !== '') endRow();
  return rows;
}

/** Lee un CSV completo y lo valida contra los topes de la importación. El primer registro son los encabezados. */
export function readCsv(raw: string): CsvResult {
  const text = raw.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  const all = splitCsv(text, delimiter);
  if (all.length === 0) return { ok: false, error: 'El archivo está vacío.' };
  const head = all[0]!;
  while (head.length > 0 && head[head.length - 1]!.trim() === '') head.pop(); // columnas vacías al final (típico de Excel)
  if (head.length === 0) return { ok: false, error: 'No encontramos los encabezados en la primera fila.' };
  if (head.length > MAX_IMPORT_COLUMNS) return { ok: false, error: `El archivo tiene ${head.length} columnas; el máximo es ${MAX_IMPORT_COLUMNS}.` };
  const headers = head.map((h, i) => h.trim() || `Columna ${i + 1}`);
  const body = all.slice(1);
  if (body.length === 0) return { ok: false, error: 'El archivo solo tiene la fila de encabezados: no hay contactos para importar.' };
  if (body.length > MAX_IMPORT_ROWS) return { ok: false, error: `El archivo tiene ${body.length} filas; el máximo por importación es ${MAX_IMPORT_ROWS}. Divídelo en varios archivos.` };
  const rows: string[][] = [];
  for (let n = 0; n < body.length; n++) {
    const r = body[n]!;
    if (r.length > headers.length && r.slice(headers.length).some((c) => c.trim() !== '')) return { ok: false, error: `La fila ${n + 2} tiene más celdas que encabezados. Revisa las comillas y los separadores.` };
    const cells = headers.map((_, i) => r[i] ?? '');
    if (cells.some((c) => c.length > MAX_CELL_LENGTH)) return { ok: false, error: `La fila ${n + 2} tiene una celda de más de ${MAX_CELL_LENGTH} caracteres.` };
    rows.push(cells);
  }
  return { ok: true, csv: { delimiter, headers, rows } };
}

/** Decodifica los bytes del archivo: UTF-8 y, si no lo es (Excel «ANSI»), Windows-1252. */
export function decodeBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Bytes del archivo (con alternativa a `Blob.arrayBuffer` para navegadores o entornos que no lo traen). */
export function readFileBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(fr.error ?? new Error('No se pudo leer el archivo'));
    fr.readAsArrayBuffer(file);
  });
}

/** SHA-256 en hexadecimal: la huella con la que el servidor impide importar dos veces el mismo archivo. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parte las filas en lotes de hasta `BATCH_ROWS` filas y `BATCH_BYTES` de JSON (cada lote lleva el número de su primera fila, desde 1). */
export function batchesOf(rows: readonly string[][]): Array<{ from: number; rows: string[][] }> {
  const out: Array<{ from: number; rows: string[][] }> = [];
  let cur: string[][] = [];
  let size = 0;
  let from = 1;
  rows.forEach((r, i) => {
    const bytes = new TextEncoder().encode(JSON.stringify(r)).length + 1;
    if (cur.length > 0 && (cur.length >= BATCH_ROWS || size + bytes > BATCH_BYTES)) {
      out.push({ from, rows: cur });
      from = i + 1;
      cur = [];
      size = 0;
    }
    cur.push([...r]);
    size += bytes;
  });
  if (cur.length > 0) out.push({ from, rows: cur });
  return out;
}

/** Destino sugerido para una columna según su encabezado (la persona puede cambiarlo). `fields` son los campos personalizados activos. */
export function guessTarget(header: string, fields: ReadonlyArray<{ key: string; name: string }>, taken: ReadonlySet<string>): string {
  const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const h = norm(header);
  const free = (t: string): boolean => !taken.has(t);
  if (/^(nombre|nombres|name|full name|nombre completo|cliente|contacto)$/.test(h) && free('name')) return 'name';
  if (/^(telefono|tel|celular|movil|whatsapp|wa|phone|mobile|numero|numero de telefono|telefono celular)$/.test(h) && free('phone')) return 'phone';
  if (/^(correo|correo electronico|email|e mail|mail)$/.test(h) && free('email')) return 'email';
  const f = fields.find((x) => norm(x.name) === h && free(`cf:${x.key}`));
  return f ? `cf:${f.key}` : 'ignore';
}
