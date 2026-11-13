import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

/** Cuánto hay que arrastrar a la derecha para que cuente como «responder» (px). */
export const REPLY_THRESHOLD = 60;
/** Lo máximo que la burbuja acompaña al dedo (px). */
const MAX_PULL = 88;
/** Un arrastre que empieza tan cerca del borde izquierdo es el gesto «atrás» del sistema (iOS): se ignora (px). */
export const EDGE_GUARD = 20;
/** Movimiento mínimo para decidir si el gesto es horizontal o vertical (px). */
const SLOP = 10;

/**
 * RESPONDER ARRASTRANDO una burbuja a la derecha, como en WhatsApp (v13 S3.3). Solo toque y lápiz (con ratón están el botón «Responder» y el teclado). El desplazamiento vertical del hilo
 * manda: si el dedo se mueve más en vertical, el gesto se cancela y la lista sigue su camino (`touch-action: pan-y`: el navegador solo se queda con lo vertical, y mientras se arrastra en
 * horizontal el hilo no se mueve). Un arrastre que empieza a menos de 20 px del borde izquierdo se ignora para no pelear con el gesto «atrás» de iOS. Al pasar el umbral (60 px) vibra una
 * vez y, al soltar, llama a `onReply`; si se suelta antes, la burbuja vuelve a su sitio. Con «reducir movimiento» la burbuja no se anima al volver. Siempre hay otra vía (el botón
 * «Responder» de la burbuja, que se alcanza con el teclado y los lectores de pantalla).
 */
export function useSwipeReply({ enabled, onReply }: { enabled: boolean; onReply: () => void }) {
  const [pull, setPull] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const locked = useRef(false);
  const reached = useRef(false);
  const latest = useRef(onReply);
  useEffect(() => { latest.current = onReply; });

  const reset = (): void => {
    start.current = null;
    locked.current = false;
    reached.current = false;
    setPull(0);
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled || e.pointerType === 'mouse' || e.isPrimary === false) return;
    if (e.clientX < EDGE_GUARD) return;
    start.current = { x: e.clientX, y: e.clientY };
    locked.current = false;
    reached.current = false;
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!locked.current) {
      // Gana lo vertical (desplazar el hilo): el gesto se cancela
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) { start.current = null; return; }
      // Solo un arrastre claramente horizontal y hacia la derecha cuenta
      if (!(dx > SLOP && dx > Math.abs(dy) * 1.5)) return;
      locked.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* sin captura: el arrastre sigue mientras el dedo esté encima */ }
    }
    const next = Math.max(0, Math.min(MAX_PULL, dx));
    setPull(next);
    if (next >= REPLY_THRESHOLD && !reached.current) {
      reached.current = true;
      try { navigator.vibrate?.(10); } catch { /* sin vibración: no es esencial */ }
    } else if (next < REPLY_THRESHOLD) reached.current = false;
  };

  const onPointerUp = (): void => {
    const fire = locked.current && reached.current;
    reset();
    if (fire) latest.current();
  };

  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const style: CSSProperties = enabled
    ? { touchAction: 'pan-y', transform: pull > 0 ? `translateX(${pull}px)` : undefined, transition: pull === 0 && !reduced ? 'transform 160ms ease-out' : undefined }
    : {};
  return { pull, progress: Math.min(1, pull / REPLY_THRESHOLD), style, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: reset } };
}
