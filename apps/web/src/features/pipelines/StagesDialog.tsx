import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Pipeline, PipelineStage, StageKind } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { STAGE_COLORS, stageStyle } from './stageColors';
import { useCreateStage, useDeletePipeline, useDeleteStage, useReorderStages, useUpdatePipeline, useUpdateStage, type StagePatch } from './usePipelines';

const inputCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';
const KIND_LABEL: Record<StageKind, string> = { open: 'Abierta', won: 'Ganada', lost: 'Perdida' };

/**
 * Editor de un pipeline y sus etapas (M4.1, ADR-49): renombrar, etapa de cita, crear, renombrar, colorear, ordenar, ocultar, marcar ganada o perdida y eliminar.
 * Las reglas (una ganada, nombres únicos, no ocultar la ganada…) las aplica el servidor; aquí solo se muestran sus motivos. `pipeline` viene siempre de la
 * lista viva, así que cada cambio se refleja al instante.
 */
export function StagesDialog({ pipeline, isLast, onClose, onDeleted }: { pipeline: Pipeline; isLast: boolean; onClose: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(pipeline.name);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'open' | 'lost'>('open');
  const updatePipeline = useUpdatePipeline();
  const deletePipeline = useDeletePipeline();
  const createStage = useCreateStage();
  const reorder = useReorderStages();

  const fail = (fallback: string) => (e: unknown) => setError(friendlyError(e, fallback));
  const open = pipeline.stages.filter((s) => s.kind === 'open');

  function renamePipeline(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const n = name.trim();
    if (n === '') return setError('Escribe el nombre del pipeline');
    if (n === pipeline.name) return;
    updatePipeline.mutate({ id: pipeline.id, patch: { name: n } }, { onError: fail('No pudimos renombrar el pipeline.') });
  }
  function addStage(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const n = newName.trim();
    if (n === '') return setError('Escribe el nombre de la etapa');
    createStage.mutate({ pipelineId: pipeline.id, input: { name: n, kind: newKind } }, { onSuccess: () => setNewName(''), onError: fail('No pudimos crear la etapa.') });
  }
  function move(index: number, delta: -1 | 1) {
    setError(undefined);
    const ids = pipeline.stages.map((s) => s.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to]!, ids[index]!];
    reorder.mutate({ pipelineId: pipeline.id, ids }, { onError: fail('No pudimos cambiar el orden.') });
  }

  return (
    <Modal title="Etapas del pipeline" onClose={onClose} wide>
      <form onSubmit={renamePipeline} className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-[200px] flex-1 gap-1 text-[12px] font-semibold">Nombre del pipeline
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={`${inputCls} font-normal`} />
        </label>
        <Button type="submit" disabled={name.trim() === pipeline.name || name.trim() === ''} loading={updatePipeline.isPending && updatePipeline.variables?.patch.name !== undefined}>Guardar nombre</Button>
      </form>

      <label className="grid gap-1 text-[12px] font-semibold min-[520px]:max-w-[320px]">Etapa de cita <span className="font-normal text-muted">(opcional: a ella pasa la oportunidad al agendar)</span>
        <select
          aria-label="Etapa de cita"
          value={pipeline.appointment_stage_id ?? ''}
          onChange={(e) => { setError(undefined); updatePipeline.mutate({ id: pipeline.id, patch: { appointment_stage_id: e.target.value || null } }, { onError: fail('No pudimos cambiar la etapa de cita.') }); }}
          className={`${inputCls} font-normal`}
        >
          <option value="">Ninguna</option>
          {open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>

      {error ? <Alert>{error}</Alert> : null}

      <ul className="grid gap-2" aria-label="Etapas">
        {pipeline.stages.map((s, i) => (
          <StageRow key={`${s.id}:${s.name}:${s.color}:${s.kind}:${s.is_hidden}`} stage={s} index={i} total={pipeline.stages.length} onMove={move} onError={(e, fallback) => setError(friendlyError(e, fallback))} onClearError={() => setError(undefined)} />
        ))}
      </ul>

      <form onSubmit={addStage} className="flex flex-wrap items-end gap-2" aria-label="Agregar etapa">
        <label className="grid min-w-[180px] flex-1 gap-1 text-[12px] font-semibold">Nueva etapa
          <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} className={`${inputCls} font-normal`} placeholder="Por ejemplo: Negociación" />
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Tipo
          <select aria-label="Tipo de la etapa nueva" value={newKind} onChange={(e) => setNewKind(e.target.value as 'open' | 'lost')} className={`${inputCls} font-normal`}>
            <option value="open">Abierta</option>
            <option value="lost">Perdida</option>
          </select>
        </label>
        <Button type="submit" loading={createStage.isPending}>Agregar etapa</Button>
      </form>
      <p className="text-[12px] text-muted">La etapa ganada es siempre una y no se oculta ni se elimina; para cambiarla, marca otra como ganada. Una etapa abierta que se elimina pasa sus oportunidades a la anterior.</p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {confirmDelete ? (
          <span className="flex items-center gap-2 text-[13px]">¿Borrar este pipeline?
            <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={deletePipeline.isPending} onClick={() => deletePipeline.mutate(pipeline.id, { onSuccess: onDeleted, onError: (e) => { setConfirmDelete(false); setError(friendlyError(e, 'No pudimos borrar el pipeline.')); } })}>Sí, borrar</Button>
            <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirmDelete(false)}>No</Button>
          </span>
        ) : <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" disabled={isLast} title={isLast ? 'Es el único pipeline: la empresa necesita al menos uno' : undefined} onClick={() => setConfirmDelete(true)}>Borrar pipeline</Button>}
        <Button variant="primary" onClick={onClose}>Listo</Button>
      </div>
    </Modal>
  );
}

function StageRow({ stage, index, total, onMove, onError, onClearError }: { stage: PipelineStage; index: number; total: number; onMove: (i: number, d: -1 | 1) => void; onError: (e: unknown, fallback: string) => void; onClearError: () => void }) {
  const [name, setName] = useState(stage.name);
  const [confirm, setConfirm] = useState(false);
  const update = useUpdateStage();
  const remove = useDeleteStage();
  const won = stage.kind === 'won';

  const patch = (p: StagePatch, fallback: string) => {
    onClearError();
    update.mutate({ id: stage.id, patch: p }, { onError: (e) => { setName(stage.name); onError(e, fallback); } });
  };
  const commitName = () => {
    const n = name.trim();
    if (n === stage.name) return;
    if (n === '') { setName(stage.name); return onError(null, 'El nombre de la etapa no puede quedar vacío.'); }
    patch({ name: n }, 'No pudimos renombrar la etapa.');
  };

  return (
    <li className={`grid gap-2 rounded-xl border border-line bg-surface p-2.5 ${stage.is_hidden ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className="size-5 shrink-0 rounded-md border border-line" style={stageStyle(stage.color)} />
        <input
          aria-label={`Nombre de la etapa ${stage.name}`}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
          className={`${inputCls} min-w-[140px] flex-1`}
        />
        <select aria-label={`Color de «${stage.name}»`} value={stage.color} onChange={(e) => patch({ color: e.target.value as PipelineStage['color'] }, 'No pudimos cambiar el color.')} className={inputCls}>
          {STAGE_COLORS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select aria-label={`Tipo de «${stage.name}»`} value={stage.kind} disabled={won} onChange={(e) => patch({ kind: e.target.value as StageKind }, 'No pudimos cambiar el tipo de la etapa.')} className={inputCls}>
          {(Object.keys(KIND_LABEL) as StageKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        {won ? <Pill kind="ok">Ganada</Pill> : stage.kind === 'lost' ? <Pill kind="crit">Perdida</Pill> : null}
        {stage.is_hidden ? <Pill kind="muted">Oculta</Pill> : null}
        <span className="text-muted">{stage.opportunity_count} oportunidad{stage.opportunity_count === 1 ? '' : 'es'}</span>
        <span className="flex-1" />
        <Button className="!px-2.5 !py-1 !text-[12px]" aria-label={`Subir «${stage.name}»`} disabled={index === 0} onClick={() => onMove(index, -1)}>↑</Button>
        <Button className="!px-2.5 !py-1 !text-[12px]" aria-label={`Bajar «${stage.name}»`} disabled={index === total - 1} onClick={() => onMove(index, 1)}>↓</Button>
        <Button className="!px-2.5 !py-1 !text-[12px]" aria-label={`${stage.is_hidden ? 'Mostrar' : 'Ocultar'} «${stage.name}»`} disabled={won} title={won ? 'La etapa ganada no se oculta' : undefined} onClick={() => patch({ is_hidden: !stage.is_hidden }, 'No pudimos cambiar la visibilidad.')}>{stage.is_hidden ? 'Mostrar' : 'Ocultar'}</Button>
        {confirm ? (
          <span className="flex items-center gap-1.5">¿Eliminar?
            <Button variant="danger" className="!px-2.5 !py-1 !text-[12px]" loading={remove.isPending} onClick={() => { onClearError(); remove.mutate(stage.id, { onError: (e) => { setConfirm(false); onError(e, 'No pudimos eliminar la etapa.'); } }); }}>Sí</Button>
            <Button className="!px-2.5 !py-1 !text-[12px]" onClick={() => setConfirm(false)}>No</Button>
          </span>
        ) : <Button variant="danger" className="!px-2.5 !py-1 !text-[12px]" aria-label={`Eliminar «${stage.name}»`} disabled={won} title={won ? 'Marca otra etapa como ganada para poder eliminar esta' : undefined} onClick={() => setConfirm(true)}>Eliminar</Button>}
      </div>
    </li>
  );
}
