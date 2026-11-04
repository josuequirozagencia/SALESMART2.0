import { useEffect, useState } from 'react';

/**
 * Único origen de los cortes de pantalla (ADR-60). Coinciden con `md` (768) y `xl` (1280) de Tailwind: lo que el CSS decide con `md:` / `xl:` y lo que el código decide con
 * `useBreakpoint()` no se contradicen (una prueba lo comprueba). Móvil: hasta 767 · Tablet: 768–1279 · Escritorio: desde 1280.
 */
export const MOBILE_MAX = 767;
export const DESKTOP_MIN = 1280;

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const MOBILE_QUERY = `(max-width: ${MOBILE_MAX}px)`;
const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN}px)`;

/** El corte según el ancho dado (pura; la usan el hook y las pruebas). */
export function breakpointOf(width: number): Breakpoint {
  if (width <= MOBILE_MAX) return 'mobile';
  return width >= DESKTOP_MIN ? 'desktop' : 'tablet';
}

function current(): Breakpoint {
  // Sin `matchMedia` (pruebas en jsdom, entornos sin navegador) se asume escritorio: la interfaz de siempre
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop';
  if (window.matchMedia(MOBILE_QUERY).matches) return 'mobile';
  return window.matchMedia(DESKTOP_QUERY).matches ? 'desktop' : 'tablet';
}

/** El corte de pantalla actual; se actualiza solo al redimensionar o girar el aparato. */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(current);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const lists = [window.matchMedia(MOBILE_QUERY), window.matchMedia(DESKTOP_QUERY)];
    const update = (): void => setBp(current());
    for (const l of lists) l.addEventListener('change', update);
    update();
    return () => {
      for (const l of lists) l.removeEventListener('change', update);
    };
  }, []);
  return bp;
}
