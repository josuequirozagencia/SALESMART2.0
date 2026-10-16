import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ROLE_LABEL } from '../../lib/format';
import type { Me } from '../../lib/types';
import { Logo } from '../../ui/AuthShell';
import { Button } from '../../ui/controls';
import { usePendingBadge } from './usePlatformTrials';

const tab = ({ isActive }: { isActive: boolean }): string => `-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] font-semibold ${isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`;

/**
 * Marco de la consola de plataforma (Súper Admin). Pestañas: Empresas, Agencias, Planes, Accesos y Pruebas; los proveedores
 * llegan con M2 y se suman a esta navegación.
 */
export function PlatformShell({ me, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
  const pending = usePendingBadge();
  const n = pending.data ?? 0;
  return (
    <div className="min-h-full bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
        <span className="text-fg [&_i]:text-[color:var(--on-grad)]"><Logo /></span>
        <div className="flex items-center gap-3 text-[13px]">
          <span className="hidden text-right min-[560px]:block">
            <b className="block">{me.organization.name}</b>
            <span className="text-muted">{me.user.full_name ?? me.user.email} · {ROLE_LABEL[me.role] ?? me.role}</span>
          </span>
          <Button onClick={onLogout}>Cerrar sesión</Button>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1100px] gap-4 p-5">
        <h1 className="text-[22px] font-bold">Consola de plataforma</h1>
        <nav aria-label="Secciones de la consola" className="flex gap-1 border-b border-line">
          <NavLink to="/platform/companies" className={tab}>Empresas</NavLink>
          <NavLink to="/platform/agencies" className={tab}>Agencias</NavLink>
          <NavLink to="/platform/plans" className={tab}>Planes</NavLink>
          <NavLink to="/platform/access" className={tab}>Accesos</NavLink>
          <NavLink to="/platform/trials" className={tab}>
            Pruebas
            {n > 0 ? <span aria-label={`${n} solicitudes pendientes`} className="grid min-w-5 place-items-center rounded-full bg-crit px-1.5 text-[11px] font-bold leading-5 text-white">{n}</span> : null}
          </NavLink>
        </nav>
        <main>{children}</main>
      </div>
    </div>
  );
}
