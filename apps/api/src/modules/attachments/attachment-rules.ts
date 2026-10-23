/**
 * Reglas de los archivos adjuntos (M5.6d, ADR-50). Dominio PURO: tipos aceptados, tamaños máximos, comprobación del contenido real y nombres seguros.
 *
 * Lo que WhatsApp Cloud API admite (a validar con la cuenta real): imágenes JPEG/PNG de hasta 5 MB, video MP4/3GPP de hasta 16 MB, audio AAC/MP4/MPEG/AMR/OGG-Opus de
 * hasta 16 MB, documentos (PDF, Word, Excel, PowerPoint, texto) de hasta 100 MB y stickers WebP. Por memoria del servidor (el archivo se lee entero antes de guardarlo y
 * de revisarlo) el tope propio de los documentos es 25 MB.
 */

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

const MB = 1024 * 1024;
/** Tamaño máximo por tipo, en bytes. */
export const MAX_BYTES: Readonly<Record<AttachmentKind, number>> = { image: 5 * MB, video: 16 * MB, audio: 16 * MB, document: 25 * MB, sticker: Math.floor(0.5 * MB) };
/** El mayor de todos: lo que el cuerpo crudo de una subida puede pesar. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_BYTES));

/** «Familia» del contenido real de un archivo, reconocida por sus primeros bytes. */
export type Signature = 'jpeg' | 'png' | 'webp' | 'gif' | 'pdf' | 'mp4' | 'ogg' | 'mp3' | 'aac' | 'amr' | 'webm' | 'zip' | 'ole' | 'text';

/** Tipos que se aceptan al SUBIR (lo que una persona envía): el tipo declarado → de qué tipo es y qué contenido real se espera. */
const OUTBOUND: Readonly<Record<string, { kind: AttachmentKind; expect: readonly Signature[] }>> = {
  'image/jpeg': { kind: 'image', expect: ['jpeg'] },
  'image/png': { kind: 'image', expect: ['png'] },
  'video/mp4': { kind: 'video', expect: ['mp4'] },
  'video/3gpp': { kind: 'video', expect: ['mp4'] },
  'audio/ogg': { kind: 'audio', expect: ['ogg'] },
  'audio/mpeg': { kind: 'audio', expect: ['mp3'] },
  'audio/mp4': { kind: 'audio', expect: ['mp4'] },
  'audio/aac': { kind: 'audio', expect: ['aac'] },
  'audio/amr': { kind: 'audio', expect: ['amr'] },
  // Lo que graban los navegadores: se convierte a OGG/Opus antes de guardarse
  'audio/webm': { kind: 'audio', expect: ['webm'] },
  'application/pdf': { kind: 'document', expect: ['pdf'] },
  'application/msword': { kind: 'document', expect: ['ole'] },
  'application/vnd.ms-excel': { kind: 'document', expect: ['ole'] },
  'application/vnd.ms-powerpoint': { kind: 'document', expect: ['ole'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', expect: ['zip'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', expect: ['zip'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', expect: ['zip'] },
  'text/plain': { kind: 'document', expect: ['text'] },
};

/** Los tipos de audio que tal cual se mandan como nota de voz o audio (los demás se convierten). */
export const SENDABLE_AUDIO: ReadonlySet<string> = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr']);

/** Tipo base de un `Content-Type` («audio/ogg; codecs=opus» → «audio/ogg»), en minúsculas. */
export function baseMime(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/** El tipo de adjunto que corresponde a un tipo declarado de subida, o null si no se acepta. */
export function outboundKind(mime: string): AttachmentKind | null {
  return OUTBOUND[mime]?.kind ?? null;
}

/** Los tipos aceptados al subir, para decírselo a la persona. */
export const ACCEPTED_MIMES: readonly string[] = Object.keys(OUTBOUND);

/** Reconoce el contenido por sus primeros bytes. null = no se reconoce. */
export function sniff(b: Buffer): Signature | null {
  if (b.length < 4) return null;
  const at = (i: number, s: string): boolean => b.length >= i + s.length && b.subarray(i, i + s.length).toString('latin1') === s;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, '%PDF')) return 'pdf';
  if (at(4, 'ftyp')) return 'mp4';
  if (at(0, 'OggS')) return 'ogg';
  if (at(0, 'ID3')) return 'mp3';
  // Sincronía de audio MPEG (11 bits en 1): con «layer» 00 es AAC en ADTS; con otro, MP3
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return ((b[1]! >> 1) & 3) === 0 ? 'aac' : 'mp3';
  if (at(0, '#!AMR')) return 'amr';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (at(0, 'PK') && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole';
  // Texto: sin bytes nulos en el inicio
  const head = b.subarray(0, Math.min(b.length, 4096));
  if (!head.includes(0)) return 'text';
  return null;
}

export type UploadCheck = { ok: true; mime: string; kind: AttachmentKind } | { ok: false; code: 'unsupported_type' | 'too_large' | 'empty' | 'type_mismatch'; message: string };

/** ¿Se acepta este archivo? Mira el tipo declarado, el tamaño y que el contenido real corresponda al tipo (un .png que en realidad es otra cosa no pasa). */
export function checkUpload(declaredMime: string, bytes: Buffer): UploadCheck {
  const rule = OUTBOUND[declaredMime];
  if (!rule) return { ok: false, code: 'unsupported_type', message: 'Ese tipo de archivo no se puede enviar por WhatsApp. Usa imágenes JPEG o PNG, video MP4, audio, PDF, Word, Excel, PowerPoint o texto' };
  if (bytes.length === 0) return { ok: false, code: 'empty', message: 'El archivo está vacío' };
  if (bytes.length > MAX_BYTES[rule.kind]) return { ok: false, code: 'too_large', message: `El archivo pesa demasiado: el máximo para este tipo es ${Math.floor(MAX_BYTES[rule.kind] / MB)} MB` };
  const found = sniff(bytes);
  if (found === null || !rule.expect.includes(found)) return { ok: false, code: 'type_mismatch', message: 'El contenido del archivo no corresponde a su tipo' };
  return { ok: true, mime: declaredMime, kind: rule.kind };
}

/** Un nombre de archivo para mostrar y para la descarga: sin rutas, sin caracteres de control ni de ruta, de largo acotado y siempre con algo. */
export function safeFilename(raw: string | null | undefined, fallback = 'archivo'): string {
  let name = (raw ?? '').normalize('NFC');
  try {
    name = decodeURIComponent(name);
  } catch {
    // ya venía sin codificar
  }
  name = name.replace(/[\\/]+/g, '_').replace(/\p{Cc}/gu, '').replace(/["<>:|?*]/g, '_').replace(/^\.+/, '').trim();
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name === '' ? fallback : name;
}

/** La clave del archivo en el almacenamiento: SIEMPRE bajo la organización y sin nada que venga del nombre del archivo. */
export const storageKey = (organizationId: string, attachmentId: string): string => `org/${organizationId}/attachments/${attachmentId}`;

/** ¿Se puede mostrar dentro de la página (imagen, audio, video de tipos conocidos) o solo descargar? Los documentos, y cualquier tipo raro, nunca se muestran en línea. */
export function inlineAllowed(kind: AttachmentKind, mime: string): boolean {
  if (kind === 'document') return false;
  return /^(image\/(jpeg|png|webp|gif)|audio\/[a-z0-9.+-]+|video\/(mp4|3gpp|webm))$/.test(mime);
}

/** El tipo de adjunto de un mensaje entrante, a partir de su tipo de contenido normalizado. */
export function kindOfInbound(messageKind: string): AttachmentKind | null {
  return messageKind === 'image' || messageKind === 'video' || messageKind === 'audio' || messageKind === 'document' || messageKind === 'sticker' ? messageKind : null;
}
