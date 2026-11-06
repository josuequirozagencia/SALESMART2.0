import type { NavGroup } from '../../ui/SidebarShell';

/** ¿La ruta es una conversación individual del Inbox (`/inbox/:id`)? `/inbox` y `/inbox/scheduled` son listas. */
/** El Inbox propiamente dicho (lista o conversación abierta), no «Programados»: ocupa toda la altura de la ventana (v5). */
export function isInboxMain(pathname: string): boolean {
  return /^\/inbox(\/(?!scheduled(\/|$))[^/]+)?\/?$/.test(pathname);
}

export function isChatPath(pathname: string): boolean {
  return /^\/inbox\/(?!scheduled(\/|$))[^/]+/.test(pathname);
}

/**
 * Las secciones de la empresa: la ÚNICA definición (ADR-60). La barra lateral, la barra inferior móvil y la página `/menu` salen de aquí, así que no pueden
 * contradecirse. Las secciones nuevas de cada hito se añaden aquí. «Agentes IA», «Configuración» y el resto de lo administrativo solo para quien puede administrar
 * los campos (el servidor lo dice; no se replica la matriz de permisos).
 */
export function buildNavGroups({ admin, unread }: { admin: boolean; unread: number }): NavGroup[] {
  return [
    {
      title: 'Trabajo',
      items: [
        { to: '/', label: 'Inicio', icon: 'home', end: true },
        { to: '/inbox', label: 'Inbox', icon: 'inbox', badge: unread > 0 ? { text: unread > 99 ? '99+' : String(unread) } : null },
        { to: '/agenda', label: 'Agenda', icon: 'calendar' },
        { to: '/sales', label: 'Ventas', icon: 'dollar' },
        { to: '/contacts', label: 'Contactos', icon: 'users' },
        { to: '/opportunities', label: 'Oportunidades', icon: 'board' },
        { to: '/tasks', label: 'Tareas', icon: 'check' },
      ],
    },
    ...(admin ? [{ title: 'Captación', items: [{ to: '/forms', label: 'Formularios', icon: 'form' as const }] }] : []),
    ...(admin ? [{ title: 'IA y automatización', items: [{ to: '/agents', label: 'Agentes IA', icon: 'bot' as const }, { to: '/automations', label: 'Automatizaciones', icon: 'bolt' as const }] }] : []),
    ...(admin ? [{ title: 'Equipo', items: [{ to: '/users', label: 'Usuarios', icon: 'shield' as const }, { to: '/departments', label: 'Departamentos', icon: 'team' as const }] }] : []),
    {
      title: 'Gestión',
      items: [{ to: '/analytics', label: 'Analítica', icon: 'chart' }, ...(admin ? [{ to: '/settings/fields', label: 'Configuración', icon: 'gear' as const }] : [])],
    },
  ];
}
