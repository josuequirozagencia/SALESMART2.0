import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EMOJI_GROUPS, readRecentEmojis, rememberEmoji, searchEmojis, type EmojiItem } from './emoji';

const COLS = 8;

/**
 * Selector de emojis (M5.8): búsqueda por nombre en español, categorías y recientes. Accesible por teclado: Tab llega a la búsqueda y a la cuadrícula; en la cuadrícula las
 * flechas se mueven (Re Pág/Av Pág saltan de fila en fila), Enter o Espacio elige y Esc cierra devolviendo el foco a quien lo abrió. Elegir NO cierra, para poder poner varios.
 */
export function EmojiPicker({ onPick, onClose, label = 'Selector de emojis' }: { onPick: (emoji: string) => void; onClose: () => void; label?: string }) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(EMOJI_GROUPS[0]!.id);
  const [recent, setRecent] = useState<string[]>(() => readRecentEmojis());
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);
  const gridId = useId();

  const items = useMemo<EmojiItem[]>(() => {
    if (query.trim()) return searchEmojis(query);
    if (group === 'recientes') return recent.map((e) => ({ e, n: 'reciente' }));
    return EMOJI_GROUPS.find((x) => x.id === group)?.items ?? [];
  }, [query, group, recent]);

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => { if (root.current && !root.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  const pick = (it: EmojiItem): void => {
    setRecent(rememberEmoji(it.e));
    onPick(it.e);
  };
  const move = (to: number): void => {
    const i = Math.max(0, Math.min(items.length - 1, to));
    setActive(i);
    cells.current[i]?.focus();
  };
  const onGridKey = (e: KeyboardEvent): void => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS, PageDown: COLS * 3, PageUp: -COLS * 3 };
    const s = step[e.key];
    if (s !== undefined) { e.preventDefault(); move(active + s); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(items.length - 1); }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  const tabs = [...(recent.length > 0 ? [{ id: 'recientes', label: 'Recientes' }] : []), ...EMOJI_GROUPS.map((x) => ({ id: x.id, label: x.label }))];

  return (
    <div ref={root} role="dialog" aria-label={label} onKeyDown={onKey} className="absolute bottom-full right-0 z-20 mb-2 grid w-[min(21rem,calc(100vw-2rem))] gap-2 rounded-xl border border-line bg-surface p-2.5 shadow-[var(--shadow)]">
      <input
        autoFocus
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && items.length > 0) { e.preventDefault(); move(0); } }}
        placeholder="Buscar emoji (ej. gracias, fuego)"
        aria-label="Buscar emoji"
        aria-controls={gridId}
        className="min-h-[40px] rounded-[10px] border border-line bg-surface px-3 text-[14px]"
      />
      {query.trim() === '' ? (
        <div role="tablist" aria-label="Categorías" className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={group === t.id} onClick={() => { setGroup(t.id); setActive(0); }} className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${group === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}>{t.label}</button>
          ))}
        </div>
      ) : null}
      <div id={gridId} role="grid" aria-label="Emojis" onKeyDown={onGridKey} className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto">
        {items.length === 0 ? <p role="status" className="col-span-8 px-2 py-4 text-center text-[13px] text-muted">No hay emojis que coincidan con «{query}».</p> : null}
        {items.map((it, i) => (
          <button
            key={`${it.e}-${i}`}
            ref={(el) => { cells.current[i] = el; }}
            type="button"
            role="gridcell"
            tabIndex={i === active ? 0 : -1}
            aria-label={it.n}
            title={it.n}
            onFocus={() => setActive(i)}
            onClick={() => pick(it)}
            className="grid size-9 place-items-center rounded-md text-[20px] hover:bg-surface2 focus-visible:bg-surface2"
          >
            {it.e}
          </button>
        ))}
      </div>
    </div>
  );
}
