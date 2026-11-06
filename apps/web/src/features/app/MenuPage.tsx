import { Link, Navigate } from 'react-router-dom';
import { ROLE_LABEL } from '../../lib/format';
import { useBreakpoint } from '../../ui/breakpoints';
import { Avatar } from '../../ui/Avatar';
import { Icon } from '../../ui/Icon';
import { ThemeToggle } from '../../ui/ThemeToggle';
import { NotificationsBell } from '../notifications/NotificationsBell';
import { ViewAsMenu } from '../context/ViewAs';
import { useMyPhoto } from '../photos/usePhotos';
import { useAppNav } from './AppNav';

/** «Configuración» no va en la cuadrícula: se muestra aparte, al final, junto a «Cerrar sesión». */
const SETTINGS = '/settings/fields';

/**
 * Menú del móvil (`/menu`, ADR-60): página propia, no un panel. Arriba, la empresa, la persona y el tema; luego todas las secciones como cuadrícula de iconos en filas,
 * agrupadas como en la barra lateral (mismas secciones y mismos permisos: salen de la misma definición); al final, Configuración y Cerrar sesión. En tablet y escritorio
 * no existe (la barra lateral ya lo ofrece) y se vuelve al inicio.
 */
export function MenuPage() {
  const { me, groups, onLogout } = useAppNav();
  const bp = useBreakpoint();
  const myPhoto = useMyPhoto();
  if (bp !== 'mobile') return <Navigate to="/" replace />;
  const name = me.user.full_name ?? me.user.email;
  const settings = groups.flatMap((g) => g.items).find((i) => i.to === SETTINGS);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <section aria-label="Tu cuenta" className="grid grid-cols-[minmax(0,1fr)] gap-3 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <Avatar name={name} src={myPhoto.photo} size={44} tone="grad" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-bold">{me.organization.name}</h1>
            <p className="truncate text-[12.5px] text-muted">{name} · {ROLE_LABEL[me.role] ?? me.role}</p>
          </div>
          <ViewAsMenu me={me} />
          <ThemeToggle touch />
          <NotificationsBell me={me} />
        </div>
      </section>
      <nav aria-label="Todas las secciones" className="grid gap-4">
        {groups.map((g) => {
          const items = g.items.filter((i) => i.to !== SETTINGS);
          if (items.length === 0) return null;
          return (
            <section key={g.title} aria-label={g.title} className="grid gap-2">
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.title}</h2>
              <ul className="grid grid-cols-3 gap-2">
                {items.map((i) => (
                  <li key={i.to} className="min-w-0">
                    <Link to={i.to} className="relative grid h-full min-h-[92px] place-items-center content-center gap-1.5 rounded-2xl border border-line bg-surface px-1.5 py-3 text-center text-[12px] font-semibold leading-tight text-fg hover:bg-surface2 active:bg-accent-soft">
                      <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent"><Icon name={i.icon} size={22} /></span>
                      <span className="line-clamp-2 w-full break-words">{i.label}</span>
                      {i.badge ? <span aria-label={i.badge.label ?? `${i.badge.text} sin leer`} className="absolute right-2 top-2 grid min-w-5 place-items-center rounded-full bg-crit px-1.5 text-[11px] font-bold leading-5 text-white">{i.badge.text}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
      <section aria-label="Cuenta y ajustes" className="grid gap-2 border-t border-line pt-4">
        {settings ? (
          <Link to={settings.to} className="flex min-h-12 items-center gap-3 rounded-xl border border-line bg-surface px-4 text-[13px] font-semibold hover:bg-surface2">
            <Icon name={settings.icon} />
            {settings.label}
          </Link>
        ) : null}
        <button type="button" onClick={onLogout} className="flex min-h-12 items-center gap-3 rounded-xl border border-line bg-surface px-4 text-left text-[13px] font-semibold text-crit hover:bg-crit-soft">
          <Icon name="logout" />
          Cerrar sesión
        </button>
      </section>
    </div>
  );
}
