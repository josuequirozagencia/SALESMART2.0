import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import type { Task } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { useOwners } from '../contacts/useContacts';
import { ScheduledMessagesPanel } from '../inbox/ScheduledOverviewPage';
import { TaskDialog } from './TaskDialog';
import { completionNotice, TaskRow } from './TasksPanel';
import { DEFAULT_TASK_FILTERS, useTask, useTasks, type TaskFilters, type TaskStatusFilter } from './useCrm';
import { PAGE_TITLE } from '../../ui/PageHeader';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';
const STATUS_LABEL: Record<TaskStatusFilter, string> = { open: 'Pendientes', done: 'Hechas', all: 'Todas' };

/**
 * Tareas (M3.6, ADR-48). Por defecto, las pendientes asignadas a la persona. Quien ve todos los contactos puede ver las de toda la empresa o las de otra
 * persona; el resto solo ve las suyas (el servidor lo impone). Las tareas se pueden repetir y avisan a su responsable (F2, ADR-58); `?task=<id>` abre una tarea (los avisos de la campana enlazan así).
 */
export function TasksPage() {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [dialog, setDialog] = useState<{ task?: Task } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const wanted = params.get('task');
  // v13 S2.3: los mensajes programados (antes, la pantalla `/inbox/scheduled`) son una pestaña de esta pantalla: `?tab=scheduled`
  const tab: 'tasks' | 'scheduled' = params.get('tab') === 'scheduled' ? 'scheduled' : 'tasks';
  const pickTab = (t: 'tasks' | 'scheduled'): void => setParams(t === 'scheduled' ? { tab: 'scheduled' } : {}, { replace: true });
  const one = useTask(wanted);
  const q = useTasks(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const first = q.data?.pages[0];
  const viewAll = first?.access.view_all ?? false;
  const canWrite = first?.access.write ?? false;
  const total = first?.total ?? null;
  const owners = useOwners(viewAll);
  const set = (patch: Partial<TaskFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const shown = dialog ?? (one.data ? { task: one.data } : null);
  const closeDialog = () => {
    setDialog(null);
    if (wanted) setParams({}, { replace: true });
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className={PAGE_TITLE}>Tareas</h1>
        {canWrite && tab === 'tasks' ? <Button variant="primary" onClick={() => setDialog({})}>Nueva tarea</Button> : null}
      </div>
      <div role="tablist" aria-label="Sección" className="flex gap-1.5 border-b border-line pb-2">
        {([['tasks', 'Tareas'], ['scheduled', 'Mensajes programados']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => pickTab(id)} className={`rounded-full border px-4 py-1.5 text-[13px] font-semibold ${tab === id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>{label}</button>
        ))}
      </div>
      {tab === 'scheduled' ? <ScheduledMessagesPanel /> : null}
      {tab === 'tasks' ? (
      <>
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
      {wanted && one.isError ? <Alert>No encontramos esa tarea: quizá ya no es tuya o se borró. <Button variant="link" onClick={() => setParams({}, { replace: true })}>Cerrar aviso</Button></Alert> : null}
      {notice ? <p role="status" className="rounded-xl bg-accent-soft px-3 py-2 text-[13px]">{notice}</p> : null}
      {total !== null ? <p className="text-[12.5px] text-muted" aria-live="polite">{total === 1 ? '1 tarea' : `${total} tareas`}</p> : null}
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando tareas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las tareas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          {filters.overdue ? 'No tienes tareas vencidas.' : filters.status === 'done' ? 'Todavía no hay tareas hechas.' : canWrite ? 'No hay tareas pendientes. Crea una con «Nueva tarea».' : 'No hay tareas pendientes.'}
        </p>
      ) : null}
      <ul className="grid gap-2">{items.map((t) => <TaskRow key={t.id} task={t} onOpen={(task) => setDialog({ task })} onCompleted={(done) => setNotice(completionNotice(done))} />)}</ul>
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
      {shown ? <TaskDialog key={shown.task?.id ?? 'new'} {...(shown.task ? { task: shown.task } : {})} owners={owners.data ?? []} canAssign={viewAll} onClose={closeDialog} /> : null}
      </>
      ) : null}
    </div>
  );
}
