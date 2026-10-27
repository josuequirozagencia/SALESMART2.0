import type { ReactNode } from 'react';
import { ContextBanner } from '../context/ContextBanner';
import type { Me } from '../../lib/types';
import { SidebarShell, type NavGroup } from '../../ui/SidebarShell';

const GROUPS: NavGroup[] = [{ title: 'Agencia', items: [{ to: '/agency/clients', label: 'Mis clientes', icon: 'swap' }] }];

/**
 * Marco de la agencia: su consola «Mis clientes» (F02), con menú lateral. También la ve el Súper Admin cuando entra a una agencia en soporte (con el banner que
 * le recuerda dónde está y le permite volver).
 */
export function AgencyShell({ me, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
  return (
    <SidebarShell me={me} groups={GROUPS} navLabel="Secciones de la agencia" onLogout={onLogout} banner={<ContextBanner me={me} />}>
      <h1 className="text-[22px] font-bold">Mis clientes</h1>
      <main>{children}</main>
    </SidebarShell>
  );
}
