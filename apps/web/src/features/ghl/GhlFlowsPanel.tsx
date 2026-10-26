import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useEnrollGhl, useGhlEnrollments, useGhlWorkflows, type GhlEnrollment } from './useGhl';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const when = (iso: string): string => new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

function HistoryRow({ e }: { e: GhlEnrollment }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-[13px]">
      <span className="font-semibold">{e.workflow.name}</span>
      <span className={e.status === 'done' ? 'text-ok' : 'text-crit'}>{e.status === 'done' ? 'Inscrito' : 'No se pudo inscribir'}</span>
      <span className="text-muted">{when(e.created_at)}{e.by ? ` · ${e.by.name}` : ''}</span>
      {e.error ? <span className="basis-full text-[12.5px] text-muted">{e.error}</span> : null}
    </li>
  );
}

/**
 * «Inscribir en un flujo» de GoHighLevel (M7.5, ADR-52): elige un flujo publicado de la Location y lo inscribe al contacto. El resultado se ve al instante y queda en el historial.
 * Solo presentación: el servidor valida el permiso, que el contacto sea visible para la persona y que el flujo exista y esté publicado.
 */
export function GhlFlowsPanel({ contactId, canWrite = true }: { contactId: string; canWrite?: boolean }) {
  const { query, refresh } = useGhlWorkflows(canWrite);
  const history = useGhlEnrollments(contactId);
  const enroll = useEnrollGhl(contactId);
  const [workflowId, setWorkflowId] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<GhlEnrollment>();

  const options = (query.data?.items ?? []).filter((w) => w.enrollable);
  const run = (): void => {
    setError(undefined);
    setDone(undefined);
    enroll.mutate(workflowId, { onSuccess: (r) => setDone(r), onError: (e) => setError(friendlyError(e, 'No pudimos inscribir al contacto.')) });
  };
  const update = async (): Promise<void> => {
    setRefreshing(true);
    setError(undefined);
    try {
      await refresh();
    } catch (e) {
      setError(friendlyError(e, 'No pudimos actualizar la lista de flujos.'));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section aria-label="Flujos de GoHighLevel" className="grid gap-3">
      {canWrite ? (
        <>
          {query.isLoading ? <Spinner label="Cargando flujos" /> : null}
          {query.isError ? <Alert>{friendlyError(query.error, 'No pudimos traer los flujos de GoHighLevel.')}</Alert> : null}
          {query.data ? (
            options.length === 0 ? (
              <Alert kind="info">GoHighLevel no tiene flujos publicados en esta cuenta.</Alert>
            ) : (
              <div className="grid gap-2">
                <label className="grid gap-1 text-[13px] font-semibold">
                  Flujo
                  <select className={selectCls} value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); setDone(undefined); }}>
                    <option value="">Elige un flujo…</option>
                    {options.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={workflowId === ''} loading={enroll.isPending} onClick={run}>Inscribir en el flujo</Button>
                  <Button loading={refreshing} onClick={() => void update()}>Actualizar lista</Button>
                </div>
              </div>
            )
          ) : null}
          {done ? <Alert kind={done.status === 'done' ? 'ok' : 'error'}>{done.status === 'done' ? `Inscrito en «${done.workflow.name}».` : `GoHighLevel no lo inscribió en «${done.workflow.name}»: ${done.error ?? 'sin detalle'}`}</Alert> : null}
          {error ? <Alert>{error}</Alert> : null}
        </>
      ) : (
        <Alert kind="info">Con tu acceso actual no puedes inscribir contactos en flujos.</Alert>
      )}
      <div>
        <h3 className="text-[13px] font-semibold text-muted">Últimas inscripciones</h3>
        {history.isLoading ? <Spinner label="Cargando historial" /> : null}
        {history.data && history.data.items.length === 0 ? <p className="py-2 text-[13px] text-muted">Aún no se ha inscrito en ningún flujo.</p> : null}
        {history.data && history.data.items.length > 0 ? <ul className="divide-y divide-line">{history.data.items.map((e) => <HistoryRow key={e.id} e={e} />)}</ul> : null}
      </div>
    </section>
  );
}

export function GhlFlowsDialog({ contact, onClose }: { contact: { id: string; name: string }; onClose: () => void }) {
  return (
    <Modal title={`Inscribir a ${contact.name} en un flujo`} onClose={onClose}>
      <GhlFlowsPanel contactId={contact.id} />
      <div className="mt-3 flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
