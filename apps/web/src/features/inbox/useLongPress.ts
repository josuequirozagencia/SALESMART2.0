import { useEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';

/** Cuánto hay que mantener pulsado (ms). El mismo umbral que el de las filas de la lista (v11 S4). */
export const HOLD_MS = 500;
/** Cuánto se puede mover el dedo sin que deje de contar como «quieto» (px); más que eso cancela el gesto. */
const SLOP = 10;

/**
 * MANTENER PULSADO un botón (v13 S1.5): al cumplirse `HOLD_MS` con el dedo quieto se llama a `onLongPress` (con una vibración corta si el aparato la tiene) y el toque que sigue NO cuenta como clic
 * —`consumeClick()` dice si hay que ignorar el clic—. Si el dedo se mueve más de 10 px, se levanta antes de tiempo o se cancela el toque, no pasa nada. Sin menú contextual del sistema ni selección
 * de texto. Es solo una ayuda: lo que hace el gesto siempre tiene otra vía accesible (botón, menú).
 */
export function useLongPress({ enabled, onLongPress, ms = HOLD_MS }: { enabled: boolean; onLongPress: () => void; ms?: number }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const latest = useRef(onLongPress);
  useEffect(() => { latest.current = onLongPress; });

  const clear = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    origin.current = null;
  };
  useEffect(() => clear, []);

  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    fired.current = false;
    clear();
    origin.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      timer.current = undefined;
      origin.current = null;
      fired.current = true;
      try { navigator.vibrate?.(15); } catch { /* sin vibración: no es esencial */ }
      latest.current();
    }, ms);
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    const o = origin.current;
    if (o && (Math.abs(e.clientX - o.x) > SLOP || Math.abs(e.clientY - o.y) > SLOP)) clear();
  };
  /** En móvil, mantener pulsado abre el menú nativo del sistema: se anula para que salga lo nuestro. */
  const onContextMenu = (e: MouseEvent<HTMLElement>): void => {
    if (enabled) e.preventDefault();
  };
  /** ¿Este clic es el que sigue a un «mantener pulsado»? Entonces hay que ignorarlo (y solo una vez). */
  const consumeClick = (): boolean => {
    if (!fired.current) return false;
    fired.current = false;
    return true;
  };

  const style: CSSProperties = enabled ? { touchAction: 'manipulation', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } : {};
  return { style, consumeClick, handlers: { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear, onPointerLeave: clear, onContextMenu } };
}
