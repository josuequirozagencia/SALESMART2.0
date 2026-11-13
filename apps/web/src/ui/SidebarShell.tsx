import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ROLE_LABEL } from '../lib/format';
import type { Me } from '../lib/types';
import { useBrand, useDocumentTitle } from '../lib/platformBrand';
import { BrandMark, Logo } from './AuthShell';
import { Avatar } from './Avatar';
import { useBreakpoint } from './breakpoints';
import { Icon, type IconName } from './Icon';
import { useSidebarCollapsed } from './layoutStore';
import { ThemeToggle } from './ThemeToggle';

export type { IconName } from './Icon';

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

/** ¿Esta sección es la que se está viendo? (mismo criterio que el enlace activo). */
export const isNavActive = (item: NavItem, pathname: string): boolean => (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`));

const link = (compact: boolean) => ({ isActive }: { isActive: boolean }): string =>
  // v13 S6: en pantallas ≥ 768 px los valores del prototipo (botón de 6 × 10 px, texto de 12,5 px, icono de 16 px; el de la barra plegada, 18 px). En móvil se conserva el área táctil de 40 px.
  `relative flex min-h-10 items-center rounded-xl text-[13px] transition-colors md:min-h-0 md:py-1.5 md:text-[12.5px] ${compact ? 'justify-center px-0' : 'gap-2.5 px-3 md:px-2.5'} ${
    isActive
      ? 'font-semibold text-[color:var(--on-grad)] [background:var(--grad)] shadow-[0_8px_18px_var(--glow)]'
      : 'font-medium text-white/75 hover:bg-white/10 hover:text-white'
  }`;

/** Insignia de una sección: número (barra expandida) o punto sobre el icono (barra plegada). */
function Badge({ badge, compact }: { badge: NonNullable<NavItem['badge']>; compact: boolean }) {
  if (compact) return <span aria-hidden="true" className="absolute right-2 top-1.5 size-2.5 rounded-full bg-crit" />;
  const cls = 'grid min-w-5 place-items-center rounded-full bg-crit px-1.5 text-[11px] font-bold leading-5 text-white';
  return badge.label ? <span aria-label={badge.label} className={cls}>{badge.text}</span> : <span aria-hidden="true" className={cls}>{badge.text}</span>;
}

type SidebarProps = {
  me: Me;
  groups: NavGroup[];
  navLabel: string;
  onLogout: () => void;
  banner?: ReactNode;
  /** Lo que va entre las secciones y la persona (campana de avisos, «Ver como»). Si es función, recibe si la barra está plegada. */
  extra?: ReactNode | ((compact: boolean) => ReactNode);
  wide?: boolean;
  /** Sin ancho máximo: la sección usa todo el ancho junto a la barra lateral, con 24 px de margen (16 px en móvil). Para las pantallas de datos (v11). */
  fluid?: boolean;
  /**
   * Qué pasa con el menú en móvil (< 768 px). `bar` (por omisión; consola de plataforma y agencia): barra superior con ☰ y panel lateral. `bottom` (la empresa, ADR-60): no hay
   * barra superior ni panel; la navegación es la barra inferior y la página `/menu`, que pone el marco que lo usa.
   */
  mobileNav?: 'bar' | 'bottom';
  /** Con `mobileNav = 'bottom'`: reservar al pie el alto de la barra inferior para que no tape contenido. */
  reserveBottom?: boolean;
  /** Contenido a todo el alto y ancho de la ventana, sin márgenes ni ancho máximo (el Inbox, v5). */
  flush?: boolean;
  /** Foto de la persona de la sesión (si la tiene): reemplaza a las siglas del pie. */
  photoUrl?: string | null;
  children: ReactNode;
};

/**
 * Marco con MENÚ LATERAL: barra oscura a la izquierda con la marca, la organización, las secciones agrupadas y, abajo, el tema y la persona con «Cerrar sesión».
 * Con `mobileNav = 'bottom'` la barra se puede plegar a solo iconos (≈68 px; plegada por omisión en tablet) y la preferencia se guarda por persona y empresa; en móvil
 * desaparece (la reemplazan la barra inferior y `/menu`). Con `mobileNav = 'bar'` se comporta como siempre: en pantallas angostas se abre desde una barra superior (☰).
 * Es solo navegación: lo que cada persona puede hacer lo decide el servidor; los grupos que se pasan ya vienen filtrados por quien los arma.
 */
export function SidebarShell({ me, groups, navLabel, onLogout, banner, extra, wide = false, fluid = false, mobileNav = 'bar', reserveBottom = false, flush = false, photoUrl = null, children }: SidebarProps) {
  const { pathname } = useLocation();
  const bottom = mobileNav === 'bottom';
  const bp = useBreakpoint();
  // El panel (modo barra superior) queda abierto solo en la ruta donde se abrió: al elegir una sección (cambia la ruta) se cierra solo; también con Esc o tocando fuera
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (v: boolean): void => setOpenAt(v ? pathname : null);
  const [collapsedPref, setCollapsed] = useSidebarCollapsed(me.user.id, me.organization.id, bp === 'tablet');
  const compact = bottom && collapsedPref;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenAt(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const current = groups.flatMap((g) => g.items).find((i) => isNavActive(i, pathname));
  const brand = useBrand();
  useDocumentTitle(current?.label); // «Sección · Nombre» en la pestaña del navegador
  const name = me.user.full_name ?? me.user.email;
  const extraNode = typeof extra === 'function' ? extra(compact) : extra;
  // v6 fase B: en escritorio la página NO se desplaza. El marco mide exactamente la ventana (`h-dvh`): banners arriba, y debajo el menú y el contenido, que se desplaza por dentro
  const frame = bottom ? 'md:flex md:h-dvh md:flex-col md:overflow-hidden' : 'lg:flex lg:h-dvh lg:flex-col lg:overflow-hidden';
  const grid = bottom ? (compact ? 'md:grid md:min-h-0 md:flex-1 md:grid-rows-[minmax(0,1fr)] md:grid-cols-[68px_minmax(0,1fr)]' : 'md:grid md:min-h-0 md:flex-1 md:grid-rows-[minmax(0,1fr)] md:grid-cols-[232px_minmax(0,1fr)]') : 'lg:grid lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[232px_minmax(0,1fr)]';
  const scroller = bottom ? 'md:min-h-0 md:overflow-y-auto' : 'lg:min-h-0 lg:overflow-y-auto';
  const asideCls = bottom
    ? 'hidden md:z-auto md:flex md:h-full md:min-h-0'
    : `fixed inset-y-0 left-0 z-50 flex w-[272px] max-w-[85vw] transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'} lg:sticky lg:top-0 lg:z-auto lg:h-full lg:min-h-0 lg:w-auto lg:max-w-none lg:translate-x-0`;
  return (
    <div className={`min-h-full bg-bg ${frame}`}>
      {banner}
      <div className={`${grid} md:transition-[grid-template-columns] md:duration-200`}>
        {bottom ? null : (
          <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface px-3 py-2 lg:hidden">
            <button type="button" aria-label="Abrir el menú" aria-expanded={open} aria-controls="side-menu" onClick={() => setOpen(true)} className="grid size-11 place-items-center rounded-xl text-fg hover:bg-surface2">
              <Icon name="menu" size={22} />
            </button>
            <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{current?.label ?? brand.name}</span>
            {me.viewing_as ? <span className="shrink-0 rounded-full border border-warn bg-warn-soft px-2.5 py-1 text-[11.5px] font-bold text-warn">Viendo como {ROLE_LABEL[me.viewing_as] ?? me.viewing_as}</span> : null}
          </div>
        )}
        {!bottom && open ? <div aria-hidden="true" onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-black/55 lg:hidden" /> : null}
        <aside id="side-menu" aria-label="Menú principal" className={`${asideCls} min-w-0 flex-col overflow-hidden text-white [background:var(--side-bg)]`}>
          <div className={`flex gap-2 pb-3 pt-4 ${compact ? 'flex-col items-center px-2' : 'items-center justify-between px-4'}`}>
            {compact ? (
              <BrandMark />
            ) : (
              <span className="min-w-0 text-white [&_i]:text-[color:var(--on-grad)]"><Logo /></span>
            )}
            {bottom ? (
              <button
                type="button"
                aria-label={compact ? 'Desplegar el menú' : 'Plegar el menú'}
                aria-expanded={!compact}
                aria-controls="side-menu"
                title={compact ? 'Desplegar el menú' : 'Plegar el menú'}
                onClick={() => setCollapsed(!compact)}
                className="grid size-9 shrink-0 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white"
              >
                <Icon name={compact ? 'chevronsRight' : 'chevronsLeft'} size={18} />
              </button>
            ) : (
              <button type="button" aria-label="Cerrar el menú" onClick={() => setOpen(false)} className="grid size-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 lg:hidden"><Icon name="close" /></button>
            )}
          </div>
          {compact ? null : (
            <div className="mx-3 mb-2 rounded-xl bg-white/8 px-3 py-2">
              <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-white/60">Organización</span>
              <b className="block truncate text-[13px]">{me.organization.name}</b>
            </div>
          )}
          <nav aria-label={navLabel} className={`min-h-0 flex-1 overflow-y-auto pb-3 [scrollbar-color:rgba(255,255,255,0.28)_transparent] [scrollbar-width:thin] ${compact ? 'px-2' : 'px-3'}`}>
            {groups.map((g, gi) => (
              <div key={g.title} className={compact ? (gi === 0 ? 'mt-1' : 'mt-2 border-t border-white/10 pt-2') : 'mt-3'}>
                {compact ? null : <span className="mb-1 block px-3 text-[10.5px] font-semibold uppercase tracking-wider text-white/55">{g.title}</span>}
                <div className="grid gap-0.5">
                  {g.items.map((i) => (
                    <NavLink key={i.to} to={i.to} end={i.end} className={link(compact)} title={compact ? i.label : i.badge && !i.badge.label ? `${i.badge.text} sin leer` : undefined}>
                      <Icon name={i.icon} className={compact ? 'shrink-0 md:size-[18px]' : 'shrink-0 md:size-4'} />
                      {compact ? <span className="sr-only">{i.label}</span> : <span className="min-w-0 flex-1 truncate">{i.label}</span>}
                      {i.badge ? <Badge badge={i.badge} compact={compact} /> : null}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          {extraNode}
          <div className={`border-t border-white/10 ${compact ? 'grid justify-items-center gap-1 px-2 py-2' : 'grid gap-1 p-3'}`}>
            {bottom ? null : <ThemeToggle onDark />}
            <div className={`flex items-center gap-2.5 ${compact ? 'flex-col pt-1' : 'pt-1'}`}>
              <span title={compact ? `${name} · ${ROLE_LABEL[me.role] ?? me.role}` : undefined}><Avatar name={name} src={photoUrl} size={36} tone="grad" /></span>
              {compact ? null : (
                <span className="min-w-0 flex-1 text-[12.5px] leading-tight">
                  <b className="block truncate">{name}</b>
                  <span className="block truncate text-white/65">{ROLE_LABEL[me.role] ?? me.role}</span>
                </span>
              )}
              {compact ? (
                <button type="button" onClick={onLogout} aria-label="Cerrar sesión" title="Cerrar sesión" className="grid size-10 place-items-center rounded-[10px] text-white/80 hover:bg-white/10"><Icon name="logout" size={18} /></button>
              ) : (
                <button type="button" onClick={onLogout} className="rounded-lg border border-white/25 px-2.5 py-1.5 text-[12px] font-semibold text-white/90 hover:bg-white/10">Cerrar sesión</button>
              )}
            </div>
          </div>
        </aside>
        <div className={`min-w-0 ${scroller} ${flush ? `flex h-dvh flex-col ${bottom ? 'md:h-full' : 'lg:h-full'}` : ''}`}>
          <div className={flush ? `flex min-h-0 min-w-0 flex-1 flex-col ${bottom && reserveBottom ? 'max-md:pb-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom))]' : ''}` : `mx-auto grid ${fluid ? 'w-full p-4 sm:p-5 lg:p-6' : `${wide ? 'max-w-[1500px]' : 'max-w-[1180px]'} p-4 sm:p-5`} grid-cols-[minmax(0,1fr)] gap-4 ${bottom && reserveBottom ? 'max-md:pb-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom)+16px)]' : ''}`}>{children}</div>
        </div>
      </div>
    </div>
  );
}
