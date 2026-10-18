import { useEffect, useMemo, useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Opportunity, OpportunityDetail, Pipeline, PipelineStage } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { useOwners } from '../contacts/useContacts';
import { useTags } from '../tags/useTags';
import { LostReasonDialog } from './LostReasonDialog';
import { NewOpportunityDialog } from './NewOpportunityDialog';
import { NewPipelineDialog } from './NewPipelineDialog';
import { OpportunityDrawer } from './OpportunityDrawer';
import { OpportunityFilterPanel } from './OpportunityFilterPanel';
import { StageColumn } from './StageColumn';
import { StagesDialog } from './StagesDialog';
import { countOppFilters, NO_OPP_FILTERS, useMoveOpportunity, usePipelineSummary, type OpportunityFilters } from './useOpportunities';
import { usePipelines } from './usePipelines';

const STORE = 'ss:pipeline';
const loadChoice = (): string | null => {
  try {
    return window.localStorage.getItem(STORE);
  } catch {
    return null;
  }
};
const saveChoice = (id: string): void => {
  try {
    window.localStorage.setItem(STORE, id);
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
};

/** Lo mínimo de una oportunidad para moverla (la tarjeta y el panel la entregan con su contacto). */
type Movable = Pick<Opportunity, 'id' | 'stage_id'> & { contact: { name: string } };

/**
 * Oportunidades (M4, ADR-49). Tablero por pipeline: una columna por etapa (encabezado pastel, plegable) con sus tarjetas, que se arrastran a otra columna o se
 * mueven con «Mover a…». Filtros, resumen por etapa y panel lateral con el historial. Configurar pipelines y etapas es del administrador. El pipeline elegido
 * se recuerda en este navegador.
 */
export function OpportunitiesPage() {
  const q = usePipelines();
  const [choice, setChoice] = useState<string | null>(loadChoice);
  const [showHidden, setShowHidden] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<'new' | 'stages' | 'opportunity' | null>(null);
  const [filters, setFilters] = useState<OpportunityFilters>(NO_OPP_FILTERS);
  const [text, setText] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lostFor, setLostFor] = useState<{ opp: Movable; stage: PipelineStage } | null>(null);
  const [lostError, setLostError] = useState<string>();
  const [dragging, setDragging] = useState<Opportunity | null>(null);
  // La tarjeta que se arrastra también va en una referencia: el «drop» puede llegar antes de que React repinte el estado
  const dragRef = useRef<Opportunity | null>(null);
  const [notice, setNotice] = useState<string>();
  const move = useMoveOpportunity();

  const pipelines = useMemo(() => q.data?.items ?? [], [q.data]);
  const access = q.data?.access ?? { manage: false, write: false, view_all: false };
  const current: Pipeline | undefined = pipelines.find((p) => p.id === choice) ?? pipelines[0];
  const hidden = current?.stages.filter((s) => s.is_hidden) ?? [];
  const stages = current ? (showHidden ? current.stages : current.stages.filter((s) => !s.is_hidden)) : [];
  const owners = useOwners(access.view_all);
  const tags = useTags();
  const summary = usePipelineSummary(current?.id, filters);
  const byStage = useMemo(() => new Map((summary.data ?? []).map((s) => [s.stage_id, s])), [summary.data]);
  const filtered = countOppFilters(filters);
  const shown = (summary.data ?? []).reduce((n, s) => n + s.count, 0);

  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  function pick(id: string) {
    setChoice(id);
    saveChoice(id);
    setFolded(new Set());
    setOpenId(null);
  }
  const toggleFold = (id: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(id)) n.add(id); return n; });

  /** Mueve una oportunidad; a la etapa «perdida» antes pide el motivo. */
  function requestMove(o: Movable, stageId: string) {
    if (!current || stageId === o.stage_id) return;
    const target = current.stages.find((s) => s.id === stageId);
    if (!target) return;
    setNotice(undefined);
    if (target.kind === 'lost') {
      setLostError(undefined);
      setLostFor({ opp: o, stage: target });
      return;
    }
    move.mutate({ id: o.id, stageId }, { onError: (e) => setNotice(friendlyError(e, 'No pudimos mover la oportunidad.')) });
  }
  function confirmLost(reason: string) {
    if (!lostFor) return;
    move.mutate({ id: lostFor.opp.id, stageId: lostFor.stage.id, reason }, { onSuccess: () => setLostFor(null), onError: (e) => setLostError(friendlyError(e, 'No pudimos mover la oportunidad.')) });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold">Oportunidades</h1>
          {current ? (
            <p className="text-[12.5px] text-muted">
              Pipeline {current.name} · {filtered > 0 ? `${shown} de ` : ''}{current.opportunity_count} oportunidad{current.opportunity_count === 1 ? '' : 'es'}
              {access.write ? ' · arrastra una tarjeta para cambiar de etapa' : ''}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pipelines.length > 0 ? (
            <select aria-label="Pipeline" value={current?.id ?? ''} onChange={(e) => pick(e.target.value)} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]">
              {pipelines.map((p) => <option key={p.id} value={p.id}>Pipeline: {p.name}</option>)}
            </select>
          ) : null}
          {current ? <Button aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>{filtered > 0 ? `Filtros · ${filtered}` : 'Filtros'}</Button> : null}
          {access.write && current ? <Button variant="primary" onClick={() => setDialog('opportunity')}>Nueva oportunidad</Button> : null}
          {access.manage ? <Button onClick={() => setDialog('new')}>Nuevo pipeline</Button> : null}
          {access.manage && current ? <Button onClick={() => setDialog('stages')}>Etapas</Button> : null}
        </div>
      </div>

      {filtersOpen && current ? <OpportunityFilterPanel filters={filters} onChange={setFilters} text={text} onText={setText} viewAll={access.view_all} owners={owners.data ?? []} tags={tags.data?.items ?? []} /> : null}
      {notice ? <Alert>{notice}</Alert> : null}

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando pipelines" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los pipelines.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}

      {current && hidden.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Pill kind="muted">{hidden.length} etapa{hidden.length === 1 ? '' : 's'} oculta{hidden.length === 1 ? '' : 's'}</Pill>
          <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>{showHidden ? 'Ocultar de nuevo' : 'Ver etapas ocultas'}</Button>
        </div>
      ) : null}

      {current ? (
        <div role="list" aria-label={`Etapas del pipeline ${current.name}`} className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((s) => (
            <StageColumn
              key={s.id}
              pipeline={current}
              stage={s}
              filters={filters}
              summary={byStage.get(s.id)}
              folded={folded.has(s.id)}
              canWrite={access.write}
              dragging={dragging}
              onToggleFold={() => toggleFold(s.id)}
              onOpen={(o) => setOpenId(o.id)}
              onMove={(o, stageId) => requestMove(o, stageId)}
              onDragStart={(o) => { dragRef.current = o; setDragging(o); }}
              onDragEnd={() => { dragRef.current = null; setDragging(null); }}
              onDropHere={() => { const o = dragRef.current; dragRef.current = null; setDragging(null); if (o) requestMove(o, s.id); }}
            />
          ))}
        </div>
      ) : null}

      {dialog === 'new' ? <NewPipelineDialog onClose={() => setDialog(null)} onCreated={(p) => { pick(p.id); setDialog('stages'); }} /> : null}
      {dialog === 'stages' && current ? <StagesDialog pipeline={current} isLast={pipelines.length <= 1} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); setChoice(null); }} /> : null}
      {dialog === 'opportunity' && current ? (
        <NewOpportunityDialog pipelines={pipelines} pipelineId={current.id} viewAll={access.view_all} owners={owners.data ?? []} onClose={() => setDialog(null)} onCreated={(o: OpportunityDetail) => { setDialog(null); setOpenId(o.id); }} />
      ) : null}
      {openId && current ? <OpportunityDrawer id={openId} pipeline={current} canWrite={access.write} viewAll={access.view_all} owners={owners.data ?? []} onClose={() => setOpenId(null)} onMove={(o, stageId) => requestMove(o, stageId)} /> : null}
      {lostFor ? <LostReasonDialog name={lostFor.opp.contact.name} stageName={lostFor.stage.name} busy={move.isPending} error={lostError} onConfirm={confirmLost} onClose={() => setLostFor(null)} /> : null}
    </div>
  );
}
