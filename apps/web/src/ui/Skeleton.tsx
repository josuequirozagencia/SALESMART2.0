/**
 * Filas de carga de una lista (ADR-60): mientras llegan los datos se ve la forma de lo que vendrá, no un círculo girando. Es un `role="status"` con su nombre accesible; el
 * parpadeo se apaga con `prefers-reduced-motion` (regla global).
 */
export function SkeletonRows({ count = 7, label }: { count?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="grid">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="grid min-h-[72px] animate-pulse grid-cols-[48px_minmax(0,1fr)] items-center gap-3 border-b border-line px-3 py-2.5">
          <span className="size-12 rounded-full bg-surface2" />
          <span className="grid gap-2">
            <span className="h-3 w-2/5 rounded bg-surface2" />
            <span className="h-3 w-4/5 rounded bg-surface2" />
          </span>
        </div>
      ))}
    </div>
  );
}
