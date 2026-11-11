import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';

/** Cuánto hay que mantener el dedo para que cuente como «mantener pulsado». */
export const LONG_PRESS_MS = 500;
/** Cuánto se puede mover el dedo sin que deje de ser «quieto» (px). */
const SLOP = 10;
/** Ancho de la acción que deja ver el deslizamiento (px). */
export const SWIPE_ACTION_W = 88;

/**
 * Gestos de una fila de la lista de conversaciones en pantallas táctiles (v11 S4): MANTENER PULSADO abre las acciones de la fila y DESLIZAR a la izquierda deja ver la acción «Destacar».
 * Solo reacciona a toque y lápiz (con ratón no hace nada: ahí está el botón de la estrella). Un gesto que se completó no debe abrir la conversación: `onClickCapture` se traga ese clic.
 * El desplazamiento vertical de la lista sigue funcionando (`touch-action: pan-y`): solo un movimiento claramente horizontal desliza la fila.
 */
export function useRowGestures({ enabled, onLongPress }: { enabled: boolean; onLongPress: () => void }) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const swallow = useRef(false);
  const dragging = useRef(false);
  const latest = useRef(offset);
  useEffect(() => { latest.current = offset; }, [offset]);

  const clearTimer = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clearTimer, []);

  const close = useCallback((): void => {
    setOpen(false);
    setOffset(0);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled || e.pointerType === 'mouse') return;
    swallow.current = false;
    dragging.current = false;
    start.current = { x: e.clientX, y: e.clientY, base: open ? -SWIPE_ACTION_W : 0 };
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!start.current) return;
      swallow.current = true;
      start.current = null;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) clearTimer();
    if (!dragging.current && Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy) * 1.5) { dragging.current = true; setIsDragging(true); }
    if (dragging.current) setOffset(Math.max(-SWIPE_ACTION_W, Math.min(0, s.base + dx)));
  };

  const finish = (): void => {
    clearTimer();
    if (dragging.current) {
      swallow.current = true;
      const opened = latest.current < -SWIPE_ACTION_W / 2;
      setOpen(opened);
      setOffset(opened ? -SWIPE_ACTION_W : 0);
    }
    dragging.current = false;
    setIsDragging(false);
    start.current = null;
  };

  /** Un gesto terminado (o la fila abierta) no abre la conversación: ese clic se descarta; con la fila abierta, el clic la cierra. */
  const onClickCapture = (e: MouseEvent<HTMLElement>): void => {
    if (swallow.current) {
      swallow.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  /** En móvil, mantener pulsado dispara el menú nativo del sistema: se anula para que salga el nuestro. */
  const onContextMenu = (e: MouseEvent<HTMLElement>): void => {
    if (enabled) e.preventDefault();
  };

  const style: CSSProperties = enabled ? { touchAction: 'pan-y', transform: offset === 0 ? undefined : `translateX(${offset}px)`, transition: isDragging ? 'none' : 'transform 160ms ease-out', userSelect: 'none', WebkitTouchCallout: 'none' } : {};
  return { open, close, style, handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish, onClickCapture, onContextMenu } };
}
