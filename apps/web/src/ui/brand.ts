import { useSyncExternalStore } from 'react';

/**
 * Tema de marca (alineación con el prototipo v10): índigo (por omisión), verde o rojo. Es un eje distinto del modo claro/oscuro (`ui/theme.ts`): `data-brand` en <html> cambia el acento,
 * el degradado y los fondos; `data-theme` cambia las superficies. Se guarda en `localStorage` (`ss.brand.v1`) y `public/theme-init.js` lo aplica antes del primer pintado.
 */
export type Brand = 'indigo' | 'green' | 'red';
export const BRANDS: ReadonlyArray<{ id: Brand; label: string; swatch: string }> = [
  { id: 'indigo', label: 'Índigo', swatch: '#4f46e5' },
  { id: 'green', label: 'Verde', swatch: '#00b85c' },
  { id: 'red', label: 'Rojo', swatch: '#d5002b' },
];
export const BRAND_KEY = 'ss.brand.v1';

export const parseBrand = (raw: string | null): Brand => (raw === 'green' || raw === 'red' ? raw : 'indigo');

export function readBrand(): Brand {
  try {
    return parseBrand(window.localStorage.getItem(BRAND_KEY));
  } catch {
    return 'indigo';
  }
}

export function applyBrand(b: Brand): void {
  if (b === 'indigo') document.documentElement.removeAttribute('data-brand');
  else document.documentElement.setAttribute('data-brand', b);
}

const listeners = new Set<() => void>();
let snapshot: Brand | null = null;
const getSnapshot = (): Brand => (snapshot ??= readBrand());
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function setBrand(b: Brand): void {
  snapshot = b;
  try {
    if (b === 'indigo') window.localStorage.removeItem(BRAND_KEY);
    else window.localStorage.setItem(BRAND_KEY, b);
  } catch {
    /* sin almacenamiento: vale mientras la página siga abierta */
  }
  applyBrand(b);
  for (const l of listeners) l();
}

export function useBrand(): [Brand, (b: Brand) => void] {
  return [useSyncExternalStore(subscribe, getSnapshot, () => 'indigo' as Brand), setBrand];
}
