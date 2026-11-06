import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * Menú desplegable accesible (patrón «menu button»): el botón abre una lista de acciones; Esc o un clic fuera la cierran (Esc devuelve el foco al botón), las flechas, Inicio y Fin
 * mueven el foco entre las acciones y elegir una la ejecuta y cierra. `label` es el nombre accesible del botón; `children` su contenido visible.
 */
export function Menu({ label, items, children, className = '', buttonClass }: { label: string; items: MenuItem[]; children: React.ReactNode; className?: string; buttonClass?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (items.length === 0) return null;

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={root} className={`relative ${className}`} onKeyDown={open ? onKeys : undefined}>
      <button ref={button} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((v) => !v)} className={buttonClass ?? `inline-flex items-center gap-1 rounded-[10px] border px-3 py-1.5 text-[12.5px] font-semibold transition ${open ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface2'}`}>
        {children}
      </button>
      {open ? (
        <div id={id} role="menu" aria-label={label} className="absolute right-0 top-full z-30 mt-1 grid min-w-[190px] gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow)]">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); it.onSelect(); }} className={`rounded-lg px-3 py-2 text-left text-[13px] font-semibold hover:bg-surface2 focus:bg-surface2 focus:outline-none ${it.danger ? 'text-crit' : ''}`}>
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
