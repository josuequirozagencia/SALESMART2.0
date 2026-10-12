import { useEffect, useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDate } from '../../lib/format';
import type { PlatformTrialItem } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { useDecideExtension } from './usePlatformTrials';

export type Decision = { item: PlatformTrialItem; action: 'approve' | 'deny' };

/** Confirmación de aprobar o rechazar una extensión. Explica el efecto exacto antes de decidir (no se puede deshacer). */
export function DecisionDialog({ decision, extensionDays, now, onClose }: { decision: Decision; extensionDays: number; now: number; onClose: () => void }) {
  const { item, action } = decision;
  const [error, setError] = useState<string>();
  const decide = useDecideExtension();
  const cancel = useRef<HTMLButtonElement>(null);
  const expired = item.status === 'expired' || new Date(item.ends_at).getTime() <= now;
  const approve = action === 'approve';

  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function confirm() {
    setError(undefined);
    decide.mutate({ id: item.id, action }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e)) });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="dec-title" className="grid w-[min(480px,100%)] gap-3 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow)]">
        <h2 id="dec-title" className="text-[18px] font-bold">{approve ? 'Aprobar extensión' : 'Rechazar extensión'}</h2>
        <p className="text-[13.5px]"><b>{item.organization_name}</b> · {item.owner_name ?? item.owner_email}</p>
        {item.extension.reason ? <blockquote className="rounded-xl bg-surface2 px-3 py-2.5 text-[13px] text-muted">«{item.extension.reason}»</blockquote> : null}
        <p className="text-[13px] text-muted">
          {approve
            ? expired
              ? `La prueba ya venció: los ${extensionDays} días cuentan desde hoy y la cuenta se reactiva.`
              : `Se suman ${extensionDays} días al final de la prueba (hoy vence el ${shortDate(item.ends_at)}).`
            : 'La prueba no cambia. La cuenta no podrá volver a pedir una extensión.'}
          {' '}Esta decisión no se puede deshacer.
        </p>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button ref={cancel} onClick={onClose}>Cancelar</Button>
          <Button variant={approve ? 'primary' : 'danger'} loading={decide.isPending} onClick={confirm}>{approve ? 'Aprobar' : 'Rechazar'}</Button>
        </div>
      </div>
    </div>
  );
}
