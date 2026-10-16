import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { ACCESS_LEVEL_LABEL, shortDate } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Company, CompanyState, InvitationIssued } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill, type PillKind } from '../../ui/Pill';
import { InviteResult } from '../platform/InviteResult';
import { NewCompanyDialog } from '../platform/NewCompanyDialog';
import { NO_CLIENT_FILTERS, useAgencyClients, useResendClientInvitation, type ClientFilters } from './useAgencyClients';

const STATE: Record<CompanyState, [PillKind, string]> = {
  trial: ['info', 'En prueba'],
  trial_expired: ['crit', 'Prueba vencida'],
  active: ['ok', 'Activa'],
  suspended: ['warn', 'Suspendida'],
  invited: ['accent', 'Invitación pendiente'],
};

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';

function Row({ c, onEnter, onResend, entering, resending }: { c: Company; onEnter: (c: Company) => void; onResend: (c: Company) => void; entering: boolean; resending: boolean }) {
  const [kind, label] = STATE[c.state];
  return (
    <li className="grid gap-3 rounded-2xl border border-line bg-surface p-4 min-[900px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_150px_auto] min-[900px]:items-center">
      <div className="min-w-0">
        <b className="block truncate text-[14px]">{c.name}</b>
        <span className="block truncate text-[12px] text-muted">{c.owner_email ?? 'Sin responsable'} · registrada el {shortDate(c.created_at)}</span>
      </div>
      <div className="grid justify-items-start gap-1 text-[12.5px]">
        <Pill kind={kind}>{label}</Pill>
        {c.trial_ends_at ? <span className="text-muted">{c.state === 'trial_expired' ? 'Venció' : 'Vence'} el {shortDate(c.trial_ends_at)}</span> : null}
        {c.invitation ? <span className="text-muted">{c.invitation.expired ? 'La invitación venció' : 'La invitación vence'} el {shortDate(c.invitation.expires_at)}</span> : null}
      </div>
      <div className="grid gap-1 text-[13px]">
        {c.plan ? <b>{c.plan.name}</b> : <span className="text-muted">Sin plan</span>}
        {c.agency_access_level ? <span className="text-[12px] text-muted">Tu acceso: {ACCESS_LEVEL_LABEL[c.agency_access_level]}</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {c.state !== 'suspended' ? <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Entrar a ${c.name}`} loading={entering} onClick={() => onEnter(c)}>Entrar</Button> : null}
        {c.state === 'invited' ? <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Reenviar la invitación de ${c.name}`} loading={resending} onClick={() => onResend(c)}>Reenviar invitación</Button> : null}
      </div>
    </li>
  );
}

/**
 * «Mis clientes» (F02): la cartera de la agencia. Buscar, ver el estado de cada cliente, «Registrar cliente» (crea la empresa y manda la invitación a su
 * dueño) y «Entrar» (cambia de contexto sin cerrar sesión). El servidor acota la lista a la agencia de la sesión; aquí no se envía ningún identificador.
 */
export function ClientsPage() {
  const { switchContext } = useSession();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<ClientFilters>(NO_CLIENT_FILTERS);
  const [registering, setRegistering] = useState(false);
  const [entering, setEntering] = useState<string>();
  const [error, setError] = useState<string>();
  const [resent, setResent] = useState<{ company: string; invitation: InvitationIssued }>();
  const resend = useResendClientInvitation();
  const q = useAgencyClients(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const filtered = Boolean(filters.q || filters.state);

  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  async function enter(c: Company) {
    setError(undefined);
    setEntering(c.id);
    try {
      await switchContext(c.id);
      navigate('/');
    } catch (e) {
      setError(friendlyError(e, 'Ya no tienes acceso a ese cliente. Actualizamos la lista.'));
      void q.refetch();
      setEntering(undefined);
    }
  }

  function resendInvitation(c: Company) {
    setError(undefined);
    resend.mutate(c.id, { onSuccess: (invitation) => setResent({ company: c.name, invitation }), onError: (e) => setError(friendlyError(e, 'No pudimos reenviar la invitación.')) });
  }

  return (
    <div className="grid gap-4">
      <div className="flex justify-end"><Button variant="primary" onClick={() => setRegistering(true)}>Registrar cliente</Button></div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Cliente o correo" className={`${selectCls} font-normal`} />
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Estado
          <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as ClientFilters['state'] }))} className={`${selectCls} font-normal`}>
            <option value="">Todos</option><option value="trial">En prueba</option><option value="trial_expired">Prueba vencida</option><option value="active">Activa</option><option value="suspended">Suspendida</option><option value="invited">Invitación pendiente</option>
          </select>
        </label>
        {filtered ? <Button variant="link" onClick={() => { setText(''); setFilters(NO_CLIENT_FILTERS); }}>Limpiar filtros</Button> : null}
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando clientes" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar tus clientes.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">{filtered ? 'Ningún cliente coincide con los filtros.' : 'Todavía no tienes clientes. Registra el primero con «Registrar cliente».'}</p>
      ) : null}
      {items.length > 0 ? <ul className="grid gap-3" aria-label="Clientes">{items.map((c) => <Row key={c.id} c={c} onEnter={(x) => void enter(x)} onResend={resendInvitation} entering={entering === c.id} resending={resend.isPending && resend.variables === c.id} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}

      {error ? <Alert>{error}</Alert> : null}
      {registering ? <NewCompanyDialog plans={[]} viaAgency onClose={() => setRegistering(false)} /> : null}
      {resent ? (
        <Modal title={`Invitación de ${resent.company}`} onClose={() => setResent(undefined)}>
          <InviteResult invitation={resent.invitation} />
          <div className="flex justify-end"><Button variant="primary" onClick={() => setResent(undefined)}>Listo</Button></div>
        </Modal>
      ) : null}
    </div>
  );
}
