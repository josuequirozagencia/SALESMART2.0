import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { initials, ROLE_LABEL } from '../lib/format';
import type { Me } from '../lib/types';
import { Logo } from './AuthShell';

/** Íconos del menú: trazos simples de 24 px (los del prototipo se redibujan aquí; no hay librería de íconos). */
const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4',
  dollar: 'M12 2v20 M17 6.5C16 5 14.5 4.5 12 4.5c-2.8 0-4.5 1.3-4.5 3.2 0 4.5 9.5 2 9.5 6.6 0 1.9-1.8 3.2-4.7 3.2-2.5 0-4.2-.8-5.3-2.4',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20 M10 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.3 M15.5 5.2a3.5 3.5 0 0 1 0 6.6',
  building: 'M4 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17 M15 9h4a1 1 0 0 1 1 1v11 M8 8h3 M8 12h3 M8 16h3 M2 21h20',
  board: 'M3 4h5v16H3z M10 4h5v10h-5z M17 4h4v13h-4z',
  check: 'M4 12l5 5L20 6',
  chart: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  bot: 'M12 3v3 M5 8h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M9 13v1 M15 13v1',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  swap: 'M7 7h13l-3-3 M17 17H4l3 3',
  shield: 'M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  card: 'M3 6h18v12H3z M3 10h18 M7 15h3',
  plug: 'M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'M6 6l12 12 M18 6L6 18',
} as const;
export type IconName = keyof typeof ICONS;

function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {ICONS[name].split(' M').map((d, i) => <path key={i} d={i === 0 ? d : `M${d}`} />)}
    </svg>
  );
}

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Solo está activa con la ruta exacta (el inicio). */
  end?: boolean;
  /**
   * Número en una insignia. Con `label` forma parte del nombre del enlace (lo lee el lector de pantalla: «3 solicitudes pendientes»); sin él es solo visual y va en el `title`.
   */
  badge?: { text: string; label?: string } | null;
}
export interface NavGroup {
  title: string;
  items: NavItem[];
}

const link = ({ isActive }: { isActive: boolean }): string =>
  `flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13.5px] font-semibold transition-colors ${isActive ? 'text-[color:var(--on-grad)] shadow-[0_8px_18px_rgba(106,68,242,.35)] [background:var(--grad)]' : 'text-white/70 hover:bg-white/10 hover:text-white'}`;

/**
 * Marco con MENÚ LATERAL (prototipo v10): barra oscura a la izquierda con la marca, la organización, las secciones agrupadas y, abajo, la persona con «Cerrar sesión». En pantallas
 * angostas el menú se abre desde una barra superior (☰) como panel lateral y se cierra al elegir una sección, con Esc o tocando fuera. Es solo navegación: lo que cada persona puede
 * hacer lo decide el servidor; los grupos que se pasan ya vienen filtrados por quien los arma.
 */
export function SidebarShell({ me, groups, navLabel, onLogout, banner, wide = false, children }: { me: Me; groups: NavGroup[]; navLabel: string; onLogout: () => void; banner?: ReactNode; wide?: boolean; children: ReactNode }) {
  const { pathname } = useLocation();
  // El panel queda abierto solo en la ruta donde se abrió: al elegir una sección (cambia la ruta) se cierra solo; también con Esc o tocando fuera
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (v: boolean): void => setOpenAt(v ? pathname : null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenAt(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const current = groups.flatMap((g) => g.items).find((i) => (i.end ? pathname === i.to : pathname === i.to || pathname.startsWith(`${i.to}/`)));
  const name = me.user.full_name ?? me.user.email;
  return (
    <div className="min-h-full bg-bg">
      {banner}
      <div className="lg:grid lg:grid-cols-[256px_minmax(0,1fr)]">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface px-3 py-2 lg:hidden">
          <button type="button" aria-label="Abrir el menú" aria-expanded={open} aria-controls="side-menu" onClick={() => setOpen(true)} className="grid size-11 place-items-center rounded-xl text-fg hover:bg-surface2"><Icon name="menu" /></button>
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{current?.label ?? 'Sales Smart'}</span>
        </div>
        {open ? <div aria-hidden="true" onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-black/55 lg:hidden" /> : null}
        <aside
          id="side-menu"
          aria-label="Menú principal"
          className={`fixed inset-y-0 left-0 z-50 flex w-[272px] max-w-[85vw] flex-col text-white transition-transform duration-200 [background:var(--side-bg)] lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-auto lg:max-w-none lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-4">
            <span className="text-white [&_i]:text-[color:var(--on-grad)]"><Logo /></span>
            <button type="button" aria-label="Cerrar el menú" onClick={() => setOpen(false)} className="grid size-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 lg:hidden"><Icon name="close" /></button>
          </div>
          <div className="mx-3 mb-2 rounded-xl bg-white/8 px-3 py-2">
            <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-white/50">Organización</span>
            <b className="block truncate text-[13.5px]">{me.organization.name}</b>
          </div>
          <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {groups.map((g) => (
              <div key={g.title} className="mt-3">
                <span className="mb-1 block px-3 text-[10.5px] font-semibold uppercase tracking-wider text-white/45">{g.title}</span>
                <div className="grid gap-0.5">
                  {g.items.map((i) => (
                    <NavLink key={i.to} to={i.to} end={i.end} className={link} title={i.badge && !i.badge.label ? `${i.badge.text} sin leer` : undefined}>
                      <Icon name={i.icon} />
                      <span className="min-w-0 flex-1 truncate">{i.label}</span>
                      {i.badge ? (
                        i.badge.label ? <span aria-label={i.badge.label} className="grid min-w-5 place-items-center rounded-full bg-crit px-1.5 text-[11px] font-bold leading-5 text-white">{i.badge.text}</span> : <span aria-hidden="true" className="grid min-w-5 place-items-center rounded-full bg-crit px-1.5 text-[11px] font-bold leading-5 text-white">{i.badge.text}</span>
                      ) : null}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="flex items-center gap-2.5 border-t border-white/10 p-3">
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full text-[12px] font-bold text-[color:var(--on-grad)] [background:var(--grad)]">{initials(name)}</span>
            <span className="min-w-0 flex-1 text-[12.5px] leading-tight">
              <b className="block truncate">{name}</b>
              <span className="block truncate text-white/55">{ROLE_LABEL[me.role] ?? me.role}</span>
            </span>
            <button type="button" onClick={onLogout} className="rounded-lg border border-white/20 px-2.5 py-1.5 text-[12px] font-semibold text-white/85 hover:bg-white/10">Cerrar sesión</button>
          </div>
        </aside>
        <div className="min-w-0">
          <div className={`mx-auto grid ${wide ? 'max-w-[1500px]' : 'max-w-[1180px]'} grid-cols-[minmax(0,1fr)] gap-4 p-4 sm:p-5`}>{children}</div>
        </div>
      </div>
    </div>
  );
}
