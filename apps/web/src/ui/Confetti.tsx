import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { runConfetti } from '../lib/celebrate';

/**
 * Confeti de celebración (v7 fase D): un canvas a pantalla completa, sin interacción (`pointer-events: none`) y oculto a los lectores de pantalla. Dura unos 2,5 s y se limpia solo; si el componente
 * se desmonta (la persona cambia de pantalla o cierra el diálogo) se cancela al instante.
 */
export function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    return runConfetti(c);
  }, []);
  return createPortal(<canvas ref={ref} aria-hidden="true" data-testid="confetti" style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 9999 }} />, document.body);
}
