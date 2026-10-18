import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { OwnerOption, Task } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useCreateTask, useDeleteTask, useUpdateTask, type TaskInput } from './useCrm';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal';
const pad = (n: number): string => String(n).padStart(2, '0');

/** Instante UTC → valor de `datetime-local` en la hora del navegador. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Valor de `datetime-local` (hora del navegador) → instante UTC en ISO; null si está vacío o no es una fecha. */
export function fromLocalInput(v: string): string | null {
  if (v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A qué se vincula una tarea nueva (se fija al abrirla desde un contacto o una empresa). */
export interface TaskLink {
  contact?: { id: string; name: string };
  company?: { id: string; name: string };
}

/**
 * Alta y edición de una tarea (M3.6, ADR-48). El responsable solo se elige si la persona ve todos los contactos (`canAssign`); si no, la tarea es suya.
 * Editar y borrar los decide el servidor (`can_edit`); quien solo puede completarla la ve en modo lectura.
 */
export function TaskDialog({ task, link, owners, canAssign, onClose }: { task?: Task; link?: TaskLink; owners: OwnerOption[]; canAssign: boolean; onClose: () => void }) {
  const editing = Boolean(task);
  const readOnly = Boolean(task) && !task!.can_edit;
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [due, setDue] = useState(toLocalInput(task?.due_at ?? null));
  const [assignee, setAssignee] = useState(task?.assignee.id ?? '');
  const [titleError, setTitleError] = useState<string>();
  const [dueError, setDueError] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const create = useCreateTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const busy = create.isPending || update.isPending;
  const shown = task ? { contact: task.contact, company: task.company } : { contact: link?.contact ?? null, company: link?.company ?? null };

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const t = title.trim();
    const dueIso = fromLocalInput(due);
    const tErr = t === '' ? 'Escribe el título' : t.length > 200 ? 'Usa como máximo 200 caracteres' : undefined;
    const dErr = due !== '' && dueIso === null ? 'La fecha no es válida' : undefined;
    setTitleError(tErr);
    setDueError(dErr);
    if (tErr || dErr) return;
    const desc = description.trim();
    const input: TaskInput = { title: t, description: desc === '' ? null : desc, due_at: dueIso };
    const fail = (err: unknown) => setError(friendlyError(err, editing ? 'No pudimos guardar la tarea.' : 'No pudimos crear la tarea.'));
    if (task) {
      update.mutate({ id: task.id, input: { ...input, ...(canAssign && assignee !== '' && assignee !== task.assignee.id ? { assignee_id: assignee } : {}) } }, { onSuccess: onClose, onError: fail });
    } else {
      create.mutate(
        { ...input, ...(canAssign && assignee !== '' ? { assignee_id: assignee } : {}), ...(link?.contact ? { contact_id: link.contact.id } : {}), ...(link?.company ? { company_id: link.company.id } : {}) },
        { onSuccess: onClose, onError: fail },
      );
    }
  }

  const heading = editing ? (readOnly ? 'Tarea' : 'Editar tarea') : 'Nueva tarea';
  return (
    <Modal title={heading} onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={heading}>
        <Field label="Título" error={titleError}>
          {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoComplete="off" disabled={readOnly} autoFocus />}
        </Field>
        <label className="grid gap-1 text-[12.5px] font-semibold">Detalle <span className="font-normal text-muted">(opcional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} disabled={readOnly} className="w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-[13.5px] font-normal" />
        </label>
        <Field label="Vence" error={dueError} hint="Opcional. Hora de tu navegador.">
          {(p) => <Input {...p} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} disabled={readOnly} />}
        </Field>
        {canAssign && !readOnly ? (
          <Field label="Responsable" hint="Por defecto, tú.">
            {(p) => (
              <select {...p} value={assignee} onChange={(e) => setAssignee(e.target.value)} className={selectCls}>
                <option value="">{editing ? task!.assignee.name : 'Yo'}</option>
                {owners.filter((o) => o.id !== task?.assignee.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            )}
          </Field>
        ) : task ? <p className="text-[13px]"><span className="font-semibold">Responsable:</span> {task.assignee.name}</p> : null}
        {shown.contact || shown.company ? (
          <p className="text-[13px]"><span className="font-semibold">Vinculada a:</span> {shown.contact ? `contacto ${shown.contact.name}` : `empresa ${shown.company!.name}`}</p>
        ) : null}
        {readOnly ? <Alert kind="info">Solo quien creó la tarea o un administrador puede cambiarla. Puedes marcarla como hecha desde la lista.</Alert> : null}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {task && !readOnly ? (
            confirm ? (
              <span className="flex items-center gap-2 text-[13px]">¿Borrar esta tarea?
                <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={remove.isPending} onClick={() => remove.mutate(task.id, { onSuccess: onClose, onError: (err) => { setConfirm(false); setError(friendlyError(err, 'No pudimos borrar la tarea.')); } })}>Sí, borrar</Button>
                <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
              </span>
            ) : <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(true)}>Borrar tarea</Button>
          ) : <span />}
          <span className="flex gap-2">
            <Button onClick={onClose}>{readOnly ? 'Cerrar' : 'Cancelar'}</Button>
            {!readOnly ? <Button type="submit" variant="primary" loading={busy}>{editing ? 'Guardar' : 'Crear tarea'}</Button> : null}
          </span>
        </div>
      </form>
    </Modal>
  );
}
