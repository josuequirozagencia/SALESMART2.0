import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { shortDate } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Company, CompanyState, InvitationIssued } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill, type PillKind } from '../../ui/Pill';
import { AssignPlanDialog } from './AssignPlanDialog';
import { ChangeAgencyDialog } from './ChangeAgencyDialog';
import { InviteResult } from './InviteResult';
import { NewCompanyDialog } from './NewCompanyDialog';
import { useAgencyOptions } from './useAgencies';
import { NO_FILTERS, useCompanies, useResendInvitation, type CompanyFilters } from './useCompanies';
import { usePlans } from './usePlans';

const STATE: Record<CompanyState, [PillKind, string]> = {
  trial: ['info', 'En prueba'],
  trial_expired: ['crit', 'Prueba vencida'],
  active: ['ok', 'Activa'],
  suspended: ['warn', 'Suspendida'],
  invited: ['accent', 'Invitación pendiente'],
};

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';

function Row({ c, onPlan, onAgency, onResend, onEnter, resending, entering }: { c: Company; onPlan: (c: Company) => void; onAgency: (c: Company) => void; onResend: (c: Company) => void; onEnter: (c: Company) => void; resending: boolean; entering: boolean }) {
  const [kind, label] = STATE[c.state];
  return (
    <li className="grid gap-3 rounded-2xl border border-line bg-surface p-4 min-[900px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_150px_80px_auto] min-[900px]:items-center">
      <div className="min-w-0">
        <b className="block truncate text-[14px]">{c.name} {c.kind === 'agency' ? <Pill kind="accent">Agencia</Pill> : null}</b>
        <span className="block truncate text-[12px] text-muted">{c.owner_email ?? 'Sin responsable'} · creada el {shortDate(c.created_at)}</span>
        {c.kind === 'client' ? <span className="block truncate text-[12px] text-muted">{c.agency ? `Administrada por ${c.agency.name}` : 'Administración directa'}</span> : null}
      </div>
      <div className="grid justify-items-start gap-1 text-[12.5px]">
        <Pill kind={kind}>{label}</Pill>
        {c.trial_ends_at ? <span className="text-muted">{c.state === 'trial_expired' ? 'Venció' : 'Vence'} el {shortDate(c.trial_ends_at)}</span> : null}
        {c.invitation ? <span className="text-muted">{c.invitation.expired ? 'La invitación venció' : 'La invitación vence'} el {shortDate(c.invitation.expires_at)}</span> : null}
      </div>
      <div className="text-[13px]">{c.plan ? <b>{c.plan.name}</b> : <span className="text-muted">Sin plan</span>}</div>
      <div className="font-mono text-[13px]" aria-label={`${c.users} usuarios`}>{c.users} <span className="font-sans text-[11.5px] text-muted">usuarios</span></div>
      <div className="flex flex-wrap gap-2">
        {c.state !== 'suspended' ? <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Entrar a ${c.name} (soporte)`} loading={entering} onClick={() => onEnter(c)}>Entrar</Button> : null}
        <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Cambiar el plan de ${c.name}`} onClick={() => onPlan(c)}>{c.plan ? 'Cambiar plan' : 'Asignar plan'}</Button>
        {c.kind === 'client' ? <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Cambiar la administración de ${c.name}`} onClick={() => onAgency(c)}>Administración</Button> : null}
        {c.state === 'invited' ? <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Reenviar la invitación de ${c.name}`} loading={resending} onClick={() => onResend(c)}>Reenviar invitación</Button> : null}
      </div>
    </li>
  );
}

/** Pestaña «Empresas»: todas las organizaciones cliente y agencia con su estado y plan; asignación de plan. */
export function CompaniesPage() {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<CompanyFilters>(NO_FILTERS);
  const [target, setTarget] = useState<Company | null>(null);
  const [creating, setCreating] = useState(false);
  const [agencyTarget, setAgencyTarget] = useState<Company | null>(null);
  const agencies = useAgencyOptions();
  const [resent, setResent] = useState<{ company: string; invitation: InvitationIssued }>();
  const { switchContext } = useSession();
  const navigate = useNavigate();
  const [entering, setEntering] = useState<string>();
  const [enterError, setEnterError] = useState<string>();
  const [resendError, setResendError] = useState<string>();
  const resend = useResendInvitation();

  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = useCompanies(filters);
  const plans = usePlans(false);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const set = <K extends keyof CompanyFilters>(k: K, v: CompanyFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = Boolean(filters.q || filters.kind || filters.state || filters.plan || filters.agency);

  /** Soporte (ADR-21/41): el Súper Admin entra a la empresa sin cerrar sesión; queda anotado en «Accesos» y marcado en la auditoría de la empresa. */
  async function enter(c: Company) {
    setEnterError(undefined);
    setEntering(c.id);
    try {
      await switchContext(c.id);
      navigate('/');
    } catch (e) {
      setEnterError(friendlyError(e, 'No pudimos entrar a esa cuenta. Actualiza la lista e inténtalo de nuevo.'));
      setEntering(undefined);
    }
  }

  function resendInvitation(c: Company) {
    setResendError(undefined);
    resend.mutate(c.id, { onSuccess: (invitation) => setResent({ company: c.name, invitation }), onError: (e) => setResendError(friendlyError(e, 'No pudimos reenviar la invitación.')) });
  }

  return (
    <div className="grid gap-4">
      <div className="flex justify-end"><Button variant="primary" onClick={() => setCreating(true)}>Nueva empresa</Button></div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Empresa o correo" className={`${selectCls} font-normal`} />
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Tipo
          <select value={filters.kind} onChange={(e) => set('kind', e.target.value as CompanyFilters['kind'])} className={`${selectCls} font-normal`}>
            <option value="">Todos</option><option value="client">Clientes</option><option value="agency">Agencias</option>
          </select>
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Estado
          <select value={filters.state} onChange={(e) => set('state', e.target.value as CompanyFilters['state'])} className={`${selectCls} font-normal`}>
            <option value="">Todos</option><option value="trial">En prueba</option><option value="trial_expired">Prueba vencida</option><option value="active">Activa</option><option value="suspended">Suspendida</option><option value="invited">Invitación pendiente</option>
          </select>
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Plan
          <select value={filters.plan} onChange={(e) => set('plan', e.target.value)} className={`${selectCls} font-normal`}>
            <option value="">Todos</option><option value="none">Sin plan</option>
            {(plans.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Administración
          <select value={filters.agency} onChange={(e) => set('agency', e.target.value)} className={`${selectCls} font-normal`}>
            <option value="">Todas</option><option value="none">Administración directa</option>
            {(agencies.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {filtered ? <Button variant="link" onClick={() => { setText(''); setFilters(NO_FILTERS); }}>Limpiar filtros</Button> : null}
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando empresas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las empresas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">{filtered ? 'Ninguna empresa coincide con los filtros.' : 'Todavía no hay empresas.'}</p>
      ) : null}
      {items.length > 0 ? <ul className="grid gap-3" aria-label="Empresas">{items.map((c) => <Row key={c.id} c={c} onPlan={setTarget} onAgency={setAgencyTarget} onResend={resendInvitation} onEnter={(x) => void enter(x)} resending={resend.isPending && resend.variables === c.id} entering={entering === c.id} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}

      {resendError ? <Alert>{resendError}</Alert> : null}
      {enterError ? <Alert>{enterError}</Alert> : null}
      {target ? <AssignPlanDialog company={target} plans={plans.data?.items ?? []} onClose={() => setTarget(null)} /> : null}
      {agencyTarget ? <ChangeAgencyDialog company={agencyTarget} agencies={agencies.data?.items ?? []} onClose={() => setAgencyTarget(null)} /> : null}
      {creating ? <NewCompanyDialog plans={plans.data?.items ?? []} onClose={() => setCreating(false)} /> : null}
      {resent ? (
        <Modal title={`Invitación de ${resent.company}`} onClose={() => setResent(undefined)}>
          <InviteResult invitation={resent.invitation} />
          <div className="flex justify-end"><Button variant="primary" onClick={() => setResent(undefined)}>Listo</Button></div>
        </Modal>
      ) : null}
    </div>
  );
}
