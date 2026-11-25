import { ApiError } from './api';

/** Lo que el servidor acepta como imagen (y Meta como máximo): 5 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Desde aquí se reduce antes de subir (una foto de cámara moderna pesa de 3 a 12 MB). */
export const REDUCE_OVER_BYTES = 2 * 1024 * 1024;
export const MAX_SIDE = 1600;
export const JPEG_QUALITY = 0.82;

const mb = (n: number): string => (Math.round((n / (1024 * 1024)) * 10) / 10).toString().replace('.', ',');
const tooBig = (bytes: number): ApiError => new ApiError(413, 'ATTACHMENT_TOO_LARGE', `La imagen pesa ${mb(bytes)} MB; el máximo es 5 MB.`);

/** Las piezas del navegador que se usan para reducir; se pueden sustituir en las pruebas. */
export interface ImageDeps {
  decode: (file: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
  encode: (bitmap: { width: number; height: number }, width: number, height: number) => Promise<Blob | null>;
}

const browserDeps: ImageDeps = {
  // `from-image` respeta la orientación EXIF (la foto de un teléfono no sale girada)
  decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
  encode: async (bitmap, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff'; // el JPEG no tiene transparencia: un PNG con fondo transparente quedaría negro
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap as ImageBitmap, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  },
};

/** El tamaño al que se reduce: el lado mayor a lo sumo `MAX_SIDE` y nunca se amplía. */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_SIDE) return { width, height };
  const k = MAX_SIDE / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * Prepara una imagen antes de subirla (V23-C): si pesa más de 2 MB, o es de un formato que WhatsApp oficial no acepta como imagen (WebP, GIF, HEIC), se reduce a JPEG con el lado mayor ≤ 1600 px y
 * calidad 0,82. Un JPEG o PNG de hasta 2 MB —y un PNG de hasta 5 MB— se sube tal cual. Si aun reducida pasa de 5 MB, o el navegador no puede leerla, falla con un motivo claro. Lo que no es imagen se
 * devuelve sin tocar.
 */
export async function prepareImage(file: File, deps: ImageDeps = browserDeps): Promise<File> {
  if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) return file;
  const type = file.type || (/\.(heic|heif)$/i.test(file.name) ? 'image/heic' : '');
  const asIs = (type === 'image/jpeg' && file.size <= REDUCE_OVER_BYTES) || (type === 'image/png' && file.size <= MAX_IMAGE_BYTES);
  if (asIs) return file;
  let bitmap: Awaited<ReturnType<ImageDeps['decode']>>;
  try {
    bitmap = await deps.decode(file);
  } catch {
    // El navegador no sabe leerla (por ejemplo HEIC fuera de Safari): si ya cabe y no es HEIC se sube como está; si no, se explica
    if (/heic|heif/.test(type)) throw new ApiError(415, 'ATTACHMENT_UNSUPPORTED_TYPE', 'Este navegador no puede convertir fotos HEIC. Envíala como JPEG (en el iPhone: Ajustes › Cámara › Formatos › Más compatible).');
    if (file.size > MAX_IMAGE_BYTES) throw tooBig(file.size);
    return file;
  }
  try {
    const { width, height } = targetSize(bitmap.width, bitmap.height);
    const blob = await deps.encode(bitmap, width, height);
    if (!blob) throw new ApiError(422, 'ATTACHMENT_FAILED', 'No se pudo preparar la imagen. Inténtalo con otra.');
    if (blob.size > MAX_IMAGE_BYTES) throw tooBig(blob.size);
    // Si «reducir» la dejó más pesada y la original ya servía, se queda la original
    if (blob.size >= file.size && (type === 'image/jpeg' || type === 'image/png') && file.size <= MAX_IMAGE_BYTES) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  } finally {
    bitmap.close?.();
  }
}
