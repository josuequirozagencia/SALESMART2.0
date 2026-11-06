import { useState } from 'react';
import { initials } from '../lib/format';

/**
 * Avatar redondo de tamaño fijo (v5): la foto cuando hay una URL real y, si no hay o falla al cargar, las siglas (sin texto roto). La foto se carga de forma diferida y con el tamaño declarado
 * para que no mueva el diseño. `tone` es el color del círculo de siglas: neutro (contactos), acento suave (equipo) o degradado de la marca (la persona de la sesión).
 */
export function Avatar({ name, src, size = 40, tone = 'neutral', className = '' }: { name: string; src?: string | null | undefined; size?: number; tone?: 'neutral' | 'accent' | 'grad'; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = src && failed !== src ? src : null;
  const look = tone === 'grad' ? 'text-[color:var(--on-grad)] [background:var(--grad)]' : tone === 'accent' ? 'bg-accent-soft text-accent' : 'bg-surface2 text-muted';
  return (
    <span aria-hidden="true" style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.33)) }} className={`grid shrink-0 place-items-center overflow-hidden rounded-full font-bold ${shown ? 'bg-surface2' : look} ${className}`}>
      {shown ? <img src={shown} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(shown)} className="size-full object-cover" /> : initials(name)}
    </span>
  );
}
