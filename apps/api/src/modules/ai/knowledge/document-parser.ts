import { chunkTable, chunkText, cleanText } from './chunker';

export type DocumentKind = 'txt' | 'csv' | 'pdf' | 'docx';

/** Tamaño máximo de un documento (ADR-53, decisión 7). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Texto máximo que se procesa de un documento: más allá se rechaza (un documento enorme gastaría créditos y memoria). */
export const MAX_TEXT_CHARS = 1_000_000;
/** Tiempo máximo para leer un archivo: un PDF o DOCX malicioso no puede dejar el proceso colgado. */
export const PARSE_TIMEOUT_MS = 30_000;
const MAX_CSV_ROWS = 50_000;

export type ParseErrorCode = 'unsupported' | 'corrupt' | 'empty' | 'too_long' | 'timeout' | 'encrypted';

/** Un documento que no se pudo leer, con un motivo que se le muestra a la persona. */
export class ParseError extends Error {
  constructor(
    readonly code: ParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface ParsedDocument {
  /** Fragmentos listos para vectorizar. */
  readonly chunks: string[];
  /** Caracteres de texto útil (para estimar el costo y mostrar el tamaño). */
  readonly chars: number;
}

const extOf = (name: string | null): string => (name?.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? '');

/**
 * Qué tipo de documento es, por su CONTENIDO (firma del archivo) y su extensión: un PDF empieza con «%PDF-», un DOCX es un ZIP («PK») con extensión .docx, y un TXT o CSV es texto sin bytes nulos.
 * Lo que diga el navegador sobre el tipo no se usa: se puede falsear.
 */
export function detectKind(bytes: Buffer, filename: string | null): DocumentKind | null {
  if (bytes.length === 0) return null;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return extOf(filename) === 'pdf' || extOf(filename) === '' ? 'pdf' : null;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) return extOf(filename) === 'docx' ? 'docx' : null;
  const ext = extOf(filename);
  if (ext !== 'txt' && ext !== 'csv' && ext !== 'md' && ext !== '') return null;
  if (bytes.subarray(0, 4096).includes(0)) return null; // binario
  return ext === 'csv' ? 'csv' : 'txt';
}

/** Decodifica texto: UTF-8 (con o sin BOM) y, si no lo es, Windows-1252 (lo habitual en archivos de Excel y Bloc de notas en español). */
export function decodeText(bytes: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // sin la marca de orden de bytes (BOM)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Lector de CSV (RFC 4180: comillas, comillas dobles escapadas y saltos de línea dentro de un campo). El separador (coma, punto y coma o tabulador) se deduce de la primera línea. */
export function parseCsv(text: string): string[][] {
  const first = text.split('\n', 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field.length === 0) quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim().length > 0)) rows.push(row);
      row = [];
      if (rows.length > MAX_CSV_ROWS) throw new ParseError('too_long', `La tabla tiene demasiadas filas (el máximo es ${MAX_CSV_ROWS.toLocaleString('es-EC')})`);
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim().length > 0)) rows.push(row);
  return rows;
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ParseError('timeout', 'El archivo tardó demasiado en leerse')), PARSE_TIMEOUT_MS); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pdfText(bytes: Buffer): Promise<string> {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const out = await extractText(doc, { mergePages: true });
    return Array.isArray(out.text) ? out.text.join('\n') : out.text;
  } catch (e) {
    if (e instanceof ParseError) throw e;
    const name = e instanceof Error ? e.name : '';
    if (/Password/i.test(name)) throw new ParseError('encrypted', 'El PDF está protegido con contraseña');
    throw new ParseError('corrupt', 'No se pudo leer el PDF: está dañado o no es un PDF válido');
  }
}

async function docxText(bytes: Buffer): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  } catch {
    throw new ParseError('corrupt', 'No se pudo leer el documento de Word: está dañado o no es un .docx válido');
  }
}

/** Lee un documento y lo parte en fragmentos. Lanza `ParseError` con un motivo claro (PDF escaneado sin texto, archivo dañado, demasiado largo…). */
export async function parseDocument(kind: DocumentKind, bytes: Buffer): Promise<ParsedDocument> {
  let chunks: string[];
  let chars: number;
  if (kind === 'csv') {
    const rows = parseCsv(decodeText(bytes));
    if (rows.length < 2) throw new ParseError('empty', 'La tabla no tiene filas de datos (hace falta un encabezado y al menos una fila)');
    chars = rows.reduce((n, r) => n + r.reduce((m, f) => m + f.length, 0), 0);
    if (chars > MAX_TEXT_CHARS) throw new ParseError('too_long', 'El documento tiene demasiado texto para procesarlo');
    chunks = chunkTable(rows);
  } else {
    const raw = kind === 'txt' ? decodeText(bytes) : await withTimeout(kind === 'pdf' ? pdfText(bytes) : docxText(bytes));
    const text = cleanText(raw);
    chars = text.length;
    if (chars > MAX_TEXT_CHARS) throw new ParseError('too_long', 'El documento tiene demasiado texto para procesarlo');
    if (chars === 0) throw new ParseError('empty', kind === 'pdf' ? 'El PDF no tiene texto que se pueda leer (¿es una imagen escaneada?)' : 'El documento no tiene texto');
    chunks = chunkText(text);
  }
  if (chunks.length === 0) throw new ParseError('empty', 'El documento no tiene texto útil');
  return { chunks, chars };
}
