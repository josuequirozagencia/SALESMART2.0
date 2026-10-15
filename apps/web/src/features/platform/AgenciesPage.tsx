import { useEffect, useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDate } from '../../lib/format';
import type { Agency, AgencyState, InvitationIssued } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill, type PillKind } from '../../ui/Pill';
import { CarteraDialog } from './CarteraDialog';
import { InviteResult } from './InviteResult';
import { NewCompanyDialog } from './NewCompanyDialog';
import { NO_AGENCY_FILTERS, useAgencies, useSetAgencySuspended, type AgencyFilters } from './useAgencies';
import { useResendInvitation } from './useCompanies';

const STATE: Record<AgencyState, [PillKind, string]> = {
  active: ['ok', 'Activa'],
  suspended: ['warn', 'Suspendida'],
  invited: ['accent', 'Invitación pendiente'],
};
const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';

function Row({ a, onCartera, onToggle, onResend, busy }: { a: Agency; onCartera: (a: Agency) => void; onToggle: (a: Agency) => void; onResend: (a: Agency) => void; busy: boolean }) {
  const [kind, label] = STATE[a.state];
  return (
    <li className="grid gap-3 rounded-2xl border border-line bg-surface p-4 min-[900px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_90px_auto] min-[900px]:items-center">
      <div className="min-w-0">
        <b className="block truncate text-[14px]">{a.name}</b>
        <span className="block truncate text-[12px] text-muted">{a.owner_email ?? 'Sin responsable'} · creada el {shortDate(a.created_at)}</span>
      </div>
      <div className="grid justify-items-start gap-1 text-[12.5px]">
        <Pill kind={kind}>{label}</Pill>
        {a.invitation ? <span className="text-muted">{a.invitation.expired ? 'La invitación venció' : 'La invitación vence'} el {shortDate(a.invitation.expires_at)}</span> : null}
      </div>
      <div className="font-mono text-[13px]" aria-label={`${a.clients} clientes`}>{a.clients} <span className="font-sans text-[11.5px] text-muted">{a.clients === 1 ? 'cliente' : 'clientes'}</span></div>
      <div className="flex flex-wrap gap-2">
        <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Cartera de ${a.name}`} onClick={() => onCartera(a)}>Cartera</Button>
        {a.state === 'invited' ? <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Reenviar la invitación de ${a.name}`} loading={busy} onClick={() => onResend(a)}>Reenviar invitación</Button> : null}
        {a.state !== 'invited' ? <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`${a.state === 'suspended' ? 'Reactivar' : 'Suspender'} a ${a.name}`} onClick={() => onToggle(a)}>{a.state === 'suspended' ? 'Reactivar' : 'Suspender'}</Button> : null}
      </div>
    </li>
  );
}

/** Pestaña «Agencias»: alta con invitación, estado, cartera (clientes, agregar y quitar, historial) y suspensión. Solo el Súper Admin (ADR-22, ADR-40). */
export function AgenciesPage() {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<AgencyFilters>(NO_AGENCY_FILTERS);
  const [creating, setCreating] = useState(false);
  const [cartera, setCartera] = useState<Agency | null>(null);
  const [toggle, setToggle] = useState<Agency | null>(null);
  const [toggleError, setToggleError] = useState<string>();
  const [resent, setResent] = useState<{ name: string; invitation: InvitationIssued }>();
  const [resendError, setResendError] = useState<string>();
  const setSuspended = useSetAgencySuspended();
  const resend = useResendInvitation();

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = useAgencies(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const filtered = Boolean(filters.q || filters.state);
  // La cartera abierta se mantiene al día con la lista (p. ej. tras suspender)
  const carteraNow = cartera ? (items.find((a) => a.id === cartera.id) ?? cartera) : null;

  function confirmToggle() {
    if (!toggle) return;
    setToggleError(undefined);
    setSuspended.mutate({ id: toggle.id, suspended: toggle.state !== 'suspended' }, { onSuccess: () => setToggle(null), onError: (e) => setToggleError(friendlyError(e, 'No pudimos cambiar el estado de la agencia.')) });
  }
  function resendInvitation(a: Agency) {
    setResendError(undefined);
    resend.mutate(a.id, { onSuccess: (invitation) => setResent({ name: a.name, invitation }), onError: (e) => setResendError(friendlyError(e, 'No pudimos reenviar la invitación.')) });
  }

  return (
    <div className="grid gap-4">
      <div className="flex justify-end"><Button variant="primary" onClick={() => setCreating(true)}>Nueva agencia</Button></div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Agencia o correo" className={`${selectCls} font-normal`} />
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Estado
          <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as AgencyFilters['state'] }))} className={`${selectCls} font-normal`}>
            <option value="">Todos</option><option value="active">Activa</option><option value="suspended">Suspendida</option><option value="invited">Invitación pendiente</option>
          </select>
        </label>
        {filtered ? <Button variant="link" onClick={() => { setText(''); setFilters(NO_AGENCY_FILTERS); }}>Limpiar filtros</Button> : null}
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando agencias" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las agencias.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {resendError ? <Alert>{resendError}</Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">{filtered ? 'Ninguna agencia coincide con los filtros.' : 'Todavía no hay agencias. Crea la primera con «Nueva agencia».'}</p>
      ) : null}
      {items.length > 0 ? <ul className="grid gap-3" aria-label="Agencias">{items.map((a) => <Row key={a.id} a={a} onCartera={setCartera} onToggle={(x) => { setToggleError(undefined); setToggle(x); }} onResend={resendInvitation} busy={resend.isPending && resend.variables === a.id} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}

      {creating ? <NewCompanyDialog kind="agency" plans={[]} onClose={() => setCreating(false)} /> : null}
      {carteraNow ? <CarteraDialog agency={carteraNow} onClose={() => setCartera(null)} /> : null}
      {toggle ? (
        <Modal title={toggle.state === 'suspended' ? `Reactivar a ${toggle.name}` : `Suspender a ${toggle.name}`} onClose={() => setToggle(null)}>
          <p className="text-[13.5px]">
            {toggle.state === 'suspended'
              ? `Sus personas volverán a poder entrar y recuperarán el acceso a sus ${toggle.clients} ${toggle.clients === 1 ? 'cliente' : 'clientes'}.`
              : `Sus personas perderán el acceso al instante a sus ${toggle.clients} ${toggle.clients === 1 ? 'cliente' : 'clientes'} y no podrán entrar. Los clientes siguen funcionando con normalidad y la cartera se conserva.`}
          </p>
          {toggleError ? <Alert>{toggleError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setToggle(null)}>Cancelar</Button>
            <Button variant="primary" loading={setSuspended.isPending} onClick={confirmToggle}>{toggle.state === 'suspended' ? 'Reactivar' : 'Suspender'}</Button>
          </div>
        </Modal>
      ) : null}
      {resent ? (
        <Modal title={`Invitación de ${resent.name}`} onClose={() => setResent(undefined)}>
          <InviteResult invitation={resent.invitation} />
          <div className="flex justify-end"><Button variant="primary" onClick={() => setResent(undefined)}>Listo</Button></div>
        </Modal>
      ) : null}
    </div>
  );
}
