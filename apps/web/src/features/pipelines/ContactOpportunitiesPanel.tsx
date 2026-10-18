import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { money, shortDateTime } from '../../lib/format';
import type { Contact, OwnerOption } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { NewOpportunityDialog } from './NewOpportunityDialog';
import { useContactOpportunities } from './useOpportunities';
import { usePipelines } from './usePipelines';

/**
 * Oportunidades de un contacto (M4.2, ADR-49), dentro de su ficha: las abiertas y las cerradas, con su pipeline y su etapa, y el alta de una nueva (una abierta
 * por pipeline). El tablero de «Oportunidades» es donde se mueven.
 */
export function ContactOpportunitiesPanel({ contact, canWrite, viewAll, owners }: { contact: Contact; canWrite: boolean; viewAll: boolean; owners: OwnerOption[] }) {
  const pipelines = usePipelines();
  const opps = useContactOpportunities(contact.id);
  const [creating, setCreating] = useState(false);
  const list = pipelines.data?.items ?? [];
  const canCreate = canWrite && pipelines.data?.access.write === true && list.length > 0;
  const stageName = (pipelineId: string, stageId: string): string => list.find((p) => p.id === pipelineId)?.stages.find((s) => s.id === stageId)?.name ?? 'Etapa';
  const pipelineName = (pipelineId: string): string => list.find((p) => p.id === pipelineId)?.name ?? 'Pipeline';

  return (
    <section aria-label="Oportunidades" className="grid gap-3">
      {canCreate ? <div><Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setCreating(true)}>Nueva oportunidad</Button></div> : null}
      {opps.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Cargando oportunidades" /></div> : null}
      {opps.isError ? <Alert>{friendlyError(opps.error, 'No pudimos cargar las oportunidades.')} <Button variant="link" onClick={() => void opps.refetch()}>Reintentar</Button></Alert> : null}
      {opps.isSuccess && opps.data.items.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">Este contacto no tiene oportunidades.</p> : null}
      <ul className="grid gap-2">
        {(opps.data?.items ?? []).map((o) => (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px]">
            <span className="min-w-0">
              <b>{pipelineName(o.pipeline_id)}</b> · {stageName(o.pipeline_id, o.stage_id)}
              <span className="block text-[12px] text-muted">Creada {shortDateTime(o.created_at)}{o.owner ? ` · ${o.owner.name}` : ''}{o.lost_reason ? ` · ${o.lost_reason}` : ''}</span>
            </span>
            <span className="flex items-center gap-2"><span className="font-mono font-semibold">{money(o.amount, o.currency)}</span>{o.status === 'won' ? <Pill kind="ok">Ganada</Pill> : o.status === 'lost' ? <Pill kind="crit">Perdida</Pill> : <Pill kind="info">Abierta</Pill>}</span>
          </li>
        ))}
      </ul>
      {creating ? <NewOpportunityDialog pipelines={list} contact={{ id: contact.id, name: contact.name }} viewAll={viewAll} owners={owners} onClose={() => setCreating(false)} onCreated={() => setCreating(false)} /> : null}
    </section>
  );
}
