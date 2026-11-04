import { Link, NavLink } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { isNavActive, type NavGroup } from './SidebarShell';

/** Los cuatro accesos directos, en este orden (ADR-60). `to` apunta a secciones que ya existen; «Calendario» es la Agenda. El quinto es siempre el Menú. */
const SHORTCUTS: ReadonlyArray<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: '/', label: 'Inicio', icon: 'home', end: true },
  { to: '/agenda', label: 'Calendario', icon: 'calendar' },
  { to: '/sales', label: 'Ventas', icon: 'dollar' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
];

const tab =
  'relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-semibold transition-colors before:absolute before:top-0 before:h-[3px] before:w-8 before:rounded-b-full before:transition-colors';
const tabState = (active: boolean): string => (active ? `${tab} text-accent before:bg-accent` : `${tab} text-muted before:bg-transparent hover:text-fg`);

/**
 * Barra inferior del móvil (< 768 px): Inicio · Calendario · Ventas · Inbox · Menú. Quien la monta decide cuándo existe (no en ≥ 768 px, ni dentro de una conversación, ni con el
 * teclado abierto). Un acceso que la persona no ve en el menú lateral tampoco aparece aquí (sale de las mismas secciones); el Menú siempre está. El estado activo se marca con
 * color, con una barrita arriba del icono y con `aria-current="page"` (no depende solo del color). «Menú» queda activo si la sección actual no es una de las cuatro.
 */
export function BottomNav({ groups, pathname, unread }: { groups: NavGroup[]; pathname: string; unread: number }) {
  const available = new Set(groups.flatMap((g) => g.items).map((i) => i.to));
  const items = SHORTCUTS.filter((s) => available.has(s.to));
  const onShortcut = SHORTCUTS.some((s) => isNavActive(s, pathname));
  const menuActive = pathname === '/menu' || !onShortcut;
  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_24px_rgba(31,36,51,0.10)] md:hidden"
    >
      <div className="flex h-[var(--bottom-nav-h)] items-stretch px-1">
        {items.map((s) => (
          <NavLink key={s.to} to={s.to} end={s.end} className={({ isActive }) => tabState(isActive)} aria-label={s.to === '/inbox' && unread > 0 ? `Inbox, ${unread > 99 ? 'más de 99' : unread} sin leer` : undefined}>
            <span className="relative">
              <Icon name={s.icon} size={22} />
              {s.to === '/inbox' && unread > 0 ? (
                <span aria-hidden="true" className="absolute -right-3 -top-1.5 grid min-w-[18px] place-items-center rounded-full bg-crit px-1 text-[11px] font-bold leading-[18px] text-white">{unread > 99 ? '99+' : unread}</span>
              ) : null}
            </span>
            {s.label}
          </NavLink>
        ))}
        <Link to="/menu" aria-current={menuActive ? 'page' : undefined} className={tabState(menuActive)}>
          <Icon name="menu" size={22} />
          Menú
        </Link>
      </div>
    </nav>
  );
}
