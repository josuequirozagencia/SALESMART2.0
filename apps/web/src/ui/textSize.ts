import { useSyncExternalStore } from 'react';

/**
 * Tamaño del texto en ESCRITORIO (v11, punto 1). «Compacto» (por omisión) baja 3 px la escala con piso de 10 px; «Cómodo» deja la de antes. Solo afecta a pantallas de 1024 px o más
 * (la regla vive en `index.css`; en móvil y tablet no cambia nada). Un solo mecanismo: el atributo `data-text="comfortable"` de <html> y la preferencia en `localStorage`
 * (`ss.textsize.v1`, por navegador). `public/theme-init.js` lo aplica antes del primer pintado. Todo acceso al almacenamiento va en try/catch.
 */
export type TextSize = 'compact' | 'comfortable';
export const TEXT_SIZE_KEY = 'ss.textsize.v1';

export const parseTextSize = (raw: string | null): TextSize => (raw === 'comfortable' ? 'comfortable' : 'compact');

export function readTextSize(): TextSize {
  try {
    return parseTextSize(window.localStorage.getItem(TEXT_SIZE_KEY));
  } catch {
    return 'compact';
  }
}

export function applyTextSize(size: TextSize): void {
  const root = document.documentElement;
  if (size === 'comfortable') root.setAttribute('data-text', 'comfortable');
  else root.removeAttribute('data-text');
}

const listeners = new Set<() => void>();
let snapshot: TextSize | null = null;
const getSnapshot = (): TextSize => (snapshot ??= readTextSize());
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function setTextSize(size: TextSize): void {
  snapshot = size;
  try {
    if (size === 'compact') window.localStorage.removeItem(TEXT_SIZE_KEY);
    else window.localStorage.setItem(TEXT_SIZE_KEY, size);
  } catch {
    /* sin almacenamiento: el cambio vale mientras la página siga abierta */
  }
  applyTextSize(size);
  for (const l of listeners) l();
}

export function useTextSize(): [TextSize, (s: TextSize) => void] {
  const size = useSyncExternalStore(subscribe, getSnapshot, () => 'compact' as TextSize);
  return [size, setTextSize];
}
