import { isIP } from 'node:net';

/**
 * Guardián de direcciones y destinos para la llamada HTTP de las automatizaciones (M9.5b, ADR-54; regla de seguridad 10, corrige B20 del sistema anterior). Es **puro**: sin red ni base de datos.
 * Decide dos cosas: (1) si una DIRECCIÓN IP es pública (todo lo privado, de loopback, de enlace local, de metadatos de la nube, reservado o de multidifusión se rechaza, en IPv4 e IPv6, incluidas
 * las IPv4 «mapeadas» dentro de IPv6) y (2) si una DIRECCIÓN WEB es un destino aceptable (https, puerto 443, sin usuario ni contraseña, nombre de dominio y no una IP) y si su dominio está en la
 * lista de permitidos de la empresa.
 */

// ---------------------------------------------------------------------------------------------- direcciones IP

type V4 = readonly [number, number, number, number];

const parseV4 = (s: string): V4 | null => {
  const p = s.split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? (n as unknown as V4) : null;
};

/** Rangos IPv4 que NO son de internet público: [base, bits]. */
const BLOCKED_V4: ReadonlyArray<readonly [V4, number]> = [
  [[0, 0, 0, 0], 8], // «esta red»
  [[10, 0, 0, 0], 8], // privada
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // enlace local y metadatos de la nube (169.254.169.254)
  [[172, 16, 0, 0], 12], // privada
  [[192, 0, 0, 0], 24], // protocolo IETF
  [[192, 0, 2, 0], 24], // documentación
  [[192, 88, 99, 0], 24], // 6to4 relay (obsoleto)
  [[192, 168, 0, 0], 16], // privada
  [[198, 18, 0, 0], 15], // pruebas de rendimiento
  [[198, 51, 100, 0], 24], // documentación
  [[203, 0, 113, 0], 24], // documentación
  [[224, 0, 0, 0], 4], // multidifusión
  [[240, 0, 0, 0], 4], // reservado (incluye 255.255.255.255)
];

const toInt = (a: V4): number => ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0;
const inRange = (a: V4, base: V4, bits: number): boolean => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(a) & mask) === (toInt(base) & mask);
};

/** IPv6 → 16 bytes (null si no es una dirección válida). Acepta `::` y una cola IPv4 (`::ffff:1.2.3.4`). */
function parseV6(input: string): Uint8Array | null {
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseV4(tail[1]!);
    if (!v4) return null;
    s = s.slice(0, s.length - tail[1]!.length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? left.length !== 8 : missing < 0) return null;
  const groups = rest === undefined ? left : [...left, ...Array<string>(missing).fill('0'), ...right];
  const out = new Uint8Array(16);
  for (const [i, g] of groups.entries()) {
    const v = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/.test(g) || Number.isNaN(v)) return null;
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

const isZero = (b: Uint8Array, from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);

/** ¿La dirección IPv4 es de internet público? */
export function isPublicV4(a: V4): boolean {
  return !BLOCKED_V4.some(([base, bits]) => inRange(a, base, bits));
}

/**
 * ¿Esta dirección IP (texto) es de internet público? `false` ante cualquier duda: lo que no se pueda interpretar se rechaza.
 * IPv6: se rechazan `::`, `::1`, único-local (fc00::/7), enlace local (fe80::/10), multidifusión (ff00::/8), documentación (2001:db8::/32), 6to4 (2002::/16), Teredo (2001::/32),
 * descarte (100::/64) y las direcciones IPv4 mapeadas, compatibles y NAT64 (se juzga la IPv4 que llevan dentro).
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/%.*$/, ''));
  if (kind === 4) {
    const v4 = parseV4(ip);
    return v4 !== null && isPublicV4(v4);
  }
  if (kind !== 6) return false;
  const b = parseV6(ip);
  if (!b) return false;
  const embedded = (at: number): boolean => isPublicV4([b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!]);
  if (isZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded(12); // ::ffff:a.b.c.d (mapeada)
  if (isZero(b, 0, 12)) return false; // ::, ::1 y las compatibles con IPv4 (obsoletas)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && isZero(b, 4, 12)) return embedded(12); // NAT64 64:ff9b::/96
  if (b[0] === 0x01 && isZero(b, 1, 8)) return false; // 100::/64 (descarte)
  if ((b[0]! & 0xfe) === 0xfc) return false; // fc00::/7 único-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return false; // fe80::/10 enlace local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return false; // fec0::/10 sitio local (obsoleta)
  if (b[0] === 0xff) return false; // multidifusión
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 documentación
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 2002::/16 6to4
  return true;
}

// ---------------------------------------------------------------------------------------------- destinos

export const MAX_URL_LENGTH = 2000;
/** Dominios de la lista de permitidos por empresa. */
export const MAX_ALLOWED_HOSTS = 20;

/** `ejemplo.com`, `api.ejemplo.com` o `*.ejemplo.com` (el comodín solo al principio y solo subdominios, nunca el dominio base). */
const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Normaliza un dominio de la lista de permitidos: minúsculas, sin espacios ni punto final. Devuelve null si no es un dominio válido (o es una IP). */
export function normalizeAllowedHost(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  if (h === '' || isIP(h) !== 0 || /^[0-9.]+$/.test(h.replace('*.', ''))) return null; // una IP (incluso a medias) no es un dominio
  return HOST_PATTERN.test(h) ? h : null;
}

/** ¿Este dominio está cubierto por la lista? Coincidencia exacta o, con `*.dominio`, cualquier subdominio (nunca el dominio base). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

export type Destination = { ok: true; url: URL; host: string } | { ok: false; message: string };

/**
 * ¿Esta dirección web es un destino aceptable? `https`, puerto 443 (el predeterminado), sin usuario ni contraseña, un nombre de dominio (no una IP, ni `localhost`) y de largo acotado.
 * NO comprueba la lista de permitidos ni resuelve nombres: eso lo hace quien llama.
 */
export function parseDestination(raw: string): Destination {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, message: `La dirección debe tener entre 1 y ${MAX_URL_LENGTH} caracteres` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'La dirección no es válida' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'Solo se permiten direcciones https://' };
  if (url.username !== '' || url.password !== '') return { ok: false, message: 'La dirección no puede llevar usuario ni contraseña' };
  if (url.port !== '') return { ok: false, message: 'Solo se permite el puerto estándar (443)' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || /^[0-9.]+$/.test(host)) return { ok: false, message: 'La dirección debe usar un nombre de dominio, no una dirección IP' };
  if (host === 'localhost' || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, message: 'Ese dominio no es público' };
  if (!HOST_PATTERN.test(host)) return { ok: false, message: 'El dominio no es válido' };
  return { ok: true, url, host };
}
