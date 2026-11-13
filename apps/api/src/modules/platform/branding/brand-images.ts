import sharp, { type Sharp } from 'sharp';
import { BADGE_PX, ICON_MAX_PX, ICON_MIN_PX, ICON_VARIANTS, IMAGE_MAX_BYTES, LOGO_MAX_WIDTH, type IconVariant } from './brand-files';

/**
 * Procesamiento de las imágenes de la marca (v11 §3, ADR-69) con `sharp`: el servidor DECODIFICA lo que sube el Súper Admin (así se valida el contenido real y un archivo disfrazado falla),
 * limita los píxeles de entrada y genera PNG sin metadatos. Nunca se acepta SVG (un SVG puede llevar scripts); el icono por omisión sí es un SVG, pero es propio y de confianza.
 */

export type ImageFailure = { readonly ok: false; readonly status: 400 | 413; readonly code: string; readonly message: string };
const fail = (status: 400 | 413, code: string, message: string): ImageFailure => ({ ok: false, status, code, message });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer): boolean => b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);
const isWebp = (b: Buffer): boolean => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

const open = (bytes: Buffer): Sharp => sharp(bytes, { limitInputPixels: ICON_MAX_PX * ICON_MAX_PX, failOn: 'error', animated: false });
const isPixelLimit = (e: unknown): boolean => e instanceof Error && /pixel limit/i.test(e.message);

export interface BuiltIcon {
  readonly ok: true;
  /** Las variantes cuadradas (favicon, app y notificaciones). */
  readonly variants: Record<IconVariant, Buffer>;
  /** Silueta monocroma 96 × 96 (solo si la imagen tiene transparencia real); `null` si no se pudo generar. */
  readonly badge: Buffer | null;
  readonly px: number;
}

/** Valida el icono subido (PNG cuadrado, de 512 a 4096 px, hasta 1 MB) y genera todas sus variantes. */
export async function buildIcon(bytes: Buffer): Promise<BuiltIcon | ImageFailure> {
  if (bytes.length === 0) return fail(400, 'ICON_EMPTY', 'El archivo está vacío');
  if (bytes.length > IMAGE_MAX_BYTES) return fail(413, 'ICON_TOO_LARGE', `El icono pesa demasiado: el máximo es ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
  if (!isPng(bytes)) return fail(400, 'ICON_NOT_PNG', 'El icono debe ser un PNG (no se aceptan SVG, JPG ni otros formatos)');
  try {
    const img = open(bytes);
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w !== h) return fail(400, 'ICON_NOT_SQUARE', 'El icono debe ser cuadrado (mismo ancho y alto)');
    if (w < ICON_MIN_PX) return fail(400, 'ICON_TOO_SMALL', `El icono debe ser de al menos ${ICON_MIN_PX} × ${ICON_MIN_PX} px`);
    if (w > ICON_MAX_PX) return fail(400, 'ICON_TOO_BIG', `El icono no puede pasar de ${ICON_MAX_PX} × ${ICON_MAX_PX} px`);
    const entries = await Promise.all((Object.entries(ICON_VARIANTS) as Array<[IconVariant, number]>).map(async ([name, n]) => [name, await img.clone().resize(n, n, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer()] as const));
    const variants = Object.fromEntries(entries) as Record<IconVariant, Buffer>;
    // El badge de Android es una silueta: solo tiene sentido con transparencia real (un cuadrado opaco saldría como un bloque blanco)
    let badge: Buffer | null = null;
    if (meta.hasAlpha && !(await img.clone().stats()).isOpaque) badge = await silhouette(img.clone());
    return { ok: true, variants, badge, px: w };
  } catch (e) {
    return isPixelLimit(e) ? fail(400, 'ICON_TOO_BIG', `El icono no puede pasar de ${ICON_MAX_PX} × ${ICON_MAX_PX} px`) : fail(400, 'ICON_CORRUPT', 'No se pudo leer la imagen: el archivo está dañado o no es un PNG válido');
  }
}

/** Silueta blanca (con el alfa de la imagen) a 96 × 96. */
async function silhouette(img: Sharp): Promise<Buffer> {
  const alpha = await img.resize(BADGE_PX, BADGE_PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().extractChannel('alpha').raw().toBuffer();
  return sharp({ create: { width: BADGE_PX, height: BADGE_PX, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alpha, { raw: { width: BADGE_PX, height: BADGE_PX, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export interface BuiltLogo {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly contentType: 'image/png' | 'image/webp';
  readonly px: number;
}

/** Valida un logo (PNG o WebP, hasta 1 MB y 1024 px de ancho, sin animación). Se guarda el archivo tal cual, ya comprobado que decodifica completo. */
export async function buildLogo(bytes: Buffer): Promise<BuiltLogo | ImageFailure> {
  if (bytes.length === 0) return fail(400, 'LOGO_EMPTY', 'El archivo está vacío');
  if (bytes.length > IMAGE_MAX_BYTES) return fail(413, 'LOGO_TOO_LARGE', `El logo pesa demasiado: el máximo es ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
  const type = isPng(bytes) ? 'image/png' : isWebp(bytes) ? 'image/webp' : null;
  if (!type) return fail(400, 'LOGO_UNSUPPORTED', 'El logo debe ser PNG o WebP (no se aceptan SVG, JPG ni otros formatos)');
  try {
    const img = open(bytes);
    const meta = await img.metadata();
    if ((meta.pages ?? 1) > 1) return fail(400, 'LOGO_ANIMATED', 'El logo no puede ser animado');
    const w = meta.width ?? 0;
    if (w < 1 || (meta.height ?? 0) < 1) return fail(400, 'LOGO_CORRUPT', 'No se pudo leer la imagen');
    if (w > LOGO_MAX_WIDTH) return fail(400, 'LOGO_TOO_WIDE', `El logo puede tener hasta ${LOGO_MAX_WIDTH} px de ancho`);
    await img.clone().stats(); // fuerza a decodificar la imagen completa: un archivo con la cabecera buena y el resto roto no pasa
    return { ok: true, bytes, contentType: type, px: w };
  } catch (e) {
    return isPixelLimit(e) ? fail(400, 'LOGO_TOO_BIG', 'La imagen es demasiado grande') : fail(400, 'LOGO_CORRUPT', 'No se pudo leer la imagen: el archivo está dañado');
  }
}

/** El icono por omisión (SVG propio, de confianza): un cuadrado índigo con una «S». */
const DEFAULT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M42 21c-2-3-5-4.5-9.5-4.5C26.5 16.5 22.5 19.5 22.5 24c0 11 20.5 5.5 20.5 16 0 4.8-4.2 7.5-10.5 7.5-4.8 0-8.5-1.7-11-5" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>';
/** La misma «S», en blanco sobre fondo transparente: la silueta del badge por omisión. */
const DEFAULT_BADGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M42 21c-2-3-5-4.5-9.5-4.5C26.5 16.5 22.5 19.5 22.5 24c0 11 20.5 5.5 20.5 16 0 4.8-4.2 7.5-10.5 7.5-4.8 0-8.5-1.7-11-5" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>';

let defaults: Promise<{ icons: Record<IconVariant, Buffer>; badge: Buffer }> | null = null;

/** Las variantes por omisión, dibujadas una vez desde el SVG propio y guardadas en memoria. */
export function defaultImages(): Promise<{ icons: Record<IconVariant, Buffer>; badge: Buffer }> {
  defaults ??= (async () => {
    const svg = Buffer.from(DEFAULT_ICON_SVG, 'utf8');
    const entries = await Promise.all((Object.entries(ICON_VARIANTS) as Array<[IconVariant, number]>).map(async ([name, n]) => [name, await sharp(svg, { density: 384 }).resize(n, n).png({ compressionLevel: 9 }).toBuffer()] as const));
    const badge = await sharp(Buffer.from(DEFAULT_BADGE_SVG, 'utf8'), { density: 384 }).resize(BADGE_PX, BADGE_PX).png({ compressionLevel: 9 }).toBuffer();
    return { icons: Object.fromEntries(entries) as Record<IconVariant, Buffer>, badge };
  })().catch((e: unknown) => {
    defaults = null; // si falla (p. ej. sin memoria), la próxima petición lo intenta de nuevo
    throw e;
  });
  return defaults;
}
