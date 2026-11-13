import { useEffect, useSyncExternalStore } from 'react';

/** La marca de la plataforma que ve la interfaz (nombre, logos e icono). La define el Súper Admin en Plataforma › Marca; el servidor la escribe en el HTML al servirlo. */
export interface Brand {
  name: string;
  shortName: string | null;
  /** Versión del icono: va como `?v=` en las direcciones para ver siempre la imagen nueva. */
  version: string;
  logo: { light: string | null; dark: string | null };
  iconCustom: boolean;
  icon192: string | null;
  /** La silueta monocroma de las notificaciones (Android). */
  badge96: string | null;
  /** El sonido propio de mensaje nuevo (con su versión) o `null`: la aplicación usa su tono por omisión. */
  sound: string | null;
}

export const DEFAULT_BRAND_NAME = 'Sales Smart 2.0';
const DEFAULT: Brand = { name: DEFAULT_BRAND_NAME, shortName: null, version: 'default-1', logo: { light: null, dark: null }, iconCustom: false, icon192: null, badge96: null, sound: null };

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** Solo direcciones de la propia aplicación (`/v1/branding/...`): nada que cargue una imagen de otro sitio. */
const own = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && s.startsWith('/v1/branding/') ? s : null;
};

/** Convierte lo que llega (del HTML o de `GET /v1/branding`) en una marca válida; lo que no tenga la forma esperada cae a los valores por defecto. */
export function parseBrand(raw: unknown): Brand {
  if (raw === null || typeof raw !== 'object') return DEFAULT;
  const r = raw as Record<string, unknown>;
  const logo = (r['logo'] ?? {}) as Record<string, unknown>;
  const icon = (r['icon'] ?? {}) as Record<string, unknown>;
  return {
    name: str(r['name']) ?? DEFAULT.name,
    shortName: str(r['short_name']),
    version: str(r['version']) ?? DEFAULT.version,
    logo: { light: own(logo['light']), dark: own(logo['dark']) },
    iconCustom: icon['custom'] === true,
    icon192: own(icon['icon_192']),
    badge96: own(icon['badge_96']),
    sound: own(r['sound']),
  };
}

/** Lee el bloque `<script id="brand-data" type="application/json">` que escribe el servidor (sin petición extra y sin parpadeo). Sin él (desarrollo, pruebas) usa los valores por defecto. */
function readBlock(): Brand {
  try {
    const el = document.getElementById('brand-data');
    return el?.textContent ? parseBrand(JSON.parse(el.textContent)) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

let current: Brand = readBlock();
const listeners = new Set<() => void>();

export function getBrand(): Brand {
  return current;
}

export function setBrand(next: Brand): void {
  current = next;
  for (const l of listeners) l();
}

/** Solo para pruebas: vuelve a leer el HTML (o los valores por defecto). */
export function resetBrand(): void {
  setBrand(readBlock());
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Avisa cuando cambia la marca (para volver a preparar el sonido propio). */
export function subscribeBrand(cb: () => void): () => void {
  return subscribe(cb);
}

export function useBrand(): Brand {
  return useSyncExternalStore(subscribe, getBrand, getBrand);
}

/** Cambia el icono de ESTA pestaña al instante (las demás lo verán cuando el navegador renueve su copia, hasta 5 minutos). */
export function refreshTabIcon(version: string): void {
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (link) link.href = `/v1/branding/favicon?v=${encodeURIComponent(version)}`;
  } catch {
    /* sin DOM utilizable: no pasa nada */
  }
}

/** Vuelve a pedir la marca al servidor (después de que el Súper Admin la cambia) y actualiza la interfaz y el icono de esta pestaña. Un fallo no rompe nada: queda lo que había. */
export async function refreshBrand(): Promise<void> {
  try {
    const res = await fetch('/v1/branding', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return;
    const b = parseBrand(await res.json());
    setBrand(b);
    refreshTabIcon(b.version);
  } catch {
    /* sin red o sin respuesta válida: se queda la marca anterior */
  }
}

/** «Sección · Nombre» en la pestaña del navegador; sin sección, solo el nombre. */
export function titleFor(section: string | null | undefined, name: string): string {
  const s = section?.trim();
  return s ? `${s} · ${name}` : name;
}

export function useDocumentTitle(section?: string | null): void {
  const { name } = useBrand();
  useEffect(() => {
    document.title = titleFor(section, name);
  }, [section, name]);
}
