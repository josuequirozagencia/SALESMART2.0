import { useState } from 'react';
import type { Role, Trial } from '../../lib/types';
import { Button, LockIcon } from '../../ui/controls';
import { ExtensionDialog } from './ExtensionDialog';

/** Pantalla de «prueba vencida» (ADR-23 #5): cuenta en pausa, datos retenidos; se puede pedir la extensión única si no se usó. */
export function TrialExpiredScreen({ trial, role, onLogout }: { trial: Trial; role: Role; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ext = trial.extension;
  const canAsk = ext.can_request && role === 'client_admin';

  return (
    <div className="grid min-h-full place-items-center bg-bg p-4">
      <section aria-labelledby="exp-title" className="grid w-[min(520px,100%)] justify-items-center gap-3.5 rounded-[20px] border border-line bg-surface p-[30px] text-center shadow-[var(--shadow)]">
        <div className="grid size-14 place-items-center rounded-full bg-warn-soft text-warn"><LockIcon /></div>
        <h1 id="exp-title" className="text-[22px] font-bold">Tu prueba gratuita terminó</h1>
        <p className="text-[13.5px] text-muted">
          Tus datos están a salvo: los conservamos {trial.retention_days} días para que puedas continuar con un plan. Mientras tanto la cuenta está en pausa.
        </p>
        {ext.status === 'pending' ? (
          <p role="status" className="w-full rounded-xl border border-dashed border-line p-3 text-[12.5px] text-muted">
            Tu solicitud de {trial.extension_days} días más está en revisión. Cuando el equipo la responda, vuelve a iniciar sesión para continuar.
          </p>
        ) : null}
        {ext.status === 'denied' ? (
          <p role="status" className="w-full rounded-xl border border-dashed border-line p-3 text-[12.5px] text-muted">La extensión no fue aprobada. Puedes continuar eligiendo un plan.</p>
        ) : null}
        {ext.can_request && role !== 'client_admin' ? (
          <p className="w-full rounded-xl border border-dashed border-line p-3 text-[12.5px] text-muted">Pide al administrador de tu cuenta que solicite más tiempo o elija un plan.</p>
        ) : null}
        <Button variant="primary" block disabled title="Los planes llegan cuando se defina la pasarela de pagos">Elegir un plan</Button>
        {canAsk ? <Button block onClick={() => setOpen(true)}>Pedir {trial.extension_days} días más</Button> : null}
        <Button variant="link" onClick={onLogout}>Cerrar sesión</Button>
      </section>
      {open ? <ExtensionDialog days={trial.extension_days} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
