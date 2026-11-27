import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Alert, Button, Field, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useInboxOptions, useSetQueue } from './useInbox';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';

export const queueActionLabel = (c: Pick<Conversation, 'queue'>): string => (c.queue ? 'Cambiar departamento' : 'Asignar departamento');

/** Elegir el departamento de una conversación (V24). El botón «Guardar» es la confirmación: antes se explica qué cambia y qué no. Si quien la tiene no está en él, se avisa. */
export function QueueAssignForm({ c, onDone, onCancel }: { c: Conversation; onDone: () => void; onCancel: () => void }) {
  const options = useInboxOptions();
  const save = useSetQueue(c.id);
  const [queueId, setQueueId] = useState(c.queue?.id ?? '');
  const [error, setError] = useState<string>();
  const [outside, setOutside] = useState(false);
  const queues = options.data?.queues ?? [];

  if (outside) {
    return (
      <div className="grid gap-3">
        <Alert kind="ok">Departamento guardado. Quien tiene la conversación no pertenece a ese departamento: sigue siendo suya. Si debe atenderla otra persona, transfiérela.</Alert>
        <div className="flex justify-end"><Button variant="primary" onClick={onDone}>Entendido</Button></div>
      </div>
    );
  }
  const submit = (): void => {
    setError(undefined);
    if (!queueId) return setError('Elige un departamento');
    save.mutate(queueId, {
      onSuccess: (r) => (r.warning === 'OWNER_NOT_IN_QUEUE' ? setOutside(true) : onDone()),
      onError: (e) => setError(friendlyError(e, 'No pudimos guardar el departamento.')),
    });
  };
  return (
    <div className="grid gap-3">
      {options.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Cargando los departamentos" /></div> : null}
      {options.isError ? <Alert>{friendlyError(options.error, 'No pudimos cargar los departamentos.')}</Alert> : null}
      {options.data && queues.length === 0 ? <Alert>Aún no hay departamentos. Créalos en Equipo › Departamentos.</Alert> : null}
      {queues.length > 0 ? (
        <Field label="Departamento">
          {(f) => (
            <select {...f} value={queueId} onChange={(e) => setQueueId(e.target.value)} className={selectCls}>
              <option value="">Elige uno…</option>
              {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          )}
        </Field>
      ) : null}
      <p className="text-[12.5px] text-muted">Desde ahora la conversación usa el catálogo, el horario, los tiempos de respuesta y el cierre automático de ese departamento. No se reparte, no cambia quién la tiene y las ventas ya registradas no se modifican.</p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancelar</Button>
        <Button variant="primary" loading={save.isPending} disabled={queues.length === 0 || (queueId !== '' && queueId === c.queue?.id)} onClick={submit}>Guardar</Button>
      </div>
    </div>
  );
}

export function QueueAssignDialog({ c, onClose }: { c: Conversation; onClose: () => void }) {
  return (
    <Modal title={queueActionLabel(c)} onClose={onClose}>
      <QueueAssignForm c={c} onDone={onClose} onCancel={onClose} />
    </Modal>
  );
}

/** Aviso del panel del contacto cuando la conversación no tiene departamento. */
export function NoQueueNotice({ c }: { c: Conversation }) {
  const [open, setOpen] = useState(false);
  if (c.queue !== null || c.status === 'closed') return null;
  return (
    <div role="note" className="grid gap-2 border-b border-line bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
      <p>Esta conversación no tiene departamento: si su conexión tampoco tiene uno, no se pueden registrar ventas.{c.can.set_queue ? '' : ' Pídele a un administrador que le asigne uno.'}</p>
      {c.can.set_queue ? <div><Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setOpen(true)}>Asignar departamento</Button></div> : null}
      {open ? <QueueAssignDialog c={c} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
