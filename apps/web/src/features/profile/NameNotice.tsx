import { Link } from 'react-router-dom';
import type { Me } from '../../lib/types';

export const NAME_NOTICE = 'Completa tu nombre para que tus clientes y tu equipo te reconozcan';

/** Aviso discreto mientras la persona no tenga nombre (V25): sin él se la ve como «Asesor». `onDark`: sobre el menú lateral oscuro. */
export function NameNotice({ me, onDark = false }: { me: Me; onDark?: boolean }) {
  if (me.user.full_name) return null;
  return (
    <Link to="/profile" className={onDark ? 'block rounded-lg border border-white/25 px-2.5 py-1.5 text-[11.5px] font-semibold leading-snug text-white hover:bg-white/10' : 'block rounded-xl border border-warn bg-warn-soft px-3.5 py-2.5 text-[13px] font-semibold text-warn hover:underline'}>
      {NAME_NOTICE}
    </Link>
  );
}
