import { initials } from '../../lib/format';
import type { Cover } from './useAgents';

/** Color de la portada de cada tarjeta (paleta fija del servidor). */
export const COVER_CLASS: Record<Cover, string> = {
  violet: 'bg-violet-500/25',
  blue: 'bg-blue-500/25',
  teal: 'bg-teal-500/25',
  green: 'bg-green-500/25',
  amber: 'bg-amber-500/25',
  orange: 'bg-orange-500/25',
  rose: 'bg-rose-500/25',
  slate: 'bg-slate-500/25',
};

export const COVER_LABEL: Record<Cover, string> = { violet: 'Violeta', blue: 'Azul', teal: 'Turquesa', green: 'Verde', amber: 'Ámbar', orange: 'Naranja', rose: 'Rosa', slate: 'Gris' };

/** Foto circular del agente; sin foto, sus iniciales. */
export function Avatar({ name, url, size = 56 }: { name: string; url: string | null; size?: number }) {
  return url ? (
    <img src={url} alt="" width={size} height={size} className="rounded-full border-2 border-surface object-cover" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden="true" className="grid place-items-center rounded-full border-2 border-surface bg-surface2 font-bold text-muted" style={{ width: size, height: size, fontSize: size / 2.8 }}>{initials(name)}</span>
  );
}
