import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { useIdempotencyKey } from '../../lib/idempotency';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { sizeLabel } from '../library/useLibrary';
import { useCompaniesSpace, useCompanyGrants, usePlatformStoragePlans, useSpaceRequests, useStorageMutations, type CompanySpace, type StoragePlan } from './useStorage';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const GB = 1024 ** 3;
const gb = (bytes: number): string => String(Math.round((bytes / GB) * 1000) / 1000).replace('.', ',');
const day = (iso: string): string => new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
const price = (p: { price_amount: string | null; currency: string | null }): string => (p.price_amount ? `${p.price_amount.replace(/\.00$/, '')} ${p.currency ?? ''}`.trim() : 'sin precio');

/** Crear o editar un plan del catálogo. */
function PlanDialog({ plan, onClose }: { plan: StoragePlan | null; onClose: () => void }) {
  const { createPlan, updatePlan } = useStorageMutations();
  const [name, setName] = useState(plan?.name ?? '');
  const [size, setSize] = useState(plan ? gb(plan.extra_bytes) : '');
  const [amount, setAmount] = useState(plan?.price_amount ?? '');
  const [currency, setCurrency] = useState(plan?.currency ?? 'USD');
  const [error, setError] = useState<string>();
  const sizeNum = Number(size.replace(',', '.'));
  const valid = name.trim() !== '' && Number.isFinite(sizeNum) && sizeNum > 0 && /^\d{1,7}(\.\d{1,2})?$/.test(amount.trim()) && /^[A-Za-z]{3}$/.test(currency.trim());
  const save = (): void => {
    setError(undefined);
    const body = { name: name.trim(), extra_gb: sizeNum, price_amount: amount.trim(), currency: currency.trim().toUpperCase() };
    const opts = { onSuccess: onClose, onError: (e: unknown) => setError(friendlyError(e, 'No se pudo guardar el plan')) };
    if (plan) updatePlan.mutate({ id: plan.id, patch: body }, opts);
    else createPlan.mutate({ ...body, active: true, sort: 0 }, opts);
  };
  return (
    <Modal title={plan ? `Editar ${plan.name}` : 'Nuevo plan de espacio'} onClose={onClose}>
      <Field label="Nombre">{(f) => <Input {...f} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Espacio que suma (GB)" hint="Lo ya vendido no cambia al editar el plan.">{(f) => <Input {...f} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} />}</Field>
      <div className="grid grid-cols-[1fr_90px] gap-2">
        <Field label="Precio de lista por mes">{(f) => <Input {...f} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Moneda">{(f) => <Input {...f} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />}</Field>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={!valid} loading={createPlan.isPending || updatePlan.isPending} onClick={save}>Guardar</Button>
      </div>
    </Modal>
  );
}

/** Activar un plan (o dar espacio como regalo) a una empresa. El cobro se hizo fuera de la aplicación. */
function GrantDialog({ company, plans, onClose }: { company: CompanySpace; plans: StoragePlan[]; onClose: () => void }) {
  const { grant } = useStorageMutations();
  const idem = useIdempotencyKey();
  const wanted = plans.find((p) => p.id === company.open_request?.plan_id)?.id ?? plans.find((p) => p.active)?.id ?? '';
  const [planId, setPlanId] = useState(wanted);
  const [size, setSize] = useState('');
  const [ends, setEnds] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const sizeNum = Number(size.replace(',', '.'));
  const gift = planId === '';
  const valid = gift ? Number.isFinite(sizeNum) && sizeNum > 0 && reason.trim() !== '' : true;
  const submit = (): void => {
    setError(undefined);
    const body = { ...(gift ? { extra_gb: sizeNum } : { plan_id: planId }), ...(ends ? { ends_at: new Date(`${ends}T23:59:59`).toISOString() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) };
    grant.mutate({ orgId: company.id, body, key: idem.keyFor({ id: company.id, body }) }, { onSuccess: () => { idem.reset(); onClose(); }, onError: (e) => setError(friendlyError(e, 'No se pudo activar el espacio')) });
  };
  return (
    <Modal title={`Activar espacio · ${company.name}`} onClose={onClose}>
      {company.open_request ? <Alert kind="info">Pidió {company.open_request.plan_name ? `«${company.open_request.plan_name}»` : 'más espacio'}{company.open_request.note ? `: ${company.open_request.note}` : ''}. Al activar, la solicitud se da por atendida.</Alert> : null}
      <label className="grid gap-1 text-[12.5px] font-semibold">Plan
        <select aria-label="Plan" value={planId} onChange={(e) => setPlanId(e.target.value)} className="rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal">
          {plans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} · +{sizeLabel(p.extra_bytes)} · {price(p)}</option>)}
          <option value="">Regalo o ajuste (sin plan)</option>
        </select>
      </label>
      {gift ? <Field label="Espacio (GB)">{(f) => <Input {...f} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} />}</Field> : null}
      <Field label="Vence el (opcional)" hint="Sin fecha, el espacio no vence. Al vencer no se borra nada: solo se frenan las subidas nuevas.">{(f) => <Input {...f} type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />}</Field>
      <Field label={gift ? 'Motivo (obligatorio)' : 'Nota (opcional)'}>{(f) => <Input {...f} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={!valid} loading={grant.isPending} onClick={submit}>Activar</Button>
      </div>
    </Modal>
  );
}

/** El espacio extra de una empresa: lo vigente, lo vencido y lo anulado, con «Anular». */
function GrantsDialog({ company, onClose }: { company: CompanySpace; onClose: () => void }) {
  const q = useCompanyGrants(company.id);
  const { revoke } = useStorageMutations();
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const items = (q.data?.items ?? []).filter((g) => g.kind === 'grant');
  return (
    <Modal title={`Espacio de ${company.name}`} onClose={onClose} wide>
      {q.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando el espacio" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudo cargar')}</Alert> : null}
      {q.data ? <p className="text-[13px]">Cupo: <b>{sizeLabel(q.data.quota.effective_bytes)}</b> ({sizeLabel(q.data.quota.included_bytes)} incluidos + {sizeLabel(q.data.quota.extra_bytes)} extra)</p> : null}
      {q.isSuccess && items.length === 0 ? <p className="py-4 text-center text-[13px] text-muted">Esta empresa no tiene espacio extra.</p> : null}
      <ul aria-label="Espacio extra" className="grid gap-2">
        {items.map((g) => (
          <li key={g.id} className="grid gap-1 rounded-xl border border-line p-3 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <b>{g.plan_name} · +{sizeLabel(g.extra_bytes)}</b>
              {g.revoked ? <Pill kind="muted">Anulado</Pill> : g.active ? <Pill kind="ok">Vigente</Pill> : <Pill kind="warn">{g.ends_at && new Date(g.ends_at) < new Date() ? 'Vencido' : 'Aún no empieza'}</Pill>}
            </div>
            <span className="text-muted">{price(g)} · desde {day(g.starts_at)}{g.ends_at ? ` hasta ${day(g.ends_at)}` : ' · sin vencimiento'}{g.reason ? ` · ${g.reason}` : ''}</span>
            {g.active ? (
              target === g.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input aria-label="Motivo de la anulación" value={reason} maxLength={300} placeholder="Motivo (obligatorio)" onChange={(e) => setReason(e.target.value)} className="min-w-[180px] flex-1 rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]" />
                  <Button variant="primary" className={SMALL} disabled={reason.trim().length < 3} loading={revoke.isPending} onClick={() => revoke.mutate({ orgId: company.id, grantId: g.id, reason: reason.trim() }, { onSuccess: () => { setTarget(null); setReason(''); }, onError: (e) => setError(friendlyError(e, 'No se pudo anular')) })}>Confirmar anulación</Button>
                  <Button className={SMALL} onClick={() => setTarget(null)}>Cancelar</Button>
                </div>
              ) : <div><Button className={SMALL} aria-label={`Anular ${g.plan_name}`} onClick={() => { setTarget(g.id); setError(undefined); }}>Anular</Button></div>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}

/** Plataforma › Espacio (V21b, ADR-75): solicitudes de más espacio, espacio por empresa y catálogo de planes. El cobro es manual. */
export function StoragePage() {
  const plans = usePlatformStoragePlans();
  const requests = useSpaceRequests();
  const companies = useCompaniesSpace();
  const { dismiss } = useStorageMutations();
  const [editing, setEditing] = useState<StoragePlan | null | 'new'>(null);
  const [granting, setGranting] = useState<CompanySpace | null>(null);
  const [viewing, setViewing] = useState<CompanySpace | null>(null);
  const [error, setError] = useState<string>();
  const catalog = plans.data?.items ?? [];
  return (
    <div className="grid gap-5">
      <section aria-label="Solicitudes de espacio" className="grid gap-2">
        <h2 className="text-[15px] font-bold">Solicitudes abiertas</h2>
        {requests.isPending ? <Spinner label="Cargando solicitudes" /> : null}
        {requests.isError ? <Alert>{friendlyError(requests.error, 'No se pudieron cargar las solicitudes')}</Alert> : null}
        {requests.isSuccess && requests.data.items.length === 0 ? <p className="rounded-xl border border-line bg-surface p-4 text-[13px] text-muted">No hay solicitudes de espacio pendientes.</p> : null}
        <ul className="grid gap-2">
          {requests.data?.items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3 text-[13px]">
              <div className="min-w-0">
                <b>{c.name}</b> pide {c.open_request?.plan_name ? <b>{c.open_request.plan_name}</b> : 'más espacio'}
                <div className="text-muted">Cupo {sizeLabel(c.quota.effective_bytes)}{c.open_request?.note ? ` · «${c.open_request.note}»` : ''}</div>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" className={SMALL} aria-label={`Activar plan a ${c.name}`} onClick={() => setGranting(c)}>Activar plan</Button>
                <Button className={SMALL} aria-label={`Descartar la solicitud de ${c.name}`} loading={dismiss.isPending} onClick={() => { setError(undefined); dismiss.mutate(c.id, { onError: (e) => setError(friendlyError(e, 'No se pudo descartar')) }); }}>Descartar</Button>
              </div>
            </li>
          ))}
        </ul>
        {error ? <Alert>{error}</Alert> : null}
      </section>

      <section aria-label="Espacio por empresa" className="grid gap-2">
        <h2 className="text-[15px] font-bold">Espacio por empresa</h2>
        {companies.isPending ? <Spinner label="Cargando empresas" /> : null}
        {companies.isError ? <Alert>{friendlyError(companies.error, 'No se pudieron cargar las empresas')}</Alert> : null}
        {companies.data?.truncated ? <Alert kind="info">Se muestran las primeras 1 000 empresas.</Alert> : null}
        <ul className="grid gap-2">
          {companies.data?.items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3 text-[13px]">
              <div className="min-w-0"><b>{c.name}</b><div className="text-muted">Cupo {sizeLabel(c.quota.effective_bytes)} · extra {sizeLabel(c.quota.extra_bytes)}{c.quota.next_expiry_at ? ` · vence ${day(c.quota.next_expiry_at)}` : ''}</div></div>
              <div className="flex gap-2">
                <Button className={SMALL} aria-label={`Ver el espacio de ${c.name}`} onClick={() => setViewing(c)}>Ver</Button>
                <Button className={SMALL} aria-label={`Dar espacio a ${c.name}`} onClick={() => setGranting(c)}>Dar espacio</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Catálogo de planes de espacio" className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-bold">Planes de espacio extra</h2>
          <Button className={SMALL} onClick={() => setEditing('new')}>Nuevo plan</Button>
        </div>
        {plans.isError ? <Alert>{friendlyError(plans.error, 'No se pudo cargar el catálogo')}</Alert> : null}
        <ul className="grid gap-2 sm:grid-cols-2">
          {catalog.map((p) => (
            <li key={p.id} className={`flex items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3 text-[13px] ${p.active ? '' : 'opacity-70'}`}>
              <div><b>{p.name}</b> <span className="text-muted">+{sizeLabel(p.extra_bytes)}</span><div>{price(p)} / mes {p.active ? null : <Pill kind="muted">Oculto</Pill>}</div></div>
              <Button className={SMALL} aria-label={`Editar el plan ${p.name}`} onClick={() => setEditing(p)}>Editar</Button>
            </li>
          ))}
        </ul>
      </section>

      {editing ? <PlanDialog plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {granting ? <GrantDialog company={granting} plans={catalog} onClose={() => setGranting(null)} /> : null}
      {viewing ? <GrantsDialog company={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
