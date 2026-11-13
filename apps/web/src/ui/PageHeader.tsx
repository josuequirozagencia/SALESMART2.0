import type { ReactNode } from 'react';

/** Clases del título de una pantalla (el `h1` del prototipo v10: 21 px, peso 800, interlineado cerrado). Las pantallas con un encabezado propio lo reutilizan para no desviarse. */
export const PAGE_TITLE = 'text-[21px] font-extrabold tracking-[-0.02em]';

/**
 * Encabezado común de una pantalla (v13 S6, alineación con el prototipo): el título y, debajo, una línea de descripción en gris, a la izquierda; las acciones principales, a la derecha y
 * alineadas con la base del bloque (como `.page-h` del prototipo). En pantallas angostas las acciones bajan. Solo presentación: el título sigue siendo el `h1` de la página.
 */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className={PAGE_TITLE}>{title}</h1>
        {description ? <p className="mt-0.5 max-w-[70ch] text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
