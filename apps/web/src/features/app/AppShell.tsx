import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ContextBanner } from '../context/ContextBanner';
import { useInboxRealtime } from '../inbox/useInboxRealtime';
import { useInboxUnread } from '../inbox/useInbox';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { TrialBanner } from '../trial/TrialBanner';
import type { Me, Trial } from '../../lib/types';
import { SidebarShell, type NavGroup } from '../../ui/SidebarShell';

/**
 * Marco de una empresa cliente (la propia o una que una agencia / el Súper Admin visita): banner de contexto, MENÚ LATERAL con las secciones de negocio agrupadas, estado de la prueba y
 * la sección elegida. Las secciones nuevas de cada hito se añaden a los grupos de aquí.
 */
export function AppShell({ me, trial, onLogout, children }: { me: Me; trial: Trial | null; onLogout: () => void; children: ReactNode }) {
  // «Agentes IA» y «Configuración» solo para quien puede administrar los campos (el servidor lo dice; no se replica la matriz de permisos aquí)
  const admin = useCustomFields().data?.access.manage === true;
  // Conexión en vivo del Inbox: una por persona y empresa; al cambiar de empresa (agencia, soporte) se cierra y se abre la de la nueva
  useInboxRealtime(me.user.id, me.organization.id);
  // El Inbox necesita más ancho que el resto de las secciones: lista y hilo, uno al lado del otro
  const inInbox = useLocation().pathname.startsWith('/inbox');
  const unread = useInboxUnread(!inInbox);
  const groups: NavGroup[] = [
    {
      title: 'Trabajo',
      items: [
        { to: '/', label: 'Inicio', icon: 'home', end: true },
        { to: '/inbox', label: 'Inbox', icon: 'inbox', badge: unread > 0 ? { text: unread > 99 ? '99+' : String(unread) } : null },
        { to: '/agenda', label: 'Agenda', icon: 'calendar' },
        { to: '/sales', label: 'Ventas', icon: 'dollar' },
        { to: '/contacts', label: 'Contactos', icon: 'users' },
        { to: '/companies', label: 'Empresas', icon: 'building' },
        { to: '/opportunities', label: 'Oportunidades', icon: 'board' },
        { to: '/tasks', label: 'Tareas', icon: 'check' },
      ],
    },
    ...(admin ? [{ title: 'Captación', items: [{ to: '/forms', label: 'Formularios', icon: 'form' as const }] }] : []),
    ...(admin ? [{ title: 'IA y automatización', items: [{ to: '/agents', label: 'Agentes IA', icon: 'bot' as const }, { to: '/automations', label: 'Automatizaciones', icon: 'bolt' as const }] }] : []),
    {
      title: 'Gestión',
      items: [{ to: '/analytics', label: 'Analítica', icon: 'chart' }, ...(admin ? [{ to: '/settings/fields', label: 'Configuración', icon: 'gear' as const }] : [])],
    },
  ];
  return (
    <SidebarShell me={me} groups={groups} navLabel="Secciones" onLogout={onLogout} banner={<ContextBanner me={me} />} wide={inInbox}>
      {trial ? <TrialBanner trial={trial} role={me.role} /> : null}
      <main>{children}</main>
    </SidebarShell>
  );
}
