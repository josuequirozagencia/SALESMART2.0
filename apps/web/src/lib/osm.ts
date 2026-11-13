/**
 * Baldosas de OpenStreetMap para la miniatura de una ubicación (v13 S3.2). Todo es cálculo puro (proyección Web Mercator): la interfaz arma la miniatura con las pocas baldosas que cubren
 * el recuadro, centrada en el punto. Las coordenadas se validan antes de usarse.
 */
export const TILE_SIZE = 256;
/** La proyección Mercator no llega a los polos: más allá de esta latitud se recorta. */
const MAX_LAT = 85.0511;

export interface Place { latitude: number; longitude: number }

/** ¿Son coordenadas válidas? (números finitos, latitud en [−90, 90] y longitud en [−180, 180]). */
export function validPlace(v: unknown): v is Place {
  if (typeof v !== 'object' || v === null) return false;
  const { latitude: la, longitude: lo } = v as Record<string, unknown>;
  return typeof la === 'number' && typeof lo === 'number' && Number.isFinite(la) && Number.isFinite(lo) && la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
}

/** Píxeles globales del punto al nivel de zoom `z` (el mundo mide 256 · 2^z píxeles de lado). */
export function worldPixel(p: Place, z: number): { x: number; y: number } {
  const n = 2 ** z * TILE_SIZE;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.latitude)) * (Math.PI / 180);
  return { x: ((p.longitude + 180) / 360) * n, y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n };
}

export interface MapTile { url: string; left: number; top: number }

/**
 * Las baldosas que cubren un recuadro de `width` × `height` px centrado en el punto, con su posición dentro del recuadro. Como mucho 2 × 2 si el recuadro cabe en una baldosa (el caso
 * habitual: pocas peticiones al servidor de baldosas, como pide su política de uso). La longitud se envuelve alrededor del mundo; las filas fuera del mapa se omiten.
 */
export function mapTiles(p: Place, z: number, width: number, height: number): MapTile[] {
  const c = worldPixel(p, z);
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const tiles = 2 ** z;
  const out: MapTile[] = [];
  for (let ty = Math.floor(top / TILE_SIZE); ty <= Math.floor((top + height - 1) / TILE_SIZE); ty += 1) {
    if (ty < 0 || ty >= tiles) continue;
    for (let tx = Math.floor(left / TILE_SIZE); tx <= Math.floor((left + width - 1) / TILE_SIZE); tx += 1) {
      const wrapped = ((tx % tiles) + tiles) % tiles;
      out.push({ url: `https://tile.openstreetmap.org/${z}/${wrapped}/${ty}.png`, left: Math.round(tx * TILE_SIZE - left), top: Math.round(ty * TILE_SIZE - top) });
    }
  }
  return out;
}

/** Enlace para abrir el punto en el mapa de OpenStreetMap (la persona decide a qué aplicación ir desde ahí). */
export const mapLink = (p: Place, z = 16): string => `https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=${z}/${p.latitude}/${p.longitude}`;
