import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const STEP = 16;
const STEP_BIG = 64;

/**
 * Divisor vertical arrastrable entre dos columnas (ADR-60, Fase 3; implementación propia con Pointer Events, sin librería). Accesible: `role="separator"` enfocable con
 * `aria-valuenow/min/max`; flechas ±16 px (Mayús ±64), Inicio pliega la columna, Fin la lleva a su máximo y doble clic la restaura. Mientras se arrastra no se re-renderiza nada
 * del hilo: `onPreview` recibe el ancho a cada cuadro de animación (quien lo usa lo pone en una variable CSS) y `onCommit` solo se llama al soltar (ahí se guarda).
 *
 * `grows` es hacia dónde crece la columna que controla al arrastrar hacia la derecha: +1 si es la de la izquierda (la lista), −1 si es la de la derecha (el contacto).
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  grows,
  onPreview,
  onCommit,
  onCollapse,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  grows: 1 | -1;
  onPreview: (px: number) => void;
  onCommit: (px: number) => void;
  onCollapse: () => void;
  onReset: () => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ x: number; start: number; last: number; frame: number | null } | null>(null);
  const clamp = (v: number): number => Math.min(max, Math.max(min, Math.round(v)));

  // Si el componente se va con un arrastre en curso, se devuelve el cursor y la selección de texto
  useEffect(
    () => () => {
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
    },
    [],
  );

  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button > 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura (entornos sin soporte): el arrastre sigue por los eventos del propio divisor */
    }
    drag.current = { x: e.clientX, start: value, last: value, frame: null };
    setLive(value);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    d.last = clamp(d.start + grows * (e.clientX - d.x));
    d.frame ??= requestAnimationFrame(() => {
      if (!drag.current) return;
      drag.current.frame = null;
      onPreview(drag.current.last);
      setLive(drag.current.last);
    });
  };
  const up = (): void => {
    const d = drag.current;
    if (!d) return;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    drag.current = null;
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
    setLive(null);
    onCommit(d.last);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? STEP_BIG : STEP;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onCommit(clamp(value + (e.key === 'ArrowRight' ? 1 : -1) * grows * step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onCollapse();
    } else if (e.key === 'End') {
      e.preventDefault();
      onCommit(max);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={live ?? value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={live !== null}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={onReset}
      title="Arrastra para cambiar el ancho · doble clic para restaurar"
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none"
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent group-data-[dragging=true]:bg-accent" />
    </div>
  );
}
