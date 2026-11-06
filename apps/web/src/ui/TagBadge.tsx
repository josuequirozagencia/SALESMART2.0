import { inkFor } from '../lib/color';

/**
 * Una etiqueta pintada con el color que la persona le puso, con el texto oscuro o blanco según cuál se lea mejor sobre ese color (ADR-60): un solo componente para la lista, el chat, el
 * contacto y la atribución, en lugar de texto blanco siempre (ilegible sobre amarillos y otros colores claros).
 */
export function TagBadge({ name, color, pill = false, title }: { name: string; color: string; pill?: boolean; title?: string }) {
  return (
    <span title={title} className={pill ? 'inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold' : 'rounded px-1.5 py-0.5 text-[11px] font-semibold'} style={{ backgroundColor: color, color: inkFor(color) }}>
      {name}
    </span>
  );
}
