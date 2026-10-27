import type { ReactNode } from 'react';
import type { Me } from '../../lib/types';
import { SidebarShell, type NavGroup } from '../../ui/SidebarShell';
import { usePendingBadge } from './usePlatformTrials';

/**
 * Marco de la consola de plataforma (Súper Admin), con menú lateral. Secciones: Empresas, Agencias, Planes, Proveedores, Créditos IA, Accesos y Pruebas.
 */
export function PlatformShell({ me, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
  const pending = usePendingBadge();
  const n = pending.data ?? 0;
  const groups: NavGroup[] = [
    {
      title: 'Plataforma',
      items: [
        { to: '/platform/companies', label: 'Empresas', icon: 'building' },
        { to: '/platform/agencies', label: 'Agencias', icon: 'swap' },
        { to: '/platform/plans', label: 'Planes', icon: 'card' },
        { to: '/platform/providers', label: 'Proveedores', icon: 'plug' },
        { to: '/platform/ai', label: 'Créditos IA', icon: 'bolt' },
        { to: '/platform/access', label: 'Accesos', icon: 'shield' },
        { to: '/platform/trials', label: 'Pruebas', icon: 'clock', badge: n > 0 ? { text: String(n), label: `${n} solicitudes pendientes` } : null },
      ],
    },
  ];
  return (
    <SidebarShell me={me} groups={groups} navLabel="Secciones de la consola" onLogout={onLogout}>
      <h1 className="text-[22px] font-bold">Consola de plataforma</h1>
      <main>{children}</main>
    </SidebarShell>
  );
}
