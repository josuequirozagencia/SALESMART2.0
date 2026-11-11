/**
 * Validación del favicon por su CONTENIDO real (v11 S3), nunca por la extensión ni por el tipo que declare el navegador. Solo PNG, ICO y WebP; cuadrado, de 32 a 512 px de lado y de
 * hasta 256 KB. SVG y cualquier otra cosa se rechazan (un SVG puede llevar scripts). Función pura: sin dependencias ni lectura de disco.
 */
export const FAVICON_MAX_BYTES = 256 * 1024;
export const FAVICON_MIN_PX = 32;
export const FAVICON_MAX_PX = 512;
export type FaviconType = 'image/png' | 'image/x-icon' | 'image/webp';

export type FaviconCheck =
  | { readonly ok: true; readonly contentType: FaviconType; readonly px: number }
  | { readonly ok: false; readonly code: 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED' | 'CORRUPT' | 'NOT_SQUARE' | 'BAD_SIZE'; readonly message: string };

const fail = (code: Extract<FaviconCheck, { ok: false }>['code'], message: string): FaviconCheck => ({ ok: false, code, message });
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tipo, ancho y alto declarados por la imagen; null si la cabecera está rota; 'unsupported' si no es PNG, ICO ni WebP. */
function dimensions(b: Buffer): { type: FaviconType; w: number; h: number } | null | 'unsupported' {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // PNG: el primer bloque debe ser IHDR (13 bytes de datos); ancho y alto son enteros de 32 bits
    if (b.length < 24 || b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { type: 'image/png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length >= 6 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) {
    // ICO: N entradas de 16 bytes (ancho, alto —0 significa 256—, …, tamaño y posición de la imagen)
    const n = b.readUInt16LE(4);
    if (n < 1 || n > 32 || b.length < 6 + n * 16) return null;
    let best = 0;
    for (let i = 0; i < n; i++) {
      const at = 6 + i * 16;
      const w = b[at]! === 0 ? 256 : b[at]!;
      const h = b[at + 1]! === 0 ? 256 : b[at + 1]!;
      const size = b.readUInt32LE(at + 8);
      const offset = b.readUInt32LE(at + 12);
      if (size === 0 || offset < 6 + n * 16 || offset + size > b.length) return null;
      if (w !== h) return { type: 'image/x-icon', w, h };
      best = Math.max(best, w);
    }
    return { type: 'image/x-icon', w: best, h: best };
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') {
      // con pérdida: código de inicio 9D 01 2A y luego ancho y alto de 14 bits
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { type: 'image/webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      // sin pérdida: firma 0x2F y luego (ancho-1) y (alto-1) de 14 bits cada uno
      if (b[20] !== 0x2f) return null;
      const bits = b.readUInt32LE(21);
      return { type: 'image/webp', w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      // extendido: ancho-1 y alto-1 de 24 bits
      return { type: 'image/webp', w: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, h: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 };
    }
    return null;
  }
  return 'unsupported';
}

export function checkFavicon(bytes: Buffer): FaviconCheck {
  if (bytes.length === 0) return fail('EMPTY', 'El archivo está vacío');
  if (bytes.length > FAVICON_MAX_BYTES) return fail('TOO_LARGE', `El archivo pesa demasiado: el máximo es ${FAVICON_MAX_BYTES / 1024} KB`);
  const d = dimensions(bytes);
  if (d === 'unsupported') return fail('UNSUPPORTED', 'Formato no admitido: sube una imagen PNG, ICO o WebP (no se aceptan SVG)');
  if (d === null) return fail('CORRUPT', 'No pudimos leer la imagen: el archivo está dañado');
  if (d.w !== d.h) return fail('NOT_SQUARE', `La imagen debe ser cuadrada (la tuya mide ${d.w} × ${d.h} px)`);
  if (d.w < FAVICON_MIN_PX || d.w > FAVICON_MAX_PX) return fail('BAD_SIZE', `El lado debe medir entre ${FAVICON_MIN_PX} y ${FAVICON_MAX_PX} px (el tuyo mide ${d.w} px)`);
  return { ok: true, contentType: d.type, px: d.w };
}
