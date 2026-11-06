import { useEffect, useState } from 'react';

export interface ViewportBox {
  height: number;
  top: number;
}

/**
 * La zona realmente visible de la pantalla (`visualViewport`), al día cuando cambia (ADR-60, Fase 5). Con el teclado virtual abierto —sobre todo en iOS— la ventana de diseño no se
 * encoge pero la visible sí: un contenedor fijo se ajusta a esta caja para que el redactor quede pegado sobre el teclado. `null` si `active` es falso o el navegador no lo ofrece.
 * No se puede validar sin aparatos reales (iOS y Android se comportan distinto).
 */
export function useVisualViewport(active: boolean): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !vv) return;
    const update = (): void => setBox({ height: Math.round(vv.height), top: Math.round(vv.offsetTop) });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  // Inactivo (o sin la API): sin caja, aunque quede la última medida guardada
  return active ? box : null;
}
