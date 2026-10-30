import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Plan } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { PlanFormDialog } from './PlanFormDialog';
import { usePlanMutations, usePlans } from './usePlans';

const limit = (n: number | null): string => (n === null ? 'ilimitados' : n.toLocaleString('es-EC'));

function PlanCard({ plan, catalog, onEdit }: { plan: Plan; catalog: Array<{ key: string; label: string }>; onEdit: (p: Plan) => void }) {
  const { setArchived } = usePlanMutations();
  const [error, setError] = useState<string>();
  const on = catalog.filter((f) => plan.features[f.key]);
  return (
    <li className={`grid content-start gap-2.5 rounded-2xl border border-line bg-surface p-4 ${plan.archived ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[16px] font-bold">{plan.name}</h3>
        {plan.archived ? <Pill kind="muted">Archivado</Pill> : <Pill kind={plan.companies > 0 ? 'ok' : 'muted'}>{plan.companies} {plan.companies === 1 ? 'empresa' : 'empresas'}</Pill>}
      </div>
      {plan.description ? <p className="text-[12.5px] text-muted">{plan.description}</p> : null}
      <p className="text-[12.5px]"><b>{limit(plan.max_users)}</b> usuarios · <b>{limit(plan.max_connections)}</b> conexiones · <b>{limit(plan.max_queues)}</b> departamentos</p>
      <div className="flex flex-wrap gap-1.5" aria-label={`Módulos de ${plan.name}`}>
        {on.length === 0 ? <span className="text-[12px] text-muted">Ningún módulo encendido</span> : on.map((f) => <Pill key={f.key} kind="accent">{f.label}</Pill>)}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="mt-1 flex gap-2">
        {plan.archived ? (
          <Button className="!px-3 !py-1.5 !text-[12.5px]" loading={setArchived.isPending} onClick={() => { setError(undefined); setArchived.mutate({ id: plan.id, archived: false }, { onError: (e) => setError(friendlyError(e)) }); }}>Restaurar</Button>
        ) : (
          <>
            <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Editar el plan ${plan.name}`} onClick={() => onEdit(plan)}>Editar</Button>
            <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Archivar el plan ${plan.name}`} loading={setArchived.isPending} onClick={() => { setError(undefined); setArchived.mutate({ id: plan.id, archived: true }, { onError: (e) => setError(friendlyError(e)) }); }}>Archivar</Button>
          </>
        )}
      </div>
    </li>
  );
}

/** Pestaña «Planes»: catálogo de planes (módulos y límites). Los precios se definen aparte (pasarela de pagos por decidir). */
export function PlansPage() {
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const q = usePlans(archived);
  const catalog = q.data?.feature_catalog ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[640px] text-[13px] text-muted">Cada plan enciende o apaga módulos y fija límites. Asígnalo a cada empresa desde «Empresas». Los precios se definen aparte.</p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px] text-muted"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="accent-[var(--accent)]" />Mostrar archivados</label>
          <Button variant="primary" disabled={!q.isSuccess} onClick={() => setEditing('new')}>Nuevo plan</Button>
        </div>
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando planes" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los planes.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && q.data.items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">Todavía no hay planes. Crea el primero para poder asignarlo a una empresa.</p>
      ) : null}
      {q.isSuccess && q.data.items.length > 0 ? (
        <ul className="grid gap-3 min-[720px]:grid-cols-2 min-[1000px]:grid-cols-3" aria-label="Planes">
          {q.data.items.map((p) => <PlanCard key={p.id} plan={p} catalog={catalog} onEdit={setEditing} />)}
        </ul>
      ) : null}

      {editing ? <PlanFormDialog plan={editing === 'new' ? null : editing} catalog={catalog} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
