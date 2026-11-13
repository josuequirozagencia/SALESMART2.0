/**
 * Reglas de la marca de la plataforma (v11 §3, ADR-69). Funciones y constantes puras: nada de base de datos ni de almacenamiento.
 */

/** Los archivos de la marca: logos, las variantes del icono de la aplicación y (entrega C) el sonido. */
export const BRANDING_ASSETS = ['logo-light', 'logo-dark', 'icon-32', 'icon-48', 'icon-180', 'icon-192', 'icon-512', 'badge-96', 'sound'] as const;
export type BrandingAsset = (typeof BRANDING_ASSETS)[number];

/** Variantes que se generan del icono subido (lado en píxeles). El badge (96) sale aparte: solo si la imagen tiene transparencia. */
export const ICON_VARIANTS = { 'icon-32': 32, 'icon-48': 48, 'icon-180': 180, 'icon-192': 192, 'icon-512': 512 } as const;
export type IconVariant = keyof typeof ICON_VARIANTS;
export const ICON_VARIANT_NAMES = Object.keys(ICON_VARIANTS) as IconVariant[];
export const BADGE_PX = 96;

/** Máximo de lo que se acepta de un archivo de imagen (icono o logo) y de lo que se decodifica. */
export const IMAGE_MAX_BYTES = 1024 * 1024;
export const ICON_MIN_PX = 512;
export const ICON_MAX_PX = 4096;
export const LOGO_MAX_WIDTH = 1024;

export const DEFAULT_APP_NAME = 'Sales Smart 2.0';
export const NAME_MIN = 2;
export const NAME_MAX = 40;
export const SHORT_NAME_MAX = 12;

export type NameCheck = { readonly ok: true; readonly name: string | null; readonly shortName: string | null } | { readonly ok: false; readonly message: string };

// Sin «<» ni «>» (nada de HTML) ni caracteres de control; los espacios repetidos se colapsan
const hasForbidden = (s: string): boolean => {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '<' || ch === '>' || c < 32 || c === 127) return true;
  }
  return false;
};
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Valida el nombre de la plataforma y su versión corta. `null` (o vacío) = volver al valor por defecto. */
export function checkName(name: string | null, shortName: string | null): NameCheck {
  const n = name === null ? '' : clean(name);
  const s = shortName === null ? '' : clean(shortName);
  if (n === '' && s !== '') return { ok: false, message: 'Escribe primero el nombre completo: el nombre corto es una versión de ese nombre' };
  if (n !== '') {
    if (n.length < NAME_MIN || n.length > NAME_MAX) return { ok: false, message: `El nombre debe tener de ${NAME_MIN} a ${NAME_MAX} caracteres` };
    if (hasForbidden(n)) return { ok: false, message: 'El nombre no puede llevar «<», «>» ni caracteres de control' };
  }
  if (s !== '') {
    if (s.length > SHORT_NAME_MAX) return { ok: false, message: `El nombre corto puede tener hasta ${SHORT_NAME_MAX} caracteres` };
    if (hasForbidden(s)) return { ok: false, message: 'El nombre corto no puede llevar «<», «>» ni caracteres de control' };
  }
  return { ok: true, name: n === '' ? null : n, shortName: s === '' ? null : s };
}
