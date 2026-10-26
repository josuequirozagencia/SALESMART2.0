/**
 * Partir un texto en fragmentos para buscar (M8.2, ADR-53). Funciones puras. Un fragmento es corto (≈ 800 caracteres, nunca más de `MAX_CHUNK_CHARS`) para que cada uno hable de UNA cosa y la búsqueda
 * encuentre lo que se pregunta; los fragmentos de un texto seguido se solapan un poco (`OVERLAP_CHARS`) para no cortar una idea justo en el borde.
 */
export const TARGET_CHARS = 800;
export const MAX_CHUNK_CHARS = 1000;
export const OVERLAP_CHARS = 100;

/** Normaliza el texto: saltos de línea uniformes, sin caracteres de control (salvo saltos y tabuladores) y sin líneas en blanco de más. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parte un trozo demasiado largo (sin saltos de línea) en pedazos de a lo más `max` caracteres, cortando en el último espacio cercano. */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max; // sin un espacio razonable: corte duro
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Fragmentos de un texto corrido: se juntan párrafos hasta ≈ `TARGET_CHARS`; un párrafo más largo que `MAX_CHUNK_CHARS` se parte; cada fragmento (salvo el primero) empieza con el final del anterior.
 */
export function chunkText(raw: string): string[] {
  const text = cleanText(raw);
  if (text.length === 0) return [];
  const pieces = text.split(/\n{2,}/).flatMap((p) => hardSplit(p.replace(/\n/g, ' ').trim(), MAX_CHUNK_CHARS - OVERLAP_CHARS)).filter((p) => p.length > 0);
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur.length > 0 && cur.length + 1 + p.length > TARGET_CHARS) {
      chunks.push(cur);
      const tail = cur.slice(-OVERLAP_CHARS);
      const start = tail.indexOf(' ');
      cur = `${start >= 0 && start < tail.length - 1 ? tail.slice(start + 1) : tail} ${p}`.trim();
      if (cur.length > MAX_CHUNK_CHARS) cur = p; // el solape no puede pasar del máximo
    } else cur = cur.length > 0 ? `${cur}\n${p}` : p;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.map((c) => c.slice(0, MAX_CHUNK_CHARS));
}

/**
 * Fragmentos de una tabla (CSV): cada fragmento repite el ENCABEZADO y lleva las filas que quepan, así una fila se entiende sola («Precio: 35; Producto: Corte»). Una fila más larga que el máximo se recorta.
 */
export function chunkTable(rows: readonly (readonly string[])[]): string[] {
  const [header, ...body] = rows;
  if (!header || body.length === 0) return [];
  const label = (h: string, i: number): string => (h.trim().length > 0 ? h.trim() : `Columna ${i + 1}`);
  const line = (r: readonly string[]): string =>
    header
      .map((h, i) => [label(h, i), (r[i] ?? '').trim()] as const)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
  const chunks: string[] = [];
  let cur: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (cur.length > 0) chunks.push(cur.join('\n'));
    cur = [];
    size = 0;
  };
  for (const r of body) {
    const l = line(r).slice(0, MAX_CHUNK_CHARS);
    if (l.length === 0) continue;
    if (size > 0 && size + 1 + l.length > TARGET_CHARS) flush();
    cur.push(l);
    size += (size > 0 ? 1 : 0) + l.length;
  }
  flush();
  return chunks;
}

/** Cálculo aproximado de tokens (1 token ≈ 4 caracteres; se usa 3 para no quedarse corto al reservar créditos). */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 3);
