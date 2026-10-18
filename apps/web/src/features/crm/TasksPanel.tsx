import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { OwnerOption, Task } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { TaskDialog, type TaskLink } from './TaskDialog';
import { useSetTaskDone, useTasks, type TaskStatusFilter } from './useCrm';

/** Una tarea en una lista: casilla para completarla, título (abre el detalle), vencimiento, responsable y a qué está vinculada. */
export function TaskRow({ task, onOpen, showLink = true }: { task: Task; onOpen: (t: Task) => void; showLink?: boolean }) {
  const toggle = useSetTaskDone();
  const done = task.status === 'done';
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <input
        type="checkbox"
        className="mt-1"
        checked={done}
        disabled={!task.can_complete || toggle.isPending}
        aria-label={done ? `Reabrir la tarea «${task.title}»` : `Marcar «${task.title}» como hecha`}
        onChange={() => toggle.mutate({ id: task.id, done: !done })}
      />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <button type="button" onClick={() => onOpen(task)} className={`truncate text-left text-[14px] font-semibold hover:underline ${done ? 'text-muted line-through' : ''}`} aria-label={`Abrir la tarea ${task.title}`}>{task.title}</button>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          {task.due_at ? <span className={task.overdue ? 'font-semibold text-crit' : ''}>{task.overdue ? 'Vencida · ' : 'Vence '}{shortDateTime(task.due_at)}</span> : <span>Sin fecha</span>}
          <span>{task.assignee.name}</span>
          {showLink && task.contact ? <span>Contacto: {task.contact.name}</span> : null}
          {showLink && task.company ? <span>Empresa: {task.company.name}</span> : null}
          {done && task.completed_at ? <Pill kind="ok">Hecha</Pill> : null}
        </span>
      </div>
      {toggle.isError ? <span role="alert" className="text-[12px] text-crit">{friendlyError(toggle.error, 'No pudimos actualizar la tarea.')}</span> : null}
    </li>
  );
}

/**
 * Tareas de un contacto o de una empresa (M3.6, ADR-48), dentro de su ficha. Quien ve todo (`viewAll`) ve las de todos; el resto, las suyas.
 * Crear una tarea desde aquí la deja vinculada.
 */
export function TasksPanel({ link, canWrite, viewAll, owners }: { link: TaskLink; canWrite: boolean; viewAll: boolean; owners: OwnerOption[] }) {
  const [status, setStatus] = useState<TaskStatusFilter>('open');
  const [dialog, setDialog] = useState<{ task?: Task } | null>(null);
  const q = useTasks({ status, assignee: viewAll ? 'all' : 'me', overdue: false, contact: link.contact?.id, company: link.company?.id });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-label="Tareas" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[12.5px] font-semibold">Mostrar
          <select aria-label="Estado de las tareas" value={status} onChange={(e) => setStatus(e.target.value as TaskStatusFilter)} className="rounded-[10px] border border-line bg-surface px-2.5 py-1.5 text-[13px] font-normal">
            <option value="open">Pendientes</option>
            <option value="done">Hechas</option>
            <option value="all">Todas</option>
          </select>
        </label>
        {canWrite ? <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setDialog({})}>Nueva tarea</Button> : null}
      </div>
      {q.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Cargando tareas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las tareas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">{status === 'done' ? 'No hay tareas hechas.' : 'No hay tareas pendientes.'}</p> : null}
      <ul className="grid gap-2">{items.map((t) => <TaskRow key={t.id} task={t} showLink={false} onOpen={(task) => setDialog({ task })} />)}</ul>
      {q.hasNextPage ? <div><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
      {dialog ? <TaskDialog {...(dialog.task ? { task: dialog.task } : { link })} owners={owners} canAssign={viewAll} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}
