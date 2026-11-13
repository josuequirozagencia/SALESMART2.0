/**
 * Ubicación de un mensaje entrante, normalizada y VALIDADA (v13 S3.2). La leen igual Meta Cloud (`type: location`) y Evolution (`locationMessage`). Se guarda en el mensaje como
 * `extra.location = { latitude, longitude, name, address }` (la forma que la interfaz ya leía). Las coordenadas son dato personal: nunca van a logs ni a errores.
 */
export interface NormalizedLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string | null;
  readonly address: string | null;
}

const MAX_NAME = 200;
const MAX_ADDRESS = 300;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, max);
};

/** Latitud en [−90, 90] y longitud en [−180, 180], números finitos: si no, `null` (el mensaje llega sin ubicación y se muestra solo como «Ubicación»). */
export function readLocation(latitude: unknown, longitude: unknown, name: unknown, address: unknown): NormalizedLocation | null {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, name: text(name, MAX_NAME), address: text(address, MAX_ADDRESS) };
}
