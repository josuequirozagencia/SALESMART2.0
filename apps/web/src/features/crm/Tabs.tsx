/** Pestañas de una ficha (contacto o empresa). Solo presentación: quien llama decide qué panel mostrar. */
export function Tabs<K extends string>({ label, tabs, active, onChange }: { label: string; tabs: ReadonlyArray<readonly [K, string]>; active: K; onChange: (k: K) => void }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-line">
      {tabs.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={active === key}
          onClick={() => onChange(key)}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold ${active === key ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
