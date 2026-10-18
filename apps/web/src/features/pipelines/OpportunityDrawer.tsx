import { useEffect, useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { money, shortDateTime, sourceLabel } from '../../lib/format';
import { formatPhone } from '../../lib/phone';
import type { OpportunityDetail, OwnerOption, Pipeline } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { parseAmount } from './amount';
import { useDeleteOpportunity, useOpportunity, useUpdateOpportunity } from './useOpportunities';

const ORIGIN_LABEL: Record<string, string> = { manual: 'Manual', ai: 'IA', automation: 'Automatización', ghl: 'GoHighLevel', meta: 'Meta', api: 'API', system: 'Sistema' };

/**
 * Panel lateral de una oportunidad (M4.2, ADR-49 #8): contacto, etapa (se mueve con un clic), monto, responsable e historial de etapas. `onMove` lo resuelve la
 * página (que también pide el motivo cuando la etapa es la «perdida»).
 */
export function OpportunityDrawer({
  id,
  pipeline,
  canWrite,
  viewAll,
  owners,
  onClose,
  onMove,
}: {
  id: string;
  pipeline: Pipeline;
  canWrite: boolean;
  viewAll: boolean;
  owners: OwnerOption[];
  onClose: () => void;
  onMove: (o: OpportunityDetail, stageId: string) => void;
}) {
  const q = useOpportunity(id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const o = q.data;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-label={o ? `Oportunidad de ${o.contact.name}` : 'Oportunidad'} className="grid h-full w-[min(440px,100%)] content-start gap-4 overflow-y-auto border-l border-line bg-surface p-5 shadow-[var(--shadow)]">
        {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando la oportunidad" /></div> : null}
        {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar la oportunidad.')} <Button variant="link" onClick={onClose}>Cerrar</Button></Alert> : null}
        {o ? <DrawerBody key={`${o.amount}:${o.owner?.id ?? ''}`} o={o} pipeline={pipeline} canWrite={canWrite} viewAll={viewAll} owners={owners} onClose={onClose} onMove={onMove} /> : null}
      </aside>
    </div>
  );
}

function DrawerBody({ o, pipeline, canWrite, viewAll, owners, onClose, onMove }: { o: OpportunityDetail; pipeline: Pipeline; canWrite: boolean; viewAll: boolean; owners: OwnerOption[]; onClose: () => void; onMove: (o: OpportunityDetail, stageId: string) => void }) {
  const update = useUpdateOpportunity();
  const remove = useDeleteOpportunity();
  const [amount, setAmount] = useState(o.amount);
  const [owner, setOwner] = useState(o.owner?.id ?? '');
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const stages = pipeline.stages.filter((s) => !s.is_hidden || s.id === o.stage_id);
  const current = pipeline.stages.find((s) => s.id === o.stage_id);

  function saveAmount(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const parsed = parseAmount(amount);
    if (parsed === null) return setError('Escribe un monto válido (hasta 2 decimales)');
    if (parsed === o.amount) return;
    update.mutate({ id: o.id, patch: { amount: parsed } }, { onError: (err) => setError(friendlyError(err, 'No pudimos guardar el monto.')) });
  }
  function changeOwner(next: string) {
    setError(undefined);
    setOwner(next);
    update.mutate({ id: o.id, patch: { owner_id: next === '' ? null : next } }, { onError: (err) => { setOwner(o.owner?.id ?? ''); setError(friendlyError(err, 'No pudimos cambiar el responsable.')); } });
  }

  return (
    <>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[18px] font-bold">{o.contact.name}</h2>
          <p className="text-[12.5px] text-muted">{[o.contact.phone ? formatPhone(o.contact.phone) : null, o.contact.email, sourceLabel(o.contact.source)].filter(Boolean).join(' · ')}</p>
        </div>
        <Button aria-label="Cerrar el panel" className="!px-3 !py-1.5" onClick={onClose}>✕</Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono text-[18px] font-bold">{money(o.amount, o.currency)}</span>
        {o.status === 'won' ? <Pill kind="ok">Ganada</Pill> : o.status === 'lost' ? <Pill kind="crit">Perdida</Pill> : <Pill kind="info">Abierta</Pill>}
        <span className="text-muted">en {current?.name ?? 'la etapa'}{o.closed_at ? ` · cerrada ${shortDateTime(o.closed_at)}` : ''}</span>
      </div>
      {o.lost_reason ? <p className="rounded-xl bg-crit-soft px-3 py-2 text-[13px] text-crit"><b>Motivo de la pérdida:</b> {o.lost_reason}</p> : null}
      {o.contact.tags.length > 0 ? <ul aria-label="Etiquetas" className="flex flex-wrap gap-1.5">{o.contact.tags.map((t) => <li key={t.id} className="rounded-full border border-line px-2.5 py-0.5 text-[12px]">{t.name}</li>)}</ul> : null}

      <section aria-label="Etapa" className="grid gap-2">
        <h3 className="text-[13px] font-bold">Etapa</h3>
        <div className="flex flex-wrap gap-1.5">
          {stages.map((s) => (
            <button key={s.id} type="button" disabled={!canWrite || s.id === o.stage_id} aria-pressed={s.id === o.stage_id} aria-label={s.id === o.stage_id ? `Etapa actual: ${s.name}` : `Mover a ${s.name}`} onClick={() => onMove(o, s.id)} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold disabled:cursor-default ${s.id === o.stage_id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>{s.name}</button>
          ))}
        </div>
      </section>

      {canWrite ? (
        <form onSubmit={saveAmount} noValidate className="flex flex-wrap items-end gap-2" aria-label="Monto">
          <label className="grid min-w-[140px] flex-1 gap-1 text-[12px] font-semibold">Monto (USD)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal" />
          </label>
          <Button type="submit" loading={update.isPending && update.variables?.patch.amount !== undefined} disabled={parseAmount(amount) === o.amount}>Guardar monto</Button>
        </form>
      ) : null}

      <label className="grid gap-1 text-[12px] font-semibold min-[420px]:max-w-[280px]">Responsable
        {viewAll && canWrite ? (
          <select aria-label="Responsable" value={owner} onChange={(e) => changeOwner(e.target.value)} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal">
            <option value="">Sin asignar</option>
            {owners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {o.owner && !owners.some((p) => p.id === o.owner!.id) ? <option value={o.owner.id}>{o.owner.name} (ya no está en el equipo)</option> : null}
          </select>
        ) : <span className="text-[13px] font-normal">{o.owner?.name ?? 'Sin asignar'}</span>}
      </label>

      {error ? <Alert>{error}</Alert> : null}

      <section aria-label="Historial" className="grid gap-2">
        <h3 className="text-[13px] font-bold">Historial de etapas</h3>
        <ul className="grid gap-1.5">
          {o.history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-[12.5px]">
              <span><Pill kind="muted">{ORIGIN_LABEL[h.origin] ?? h.origin}</Pill> {h.from_stage ? <>{h.from_stage.name} → <b>{h.to_stage.name}</b></> : <>Creada en <b>{h.to_stage.name}</b></>}{h.user ? ` · ${h.user.name}` : ''}</span>
              <span className="text-muted">{shortDateTime(h.at)}</span>
            </li>
          ))}
        </ul>
      </section>

      {canWrite ? (
        <div className="flex justify-end">
          {confirm ? (
            <span className="flex items-center gap-2 text-[13px]">¿Borrar esta oportunidad?
              <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={remove.isPending} onClick={() => remove.mutate(o.id, { onSuccess: onClose, onError: (err) => { setConfirm(false); setError(friendlyError(err, 'No pudimos borrar la oportunidad.')); } })}>Sí, borrar</Button>
              <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
            </span>
          ) : <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(true)}>Borrar oportunidad</Button>}
        </div>
      ) : null}
    </>
  );
}
