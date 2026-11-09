/**
 * Qué direcciones de suscripción se aceptan. El servidor ENVÍA una petición a la dirección que trae el navegador, así que sin esta lista cualquiera podría hacer que el servidor llame a una
 * dirección interna o ajena (SSRF). Solo https, sin usuario/contraseña ni puerto raro, y solo los servicios de push de los navegadores: Chrome/Edge/Opera (FCM), Firefox (Mozilla autopush),
 * Safari (Apple) y Windows (WNS).
 */
const EXACT = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];
export const MAX_ENDPOINT_CHARS = 1000;

export function isAllowedPushEndpoint(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_ENDPOINT_CHARS) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || (u.port !== '' && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return EXACT.has(host) || SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}
