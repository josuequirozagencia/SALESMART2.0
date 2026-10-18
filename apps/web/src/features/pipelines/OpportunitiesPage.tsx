import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Pipeline } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { NewPipelineDialog } from './NewPipelineDialog';
import { StagesDialog } from './StagesDialog';
import { stageStyle } from './stageColors';
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

/**
 * Oportunidades (M4, ADR-49). Tablero por pipeline con una columna por etapa (encabezado pastel, plegable). M4.1 trae la configuración —pipelines y etapas— y el
 * tablero vacío; las tarjetas llegan en M4.2. El pipeline elegido se recuerda en este navegador.
 */
export function OpportunitiesPage() {
  const q = usePipelines();
  const [choice, setChoice] = useState<string | null>(loadChoice);
  const [showHidden, setShowHidden] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<'new' | 'stages' | null>(null);
  const pipelines = useMemo(() => q.data?.items ?? [], [q.data]);
  const access = q.data?.access ?? { manage: false, write: false };
  const current: Pipeline | undefined = pipelines.find((p) => p.id === choice) ?? pipelines[0];
  const hidden = current?.stages.filter((s) => s.is_hidden) ?? [];
  const stages = current ? (showHidden ? current.stages : current.stages.filter((s) => !s.is_hidden)) : [];

  function pick(id: string) {
    setChoice(id);
    saveChoice(id);
    setFolded(new Set());
  }
  const toggleFold = (id: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(id)) n.add(id); return n; });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold">Oportunidades</h1>
          {current ? <p className="text-[12.5px] text-muted">Pipeline {current.name} · {current.opportunity_count} oportunidad{current.opportunity_count === 1 ? '' : 'es'}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pipelines.length > 0 ? (
            <select aria-label="Pipeline" value={current?.id ?? ''} onChange={(e) => pick(e.target.value)} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]">
              {pipelines.map((p) => <option key={p.id} value={p.id}>Pipeline: {p.name}</option>)}
            </select>
          ) : null}
          {access.manage ? <Button onClick={() => setDialog('new')}>Nuevo pipeline</Button> : null}
          {access.manage && current ? <Button onClick={() => setDialog('stages')}>Etapas</Button> : null}
        </div>
      </div>

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
          {stages.map((s) => {
            const fold = folded.has(s.id);
            return (
              <section key={s.id} role="listitem" aria-label={`Etapa ${s.name}`} className={`grid h-fit shrink-0 gap-2 rounded-2xl border border-line bg-surface2 p-2 ${fold ? 'w-[64px]' : 'w-[260px]'} ${s.is_hidden ? 'opacity-60' : ''}`}>
                <header className="flex items-start justify-between gap-1 rounded-xl px-2.5 py-2 text-fg" style={stageStyle(s.color)}>
                  {fold ? null : (
                    <div className="min-w-0">
                      <b className="block truncate text-[13.5px]">{s.name}</b>
                      <span className="text-[12px]">{s.opportunity_count} oportunidad{s.opportunity_count === 1 ? '' : 'es'}</span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {s.kind === 'won' ? <Pill kind="ok">Ganada</Pill> : null}
                        {s.kind === 'lost' ? <Pill kind="crit">Perdida</Pill> : null}
                        {s.is_hidden ? <Pill kind="muted">Oculta</Pill> : null}
                        {current.appointment_stage_id === s.id ? <Pill kind="info">Cita</Pill> : null}
                      </span>
                    </div>
                  )}
                  <button type="button" aria-label={`${fold ? 'Desplegar' : 'Plegar'} la etapa ${s.name}`} aria-expanded={!fold} onClick={() => toggleFold(s.id)} className="rounded-md px-1.5 text-[14px] font-bold hover:bg-black/10">{fold ? '»' : '«'}</button>
                </header>
                {fold ? null : <p className="px-2 py-3 text-center text-[12.5px] text-muted">Sin oportunidades</p>}
              </section>
            );
          })}
        </div>
      ) : null}

      {dialog === 'new' ? <NewPipelineDialog onClose={() => setDialog(null)} onCreated={(p) => { pick(p.id); setDialog('stages'); }} /> : null}
      {dialog === 'stages' && current ? <StagesDialog pipeline={current} isLast={pipelines.length <= 1} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); setChoice(null); }} /> : null}
    </div>
  );
}
