import { initials, money, sourceLabel } from '../../lib/format';
import { formatPhone } from '../../lib/phone';
import type { Opportunity, PipelineStage } from '../../lib/types';

/**
 * Tarjeta de una oportunidad en el tablero (M4.2): contacto, monto, origen y responsable. Se arrastra a otra columna o, sin ratón, se mueve con el selector
 * «Mover a…». Abre el panel lateral al pulsar el nombre. `targets` son las etapas a las que se puede mover (visibles y distintas de la actual).
 */
export function OpportunityCard({
  opp,
  targets,
  canWrite,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  opp: Opportunity;
  targets: PipelineStage[];
  canWrite: boolean;
  onOpen: (o: Opportunity) => void;
  onMove: (o: Opportunity, stageId: string) => void;
  onDragStart: (o: Opportunity) => void;
  onDragEnd: () => void;
}) {
  const c = opp.contact;
  return (
    <article
      aria-label={`Oportunidad de ${c.name}`}
      draggable={canWrite}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', opp.id); onDragStart(opp); }}
      onDragEnd={onDragEnd}
      className={`grid gap-1.5 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-sm ${canWrite ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => onOpen(opp)} aria-label={`Abrir la oportunidad de ${c.name}`} className="min-w-0 truncate text-left text-[13.5px] font-semibold hover:underline">{c.name}</button>
        <span title={opp.owner ? `Responsable: ${opp.owner.name}` : 'Sin asignar'} className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[10.5px] font-bold text-accent">{opp.owner ? initials(opp.owner.name) : '—'}</span>
      </div>
      <div className="font-mono text-[13px] font-semibold">{money(opp.amount, opp.currency)}</div>
      <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
        <span>{sourceLabel(c.source)}</span>
        {c.phone ? <span>{formatPhone(c.phone)}</span> : null}
        {c.tags.length > 0 ? <span title={c.tags.map((t) => t.name).join(', ')}>{c.tags.length} etiqueta{c.tags.length === 1 ? '' : 's'}</span> : null}
      </div>
      {canWrite && targets.length > 0 ? (
        <select aria-label={`Mover a ${c.name}`} value="" onChange={(e) => { if (e.target.value) onMove(opp, e.target.value); }} className="rounded-lg border border-line bg-surface px-2 py-1 text-[12px]">
          <option value="">Mover a…</option>
          {targets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      ) : null}
    </article>
  );
}
