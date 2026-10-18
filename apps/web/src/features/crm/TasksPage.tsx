import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Task } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { useOwners } from '../contacts/useContacts';
import { TaskDialog } from './TaskDialog';
import { TaskRow } from './TasksPanel';
import { DEFAULT_TASK_FILTERS, useTasks, type TaskFilters, type TaskStatusFilter } from './useCrm';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';
const STATUS_LABEL: Record<TaskStatusFilter, string> = { open: 'Pendientes', done: 'Hechas', all: 'Todas' };

/**
 * Tareas (M3.6, ADR-48). Por defecto, las pendientes asignadas a la persona. Quien ve todos los contactos puede ver las de toda la empresa o las de otra
 * persona; el resto solo ve las suyas (el servidor lo impone). Sin recordatorios por ahora: llegan con la Agenda.
 */
export function TasksPage() {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [dialog, setDialog] = useState<{ task?: Task } | null>(null);
  const q = useTasks(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const first = q.data?.pages[0];
  const viewAll = first?.access.view_all ?? false;
  const canWrite = first?.access.write ?? false;
  const total = first?.total ?? null;
  const owners = useOwners(viewAll);
  const set = (patch: Partial<TaskFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">Tareas</h1>
        {canWrite ? <Button variant="primary" onClick={() => setDialog({})}>Nueva tarea</Button> : null}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Estado de las tareas" className="flex gap-1.5">
          {(Object.keys(STATUS_LABEL) as TaskStatusFilter[]).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={filters.status === s} onClick={() => set({ status: s, overdue: s === 'done' ? false : filters.overdue })} className={`rounded-full border px-3 py-1 text-[13px] font-semibold ${filters.status === s ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>{STATUS_LABEL[s]}</button>
          ))}
        </div>
        {viewAll ? (
          <label className="grid gap-1 text-[12px] font-semibold">Responsable
            <select aria-label="Responsable de las tareas" value={filters.assignee} onChange={(e) => set({ assignee: e.target.value })} className={`${selectCls} font-normal`}>
              <option value="me">Mías</option>
              <option value="all">Todas las personas</option>
              {owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input type="checkbox" checked={filters.overdue} disabled={filters.status === 'done'} onChange={(e) => set({ overdue: e.target.checked })} />
          Solo vencidas
        </label>
      </div>
      {total !== null ? <p className="text-[12.5px] text-muted" aria-live="polite">{total === 1 ? '1 tarea' : `${total} tareas`}</p> : null}
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando tareas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las tareas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          {filters.overdue ? 'No tienes tareas vencidas.' : filters.status === 'done' ? 'Todavía no hay tareas hechas.' : canWrite ? 'No hay tareas pendientes. Crea una con «Nueva tarea».' : 'No hay tareas pendientes.'}
        </p>
      ) : null}
      <ul className="grid gap-2">{items.map((t) => <TaskRow key={t.id} task={t} onOpen={(task) => setDialog({ task })} />)}</ul>
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
      {dialog ? <TaskDialog {...(dialog.task ? { task: dialog.task } : {})} owners={owners.data ?? []} canAssign={viewAll} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
