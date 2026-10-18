import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { money } from '../../lib/format';
import type { Opportunity, Pipeline, PipelineStage, StageSummary } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { OpportunityCard } from './OpportunityCard';
import { stageStyle } from './stageColors';
import { useStageOpportunities, type OpportunityFilters } from './useOpportunities';

/**
 * Una columna del tablero: encabezado pastel con el conteo y el total de la etapa (del resumen, con los mismos filtros) y las tarjetas de esa etapa, la más
 * reciente primero, con «Cargar más». Acepta tarjetas arrastradas (si la persona puede escribir).
 */
export function StageColumn({
  pipeline,
  stage,
  filters,
  summary,
  folded,
  canWrite,
  dragging,
  onToggleFold,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
  onDropHere,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  filters: OpportunityFilters;
  summary: StageSummary | undefined;
  folded: boolean;
  canWrite: boolean;
  dragging: Opportunity | null;
  onToggleFold: () => void;
  onOpen: (o: Opportunity) => void;
  onMove: (o: Opportunity, stageId: string) => void;
  onDragStart: (o: Opportunity) => void;
  onDragEnd: () => void;
  onDropHere: () => void;
}) {
  const q = useStageOpportunities(pipeline.id, stage.id, filters, !folded);
  const [over, setOver] = useState(false);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const targets = useMemo(() => pipeline.stages.filter((s) => !s.is_hidden && s.id !== stage.id), [pipeline.stages, stage.id]);
  const count = summary?.count ?? 0;
  // Acepta soltar siempre que se pueda escribir (el navegador decide la validez del arrastre en el primer «dragover», antes de que React repinte); el destino real
  // lo resuelve la página con la tarjeta que empezó el arrastre
  const accepts = canWrite && !stage.is_hidden;
  const droppable = accepts && dragging !== null && dragging.stage_id !== stage.id;

  return (
    <section
      role="listitem"
      aria-label={`Etapa ${stage.name}`}
      onDragOver={(e) => { if (accepts) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (droppable) setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); if (accepts) { e.preventDefault(); onDropHere(); } }}
      className={`grid h-fit shrink-0 gap-2 rounded-2xl border bg-surface2 p-2 ${folded ? 'w-[64px]' : 'w-[260px]'} ${stage.is_hidden ? 'opacity-60' : ''} ${over ? 'border-accent ring-2 ring-accent' : 'border-line'}`}
    >
      <header className="flex items-start justify-between gap-1 rounded-xl px-2.5 py-2 text-fg" style={stageStyle(stage.color)}>
        {folded ? null : (
          <div className="min-w-0">
            <b className="block truncate text-[13.5px]">{stage.name}</b>
            <span className="text-[12px]">{count} oportunidad{count === 1 ? '' : 'es'} · <b className="font-mono">{money(summary?.total ?? '0')}</b></span>
            <span className="mt-1 flex flex-wrap gap-1">
              {stage.kind === 'won' ? <Pill kind="ok">Ganada</Pill> : null}
              {stage.kind === 'lost' ? <Pill kind="crit">Perdida</Pill> : null}
              {stage.is_hidden ? <Pill kind="muted">Oculta</Pill> : null}
              {pipeline.appointment_stage_id === stage.id ? <Pill kind="info">Cita</Pill> : null}
            </span>
          </div>
        )}
        <button type="button" aria-label={`${folded ? 'Desplegar' : 'Plegar'} la etapa ${stage.name}`} aria-expanded={!folded} onClick={onToggleFold} className="rounded-md px-1.5 text-[14px] font-bold hover:bg-black/10">{folded ? '»' : '«'}</button>
      </header>
      {folded ? null : (
        <div className="grid gap-2">
          {q.isPending ? <div className="grid place-items-center py-3 text-muted"><Spinner label={`Cargando ${stage.name}`} /></div> : null}
          {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar esta etapa.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
          {q.isSuccess && items.length === 0 ? <p className="px-2 py-3 text-center text-[12.5px] text-muted">{droppable ? 'Suelta aquí' : 'Sin oportunidades'}</p> : null}
          {items.map((o) => (
            <OpportunityCard key={o.id} opp={o} targets={targets} canWrite={canWrite} onOpen={onOpen} onMove={onMove} onDragStart={onDragStart} onDragEnd={onDragEnd} />
          ))}
          {q.hasNextPage ? <Button className="!py-1.5 !text-[12.5px]" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button> : null}
        </div>
      )}
    </section>
  );
}
