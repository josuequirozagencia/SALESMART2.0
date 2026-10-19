export const QUEUE_COLORS = ['#0b7a6b', '#2b5bb8', '#9a6200', '#7c5cfa', '#c2410c', '#be185d', '#475569'] as const;
export const DEFAULT_QUEUE_COLOR = '#7c5cfa';

/** Elige el color de una cola entre unos pocos que se distinguen bien (la cola se reconoce por él en el resto de la aplicación). */
export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Color de la cola" className="flex flex-wrap gap-2">
      {QUEUE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={`Color ${c}`}
          onClick={() => onChange(c)}
          style={{ backgroundColor: c }}
          className={`size-7 rounded-full border-2 ${value === c ? 'border-fg ring-2 ring-accent' : 'border-transparent'}`}
        />
      ))}
    </div>
  );
}
