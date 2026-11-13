/**
 * Validación del sonido de notificación de la marca (v11 §2.5, ADR-69). Funciones puras: el servidor mira el CONTENIDO del archivo —cabecera ID3 o sincronía MPEG capa III para MP3; caja `ftyp` y pista
 * de audio para M4A—, nunca la extensión ni el tipo que declare el navegador. No se decodifica el audio (no hace falta ni se agrega una dependencia): basta con reconocer la estructura y poner un tope
 * de peso. El archivo se entrega con su `Content-Type` y `nosniff`, y el navegador lo reproduce solo con Web Audio.
 */

/** Máximo aceptado (el anexo recomienda 100 KB y acepta hasta 200 KB). */
export const SOUND_MAX_BYTES = 200 * 1024;

export type SoundType = 'audio/mpeg' | 'audio/mp4';
export type SoundCheck =
  | { readonly ok: true; readonly contentType: SoundType }
  | { readonly ok: false; readonly status: 400 | 413; readonly code: string; readonly message: string };

const fail = (status: 400 | 413, code: string, message: string): SoundCheck => ({ ok: false, status, code, message });

/** ¿Hay en `b[i..i+3]` la cabecera de un cuadro MPEG de capa III válida? (sincronía de 11 bits, versión y capa permitidas, tasa y frecuencia que existen). */
function mp3FrameAt(b: Buffer, i: number): boolean {
  if (i < 0 || i + 4 > b.length) return false;
  const b1 = b[i]!;
  const b2 = b[i + 1]!;
  const b3 = b[i + 2]!;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return false;
  const version = (b2 >> 3) & 0x03; // 01 = reservada
  const layer = (b2 >> 1) & 0x03; // 01 = capa III
  const bitrate = (b3 >> 4) & 0x0f; // 0000 = libre, 1111 = inválida
  const rate = (b3 >> 2) & 0x03; // 11 = reservada
  return version !== 0x01 && layer === 0x01 && bitrate !== 0x0f && bitrate !== 0x00 && rate !== 0x03;
}

/** Tamaño de una etiqueta ID3v2 (10 bytes de cabecera + cuerpo con enteros «syncsafe») o `null` si no es una. */
function id3Length(b: Buffer): number | null {
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'ID3') return null;
  const [major, rev, , s1, s2, s3, s4] = [b[3]!, b[4]!, b[5]!, b[6]!, b[7]!, b[8]!, b[9]!];
  if (major === 0xff || rev === 0xff || ((s1 | s2 | s3 | s4) & 0x80) !== 0) return null;
  return 10 + ((s1 << 21) | (s2 << 14) | (s3 << 7) | s4);
}

/** Un MP3: opcionalmente una etiqueta ID3v2 y, tras ella (con algo de relleno), un cuadro MPEG de capa III válido. */
export function looksLikeMp3(b: Buffer): boolean {
  const tag = id3Length(b);
  if (tag === null) return mp3FrameAt(b, 0); // sin etiqueta, el cuadro tiene que estar justo al principio
  if (tag >= b.length) return false;
  const until = Math.min(b.length - 3, tag + 4096); // tras la etiqueta puede haber relleno
  for (let i = tag; i < until; i++) if (mp3FrameAt(b, i)) return true;
  return false;
}

const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'mp42', 'mp41', 'isom', 'iso2', 'dash', 'f4a ']);

/** Un M4A/AAC: caja `ftyp` de la marca esperada y manejadores de pista —al menos uno de audio (`soun`) y ninguno de video (`vide`)—. */
export function looksLikeM4a(b: Buffer): boolean {
  if (b.length < 16 || b.toString('latin1', 4, 8) !== 'ftyp') return false;
  const size = b.readUInt32BE(0);
  if (size < 16 || size > b.length) return false;
  if (!M4A_BRANDS.has(b.toString('latin1', 8, 12))) return false;
  let audio = false;
  let from = 0;
  for (;;) {
    const at = b.indexOf('hdlr', from, 'latin1');
    if (at < 0) break;
    // hdlr: tamaño(4) 'hdlr' versión+flags(4) pre_defined(4) handler_type(4)
    const handler = at + 12 <= b.length - 4 ? b.toString('latin1', at + 12, at + 16) : '';
    if (handler === 'vide') return false;
    if (handler === 'soun') audio = true;
    from = at + 4;
  }
  return audio;
}

/** Valida el archivo del sonido: no vacío, de hasta 200 KB y un MP3 o M4A reales por su contenido. */
export function checkSound(bytes: Buffer): SoundCheck {
  if (bytes.length === 0) return fail(400, 'SOUND_EMPTY', 'El archivo está vacío');
  if (bytes.length > SOUND_MAX_BYTES) return fail(413, 'SOUND_TOO_LARGE', `El sonido pesa demasiado: el máximo es ${SOUND_MAX_BYTES / 1024} KB (se recomiendan 100 KB o menos)`);
  if (looksLikeMp3(bytes)) return { ok: true, contentType: 'audio/mpeg' };
  if (looksLikeM4a(bytes)) return { ok: true, contentType: 'audio/mp4' };
  return fail(400, 'SOUND_FORMAT_INVALID', 'El sonido debe ser un MP3 (recomendado) o un M4A (AAC) válido: el contenido del archivo no corresponde a ninguno de los dos');
}
