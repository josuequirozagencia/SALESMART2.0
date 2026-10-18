import { useState, type FormEvent } from 'react';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';

/** Motivo de pérdida (ADR-49 #4): mover una oportunidad a la etapa «perdida» exige explicar por qué (hasta 200 caracteres). */
export function LostReasonDialog({ name, stageName, busy, error, onConfirm, onClose }: { name: string; stageName: string; busy: boolean; error?: string | undefined; onConfirm: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string>();

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = reason.trim();
    if (r === '') return setFieldError('Escribe el motivo');
    if (r.length > 200) return setFieldError('Usa como máximo 200 caracteres');
    setFieldError(undefined);
    onConfirm(r);
  }

  return (
    <Modal title="Motivo de la pérdida" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3">
        <p className="text-[13.5px]">Vas a mover a <b>{name}</b> a «{stageName}». ¿Por qué se perdió?</p>
        <label className="grid gap-1 text-[12.5px] font-semibold">Motivo
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus aria-invalid={fieldError ? true : undefined} className="rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal aria-[invalid=true]:border-crit" placeholder="Por ejemplo: no contestó, eligió a la competencia" />
          {fieldError ? <span role="alert" className="text-[12px] font-medium text-crit">{fieldError}</span> : null}
        </label>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={busy}>Marcar como perdida</Button>
        </div>
      </form>
    </Modal>
  );
}
