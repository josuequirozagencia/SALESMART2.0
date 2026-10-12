import { useState } from 'react';
import { shortDate, timeLeft } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import type { Role, Trial } from '../../lib/types';
import { Button } from '../../ui/controls';
import { ExtensionDialog } from './ExtensionDialog';

/** Aviso de prueba gratuita (prototipo: trialBanner). Solo el administrador puede pedir la extensión. */
export function TrialBanner({ trial, role }: { trial: Trial; role: Role }) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const left = new Date(trial.ends_at).getTime() - now;
  const ext = trial.extension;
  const canAsk = ext.can_request && role === 'client_admin';
  const low = left < 2 * 86_400_000;

  return (
    <div role="region" aria-label="Prueba gratuita" className={`flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-[13px] ${low ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent'}`}>
      <span>
        <b>Prueba gratuita</b> · acceso a todo · te quedan <b>{timeLeft(left)}</b> (vence el {shortDate(trial.ends_at)})
        {ext.status === 'pending' ? ' · Tu solicitud de extensión está en revisión' : null}
        {ext.status === 'approved' ? ` · Extensión aprobada${ext.days_granted ? ` (+${ext.days_granted} días)` : ''}` : null}
        {ext.status === 'denied' ? ' · La extensión no fue aprobada' : null}
      </span>
      <span className="flex items-center gap-2">
        {canAsk ? <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setOpen(true)}>Pedir una extensión</Button> : null}
        <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" disabled title="Los planes llegan cuando se defina la pasarela de pagos">Elegir plan</Button>
      </span>
      {open ? <ExtensionDialog days={trial.extension_days} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
