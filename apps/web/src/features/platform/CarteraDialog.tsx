import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { ACCESS_LEVEL_LABEL, shortDate } from '../../lib/format';
import type { AccessLevel, Agency, CompanyList, CompanyState } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill, type PillKind } from '../../ui/Pill';
import { useAgencyHistory, useAssignAgency, useSetAgencyAccess } from './useAgencies';

const STATE: Record<CompanyState, [PillKind, string]> = {
  trial: ['info', 'En prueba'],
  trial_expired: ['crit', 'Prueba vencida'],
  active: ['ok', 'Activa'],
  suspended: ['warn', 'Suspendida'],
  invited: ['accent', 'Invitación pendiente'],
};

/** Todos los clientes (hasta 100) con su agencia actual: de ahí salen los de la cartera y los que se pueden agregar. */
function useClients() {
  return useQuery({ queryKey: ['platform', 'companies', 'clients-all'], queryFn: () => api<CompanyList>('/platform/companies?kind=client&limit=100') });
}

/**
 * Cartera de una agencia (ADR-22): sus clientes, agregar y quitar (solo el Súper Admin), con aviso opcional al administrador del cliente y el
 * historial de cambios. Quitar deja al cliente en administración directa; la agencia pierde el acceso al instante.
 */
export function CarteraDialog({ agency, onClose }: { agency: Agency; onClose: () => void }) {
  const clients = useClients();
  const history = useAgencyHistory(agency.id);
  const assign = useAssignAgency();
  const setAccess = useSetAgencyAccess();
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [showHistory, setShowHistory] = useState(false);

  const all = useMemo(() => clients.data?.items ?? [], [clients.data]);
  const mine = useMemo(() => all.filter((c) => c.agency?.id === agency.id), [all, agency.id]);
  const addable = useMemo(() => all.filter((c) => c.agency?.id !== agency.id), [all, agency.id]);
  const suspended = agency.state === 'suspended';

  function changeLevel(clientId: string, clientName: string, level: AccessLevel) {
    setMessage(undefined);
    setAccess.mutate(
      { id: clientId, level },
      {
        onSuccess: (r) => setMessage({ kind: 'ok', text: r.changed ? `${agency.name} ahora entra a ${clientName} con el nivel «${ACCESS_LEVEL_LABEL[level]}». Rige desde su próxima acción.` : 'Ya estaba así: no se cambió nada.' }),
        onError: (e) => setMessage({ kind: 'error', text: friendlyError(e, 'No pudimos cambiar el nivel de acceso.') }),
      },
    );
  }

  function run(clientId: string, clientName: string, agencyId: string | null) {
    setMessage(undefined);
    assign.mutate(
      { id: clientId, agencyId, reason, notifyClient: notify },
      {
        onSuccess: (r) => {
          setPick('');
          setReason('');
          const who = agencyId ? `${clientName} ahora pertenece a la cartera de ${agency.name}` : `${clientName} pasó a administración directa`;
          setMessage({ kind: 'ok', text: `${who}.${r.changed ? (r.notified > 0 ? ` Avisamos a ${r.notified} ${r.notified === 1 ? 'persona' : 'personas'} de la empresa.` : '') : ' Ya estaba así: no se cambió nada.'}` });
        },
        onError: (e) => setMessage({ kind: 'error', text: friendlyError(e, 'No pudimos cambiar la administración.') }),
      },
    );
  }

  return (
    <Modal title={`Cartera de ${agency.name}`} onClose={onClose} wide>
      {suspended ? <Alert kind="info">La agencia está suspendida: no tiene acceso a sus clientes. Reactívala para agregar más.</Alert> : null}
      {clients.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando la cartera" /></div> : null}
      {clients.isError ? <Alert>{friendlyError(clients.error, 'No pudimos cargar los clientes.')}</Alert> : null}
      {clients.isSuccess ? (
        <section aria-label="Clientes de la cartera" className="grid gap-2">
          <h3 className="text-[13px] font-semibold">Clientes ({mine.length})</h3>
          {mine.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">Esta agencia todavía no administra a ningún cliente.</p> : null}
          <ul className="grid gap-1.5" aria-label="Clientes">
            {mine.map((c) => {
              const [kind, label] = STATE[c.state];
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
                  <span className="min-w-0">
                    <b className="block truncate text-[13.5px]">{c.name}</b>
                    <span className="block truncate text-[12px] text-muted">{c.owner_email ?? 'Sin responsable'}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Pill kind={kind}>{label}</Pill>
                    <select aria-label={`Nivel de acceso de la agencia a ${c.name}`} value={c.agency_access_level ?? 'admin'} disabled={setAccess.isPending && setAccess.variables?.id === c.id} onChange={(e) => changeLevel(c.id, c.name, e.target.value as AccessLevel)} className="rounded-[10px] border border-line bg-surface px-2 py-1.5 text-[12.5px]">
                      <option value="admin">{ACCESS_LEVEL_LABEL.admin}</option>
                      <option value="advisor">{ACCESS_LEVEL_LABEL.advisor}</option>
                      <option value="read">{ACCESS_LEVEL_LABEL.read}</option>
                    </select>
                    <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Quitar a ${c.name} de la cartera`} loading={assign.isPending && assign.variables?.id === c.id} onClick={() => run(c.id, c.name, null)}>Quitar</Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {clients.isSuccess ? (
        <section aria-label="Agregar un cliente" className="grid gap-2">
          <h3 className="text-[13px] font-semibold">Agregar un cliente</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-[220px] flex-1 gap-1 text-[12px] font-semibold">Cliente
              <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={suspended} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal">
                <option value="">Elige una empresa…</option>
                {addable.map((c) => <option key={c.id} value={c.id}>{c.name}{c.agency ? ` (hoy: ${c.agency.name})` : ' (administración directa)'}</option>)}
              </select>
            </label>
            <Button variant="primary" disabled={!pick || suspended} loading={assign.isPending && assign.variables?.id === pick} onClick={() => { const c = addable.find((x) => x.id === pick); if (c) run(c.id, c.name, agency.id); }}>Agregar a la cartera</Button>
          </div>
          <Field label="Motivo (opcional)" hint="Queda en el historial. Se aplica al próximo cambio.">
            {(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-[3px]" />
            <span>Avisar por correo al administrador de la empresa</span>
          </label>
        </section>
      ) : null}
      {message ? <Alert kind={message.kind === 'ok' ? 'ok' : 'error'}>{message.text}</Alert> : null}

      <section aria-label="Historial de la cartera" className="grid gap-2">
        <button type="button" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory} className="text-left text-[13px] font-semibold text-accent hover:underline">{showHistory ? 'Ocultar historial' : 'Ver historial'}</button>
        {showHistory ? (
          history.isPending ? <Spinner label="Cargando el historial" /> :
          history.isError ? <Alert>{friendlyError(history.error, 'No pudimos cargar el historial.')}</Alert> :
          history.data.items.length === 0 ? <p className="text-[13px] text-muted">Todavía no hay cambios en esta cartera.</p> : (
            <ul className="grid gap-1.5 text-[12.5px]" aria-label="Cambios">
              {history.data.items.map((h) => (
                <li key={h.id} className="rounded-xl border border-line px-3 py-2">
                  <b>{h.organization.name}</b>: {h.from ? h.from.name : 'administración directa'} → {h.to ? h.to.name : 'administración directa'}
                  <span className="block text-muted">{shortDate(h.changed_at)} · {h.changed_by ?? 'Sistema'}{h.reason ? ` · ${h.reason}` : ''}{h.notify_client ? '' : ' · sin aviso al cliente'}</span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
      <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
