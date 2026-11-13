import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../ui/Icon';
import { Menu, type MenuItem } from '../../ui/Menu';

/** Una acción de la conversación en la cabecera del chat de escritorio (v13 S2.2). `group` 1 = las frecuentes; 2 = las demás (van detrás de un separador). */
export interface HeaderAction {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
  group: 1 | 2;
}

/** Lo que ocupa cada botón (44 px) más la separación entre botones (4 px). */
const STEP = 48;
/** El nombre del contacto conserva siempre este ancho: las acciones se pliegan al «⋮» antes de quitárselo. */
const TITLE_MIN = 160;
/** Como mucho, tantos iconos a la vista (el resto, en el «⋮»). */
export const MAX_VISIBLE = 6;
/** Separación entre los elementos de la fila de la cabecera (`gap-2.5`). */
const GAP = 10;

/**
 * Cuántas acciones caben a la vista en `available` px (función pura, probada aparte). Si todas caben —y no pasan de `MAX_VISIBLE`— no hay «⋮»; si no, el «⋮» ocupa un lugar y siempre
 * queda al menos una acción dentro de él.
 */
export function fitCount(total: number, available: number): number {
  if (total <= 0) return 0;
  if (total <= MAX_VISIBLE && available >= total * STEP) return total;
  return Math.max(0, Math.min(total - 1, MAX_VISIBLE, Math.floor((available - STEP) / STEP)));
}

/**
 * Acciones de la conversación como iconos en la cabecera del chat de escritorio (v13 S2.2; antes eran el botón «Más ⋯»). Cada icono lleva `title` y `aria-label`. Las acciones frecuentes
 * van primero y un separador las aparta de las demás. Cuando el ancho no alcanza —se mide con `ResizeObserver` sobre la fila de la cabecera, `row`— las últimas pasan a un único «⋮»
 * (que NO existe mientras todo cabe). Los hijos de la fila con `data-flex` son los que se estiran (el nombre): cuentan con su ancho mínimo, no con el que tengan ahora.
 */
export function HeaderActionBar({ actions, row }: { actions: HeaderAction[]; /** La fila de la cabecera, ya montada (el padre la recibe con un `ref` en estado: en el primer montaje un `RefObject` todavía es `null` cuando corre este efecto y el observador nunca se engancharía). */ row: HTMLElement | null }) {
  const box = useRef<HTMLDivElement>(null);
  const total = actions.length;
  const [fit, setFit] = useState(() => fitCount(total, Number.POSITIVE_INFINITY));

  useLayoutEffect(() => {
    const measure = (): void => {
      // Sin medidas reales (pruebas con jsdom, pestaña oculta) no se pliega nada: se ven todas las que permite el máximo
      if (!row || row.clientWidth === 0) return setFit(fitCount(total, Number.POSITIVE_INFINITY));
      let used = 0;
      let count = 0;
      for (const child of Array.from(row.children) as HTMLElement[]) {
        if (child === box.current) continue;
        const flex = child.dataset['flex'] !== undefined;
        if (!flex && child.offsetWidth === 0) continue; // oculto (p. ej. el «volver» solo móvil)
        used += flex ? TITLE_MIN : child.offsetWidth;
        count += 1;
      }
      setFit(fitCount(total, row.clientWidth - used - (count + 1) * GAP));
    };
    measure();
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    for (const child of Array.from(row.children)) if (child !== box.current) ro.observe(child);
    return () => ro.disconnect();
  }, [total, row]);

  if (total === 0) return null;
  const shown = actions.slice(0, fit);
  const hidden = actions.slice(fit);
  const menu: MenuItem[] = hidden.map((a) => ({ label: a.label, onSelect: a.onSelect, ...(a.danger ? { danger: true } : {}) }));
  return (
    <div ref={box} role="group" aria-label="Acciones de la conversación" className="flex shrink-0 items-center gap-1">
      {shown.map((a, i) => (
        <Fragment key={a.id}>
          {i > 0 && a.group !== shown[i - 1]!.group ? <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" /> : null}
          <button
            type="button"
            aria-label={a.label}
            title={a.label}
            onClick={a.onSelect}
            className={`grid size-11 place-items-center rounded-full border border-transparent text-muted transition hover:bg-surface2 ${a.danger ? 'hover:text-crit' : 'hover:text-fg'}`}
          >
            <Icon name={a.icon} />
          </button>
        </Fragment>
      ))}
      {hidden.length > 0 ? (
        <Menu label="Más acciones" items={menu} buttonClass="grid size-11 place-items-center rounded-full border border-transparent text-muted transition hover:bg-surface2 hover:text-fg">
          <Icon name="more" strokeWidth={3.2} />
        </Menu>
      ) : null}
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
    </div>
  );
}
