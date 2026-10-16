import type { ReactNode } from 'react';
import { ContextBanner } from '../context/ContextBanner';
import { ROLE_LABEL } from '../../lib/format';
import type { Me } from '../../lib/types';
import { Logo } from '../../ui/AuthShell';
import { Button } from '../../ui/controls';

/**
 * Marco de la agencia: su consola «Mis clientes» (F02). También la ve el Súper Admin cuando entra a una agencia en soporte (con el banner que
 * le recuerda dónde está y le permite volver).
 */
export function AgencyShell({ me, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
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
      <div className="mx-auto grid max-w-[1100px] gap-4 p-5">
        <h1 className="text-[22px] font-bold">Mis clientes</h1>
        <main>{children}</main>
      </div>
    </div>
  );
}
