/** La marca «Ejemplo» de los datos que crea el sistema al abrir una empresa (M10.6, ADR-56 B5): se pueden editar y borrar como cualquier otro dato. */
export function SamplePill({ show }: { show?: boolean | undefined }) {
  if (!show) return null;
  return <span className="ml-2 inline-block rounded-full border border-line bg-surface2 px-2 py-0.5 align-middle text-[11px] font-semibold text-muted" title="Dato de ejemplo: puedes editarlo o borrarlo">Ejemplo</span>;
}
