import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { sizeLabel } from './useLibrary';
import { useRequestSpace, useStorageOptions } from './useStorageSpace';

const money = (amount: string, currency: string): string => `${amount.replace(/\.00$/, '')} ${currency}`;

/**
 * «Solicitar más espacio» (V21b, ADR-75): el administrador elige un plan (o ninguno) y deja una nota; el equipo de la plataforma lo activa. Cobrar es manual: aquí solo se ve el precio de lista.
 */
export function RequestSpaceDialog({ onClose }: { onClose: () => void }) {
  const opts = useStorageOptions(true);
  const request = useRequestSpace();
  const [planId, setPlanId] = useState<string>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const plans = opts.data?.plans ?? [];
  const send = (): void => {
    setError(undefined);
    request.mutate({ ...(planId ? { plan_id: planId } : {}), ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e, 'No se pudo enviar la solicitud')) });
  };
  return (
    <Modal title="Solicitar más espacio" onClose={onClose}>
      <p className="text-[13.5px]">El equipo revisará tu solicitud, te contactará para el cobro y activará el espacio. Lo que ya subiste no se toca.</p>
      {opts.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Cargando los planes" /></div> : null}
      {opts.isError ? <Alert>{friendlyError(opts.error, 'No se pudieron cargar los planes')}</Alert> : null}
      {opts.isSuccess && plans.length === 0 ? <p className="rounded-xl bg-surface2 p-3 text-[13px] text-muted">Por ahora no hay planes publicados. Puedes dejar tu solicitud y te contactaremos.</p> : null}
      {plans.length > 0 ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[12.5px] font-semibold">Plan que te interesa</legend>
          {plans.map((p) => (
            <label key={p.id} className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border p-3 text-[13.5px] ${planId === p.id ? 'border-accent ring-2 ring-accent' : 'border-line'}`}>
              <span className="flex items-center gap-2"><input type="radio" name="storage-plan" checked={planId === p.id} onChange={() => setPlanId(p.id)} /><b>{p.name}</b> <span className="text-muted">+{sizeLabel(p.extra_bytes)}</span></span>
              <span className="font-semibold">{money(p.price_amount, p.currency)} / mes</span>
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-line p-3 text-[13.5px]"><input type="radio" name="storage-plan" checked={planId === ''} onChange={() => setPlanId('')} />Aún no sé cuál (que me contacten)</label>
        </fieldset>
      ) : null}
      <label className="grid gap-1 text-[12.5px] font-semibold">Nota (opcional)
        <textarea value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[14px] font-normal" />
      </label>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={request.isPending} onClick={send}>Enviar solicitud</Button>
      </div>
    </Modal>
  );
}
