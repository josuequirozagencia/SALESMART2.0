import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ContextBanner } from '../context/ContextBanner';
import { useInboxRealtime } from '../inbox/useInboxRealtime';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { TrialBanner } from '../trial/TrialBanner';
import { ROLE_LABEL } from '../../lib/format';
import type { Me, Trial } from '../../lib/types';
import { Logo } from '../../ui/AuthShell';
import { Button } from '../../ui/controls';

const tab = ({ isActive }: { isActive: boolean }): string => `-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] font-semibold ${isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`;

/**
 * Marco de una empresa cliente (la propia o una que una agencia / el Súper Admin visita): banner de contexto, cabecera, estado de la prueba y las
 * secciones de negocio. Las secciones nuevas de cada hito se añaden aquí (el menú completo sale del prototipo).
 */
export function AppShell({ me, trial, onLogout, children }: { me: Me; trial: Trial | null; onLogout: () => void; children: ReactNode }) {
  // «Configuración» solo para quien puede administrar los campos (el servidor lo dice; no se replica la matriz de permisos aquí)
  const manageFields = useCustomFields().data?.access.manage === true;
  // Conexión en vivo del Inbox: una por persona y empresa; al cambiar de empresa (agencia, soporte) se cierra y se abre la de la nueva
  useInboxRealtime(me.user.id, me.organization.id);
  // El Inbox necesita más ancho que el resto de las secciones: lista y hilo, uno al lado del otro
  const wide = useLocation().pathname.startsWith('/inbox');
  return (
    <div className="min-h-full bg-bg">
      <ContextBanner me={me} />
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
      <div className={`mx-auto grid ${wide ? 'max-w-[1500px]' : 'max-w-[1100px]'} grid-cols-[minmax(0,1fr)] gap-4 p-5`}>
        {trial ? <TrialBanner trial={trial} role={me.role} /> : null}
        <nav aria-label="Secciones" className="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-line">
          <NavLink to="/" end className={tab}>Inicio</NavLink>
          <NavLink to="/inbox" className={tab}>Inbox</NavLink>
          <NavLink to="/agenda" className={tab}>Agenda</NavLink>
          <NavLink to="/sales" className={tab}>Ventas</NavLink>
          <NavLink to="/contacts" className={tab}>Contactos</NavLink>
          <NavLink to="/companies" className={tab}>Empresas</NavLink>
          <NavLink to="/opportunities" className={tab}>Oportunidades</NavLink>
          <NavLink to="/tasks" className={tab}>Tareas</NavLink>
          <NavLink to="/analytics" className={tab}>Analítica</NavLink>
          {manageFields ? <NavLink to="/agents" className={tab}>Agentes IA</NavLink> : null}
          {manageFields ? <NavLink to="/settings/fields" className={tab}>Configuración</NavLink> : null}
        </nav>
        <main>{children}</main>
      </div>
    </div>
  );
}
