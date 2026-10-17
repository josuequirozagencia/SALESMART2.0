import { useState } from 'react';
import { Button } from '../../ui/controls';
import type { ColumnDef } from './columns';

/**
 * Menú de columnas (ADR-46 #5): marcar cuáles se ven y subirlas o bajarlas. «Nombre» siempre se ve y va primero (desde ahí se abre el contacto).
 * Las columnas ocultas se listan al final del menú, en el orden del catálogo.
 */
export function ColumnMenu({ catalog, selected, onChange }: { catalog: readonly ColumnDef[]; selected: readonly string[]; onChange: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const label = new Map(catalog.map((c) => [c.key, c.label]));
  const hidden = catalog.filter((c) => !selected.includes(c.key));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (i < 1 || j < 1 || j >= selected.length) return; // «Nombre» no se mueve
    const next = [...selected];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="relative">
      <Button aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>Columnas · {selected.length}</Button>
      {open ? (
        <div role="group" aria-label="Columnas de la tabla" className="absolute right-0 z-20 mt-1 grid max-h-[360px] w-[280px] gap-0.5 overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-[var(--shadow)]">
          {selected.map((k, i) => (
            <div key={k} className="flex items-center gap-2 px-1.5 py-1 text-[13px]">
              <label className="flex flex-1 items-center gap-2">
                <input type="checkbox" checked disabled={k === 'name'} onChange={() => onChange(selected.filter((x) => x !== k))} />
                {label.get(k) ?? k}
              </label>
              {k !== 'name' ? (
                <>
                  <button type="button" aria-label={`Subir ${label.get(k) ?? k}`} disabled={i < 2} onClick={() => move(i, -1)} className="px-1.5 text-muted enabled:hover:text-fg disabled:opacity-30">↑</button>
                  <button type="button" aria-label={`Bajar ${label.get(k) ?? k}`} disabled={i === selected.length - 1} onClick={() => move(i, 1)} className="px-1.5 text-muted enabled:hover:text-fg disabled:opacity-30">↓</button>
                </>
              ) : null}
            </div>
          ))}
          {hidden.length > 0 ? <div className="mt-1 border-t border-line px-1.5 pt-1.5 text-[11.5px] font-semibold text-muted">Otras columnas</div> : null}
          {hidden.map((c) => (
            <label key={c.key} className="flex items-center gap-2 px-1.5 py-1 text-[13px]">
              <input type="checkbox" checked={false} onChange={() => onChange([...selected, c.key])} />
              {c.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
