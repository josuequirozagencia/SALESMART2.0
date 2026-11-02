import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { describeRecurrence, REMIND_OPTIONS, WEEKDAYS } from '../../lib/recurrence';
import type { OwnerOption, Task, TaskRecurrenceEnds } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useCreateTask, useDeleteTask, useUpdateTask, type RecurrenceInput, type TaskInput } from './useCrm';

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

type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';
const REPEAT_LABEL: Record<Repeat, string> = { none: 'No se repite', daily: 'Cada día', weekly: 'Cada semana', monthly: 'Cada mes' };
const UNIT: Record<Exclude<Repeat, 'none'>, string> = { daily: 'días', weekly: 'semanas', monthly: 'meses' };

/** La regla de una tarea tal como se manda al servidor (la que ya tiene, para saber si la persona la cambió). */
function inputOf(r: NonNullable<Task['recurrence']>): RecurrenceInput {
  return { freq: r.freq, interval: r.interval, ...(r.freq === 'weekly' && r.weekdays ? { weekdays: [...r.weekdays].sort((a, b) => a - b) } : {}), ends: r.ends };
}

/**
 * Alta y edición de una tarea (M3.6, ADR-48; F2, ADR-58: se puede repetir y avisar antes de que venza). El responsable solo se elige si la persona ve todos los contactos (`canAssign`); si no, la tarea
 * es suya. Editar y borrar los decide el servidor (`can_edit`); quien solo puede completarla la ve en modo lectura. Elegir «No se repite» en una tarea que se repite detiene la repetición.
 */
export function TaskDialog({ task, link, owners, canAssign, onClose }: { task?: Task; link?: TaskLink; owners: OwnerOption[]; canAssign: boolean; onClose: () => void }) {
  const editing = Boolean(task);
  const readOnly = Boolean(task) && !task!.can_edit;
  const open = !task || task.status === 'open';
  const rec = task?.recurrence ?? null;
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [due, setDue] = useState(toLocalInput(task?.due_at ?? null));
  const [assignee, setAssignee] = useState(task?.assignee.id ?? '');
  const [repeat, setRepeat] = useState<Repeat>(rec?.freq ?? 'none');
  const [every, setEvery] = useState(String(rec?.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(rec?.weekdays ?? []);
  const [endsKind, setEndsKind] = useState<TaskRecurrenceEnds['kind']>(rec?.ends.kind ?? 'never');
  const [endsOn, setEndsOn] = useState(rec?.ends.kind === 'on' ? rec.ends.date : '');
  const [endsAfter, setEndsAfter] = useState(rec?.ends.kind === 'after' ? String(rec.ends.count) : '10');
  const [remind, setRemind] = useState<number | null>(task?.remind_before_minutes ?? null);
  const [titleError, setTitleError] = useState<string>();
  const [dueError, setDueError] = useState<string>();
  const [everyError, setEveryError] = useState<string>();
  const [endsError, setEndsError] = useState<string>();
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
    let dErr = due !== '' && dueIso === null ? 'La fecha no es válida' : undefined;
    const repeating = repeat !== 'none' && open;
    if (repeating && dueIso === null && !dErr) dErr = 'Una tarea que se repite necesita fecha de vencimiento';
    const n = Number(every);
    const nErr = repeating && !(Number.isInteger(n) && n >= 1 && n <= 30) ? 'Usa un número de 1 a 30' : undefined;
    const count = Number(endsAfter);
    const eErr = repeating && ((endsKind === 'on' && endsOn === '') || (endsKind === 'after' && !(Number.isInteger(count) && count >= 2 && count <= 365)))
      ? endsKind === 'on' ? 'Elige la fecha en que termina' : 'Usa un número de 2 a 365'
      : undefined;
    setTitleError(tErr);
    setDueError(dErr);
    setEveryError(nErr);
    setEndsError(eErr);
    if (tErr || dErr || nErr || eErr) return;
    const desc = description.trim();
    const input: TaskInput = { title: t, description: desc === '' ? null : desc, due_at: dueIso };
    const ends: TaskRecurrenceEnds = endsKind === 'on' ? { kind: 'on', date: endsOn } : endsKind === 'after' ? { kind: 'after', count } : { kind: 'never' };
    const rule: RecurrenceInput | null = repeating ? { freq: repeat, interval: n, ...(repeat === 'weekly' && weekdays.length > 0 ? { weekdays: [...weekdays].sort((a, b) => a - b) } : {}), ends } : null;
    const fail = (err: unknown) => setError(friendlyError(err, editing ? 'No pudimos guardar la tarea.' : 'No pudimos crear la tarea.'));
    if (task) {
      // Solo se manda lo que la persona cambió de la repetición y del aviso
      const recurrence: { recurrence?: RecurrenceInput | null } = open && rule === null && rec ? { recurrence: null } : rule && JSON.stringify(rule) !== JSON.stringify(rec ? inputOf(rec) : null) ? { recurrence: rule } : {};
      const reminder: { remind_before_minutes?: number | null } = remind !== (task.remind_before_minutes ?? null) ? { remind_before_minutes: remind } : {};
      update.mutate({ id: task.id, input: { ...input, ...recurrence, ...reminder, ...(canAssign && assignee !== '' && assignee !== task.assignee.id ? { assignee_id: assignee } : {}) } }, { onSuccess: onClose, onError: fail });
    } else {
      create.mutate(
        {
          ...input,
          ...(rule ? { recurrence: rule } : {}),
          ...(remind !== null ? { remind_before_minutes: remind } : {}),
          ...(canAssign && assignee !== '' ? { assignee_id: assignee } : {}),
          ...(link?.contact ? { contact_id: link.contact.id } : {}),
          ...(link?.company ? { company_id: link.company.id } : {}),
        },
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
        {open ? (
          <>
            {readOnly ? (
              rec ? <p className="text-[13px]"><span className="font-semibold">Se repite:</span> {describeRecurrence(rec)}</p> : null
            ) : (
              <>
                <Field label="Repetir" hint={rec && repeat === 'none' ? 'Al guardar se detiene la repetición; esta tarea queda como única.' : 'La siguiente nace al completar esta.'}>
                  {(p) => (
                    <select {...p} value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} className={selectCls}>
                      {(Object.keys(REPEAT_LABEL) as Repeat[]).map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}
                    </select>
                  )}
                </Field>
                {repeat !== 'none' ? (
                  <div className="grid gap-3 rounded-xl border border-line p-3">
                    <Field label="Cada" error={everyError} hint={UNIT[repeat]}>
                      {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={30} value={every} onChange={(e) => setEvery(e.target.value)} />}
                    </Field>
                    {repeat === 'weekly' ? (
                      <fieldset className="grid gap-1.5">
                        <legend className="text-[12.5px] font-semibold">Días de la semana <span className="font-normal text-muted">(si no eliges, el del vencimiento)</span></legend>
                        <div className="flex flex-wrap gap-1.5">
                          {WEEKDAYS.map((d) => (
                            <label key={d.value} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px]">
                              <input type="checkbox" checked={weekdays.includes(d.value)} onChange={(e) => setWeekdays((cur) => (e.target.checked ? [...cur, d.value] : cur.filter((x) => x !== d.value)))} aria-label={d.long} />
                              {d.short}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ) : null}
                    {repeat === 'monthly' ? <p className="text-[12.5px] text-muted">Se repite el mismo día del mes que el vencimiento (si el mes no lo tiene, el último día).</p> : null}
                    <Field label="Termina" error={endsError}>
                      {(p) => (
                        <select {...p} value={endsKind} onChange={(e) => setEndsKind(e.target.value as TaskRecurrenceEnds['kind'])} className={selectCls}>
                          <option value="never">Nunca</option>
                          <option value="on">El día…</option>
                          <option value="after">Después de cierto número de veces</option>
                        </select>
                      )}
                    </Field>
                    {endsKind === 'on' ? <Field label="Fecha en que termina">{(p) => <Input {...p} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}</Field> : null}
                    {endsKind === 'after' ? <Field label="Número de veces" hint="Contando la primera.">{(p) => <Input {...p} type="number" inputMode="numeric" min={2} max={365} value={endsAfter} onChange={(e) => setEndsAfter(e.target.value)} />}</Field> : null}
                  </div>
                ) : null}
              </>
            )}
            {!readOnly ? (
              <Field label="Avisarme" hint="Recibirás un aviso en la campana. Necesita fecha de vencimiento.">
                {(p) => (
                  <select {...p} value={remind === null ? '' : String(remind)} onChange={(e) => setRemind(e.target.value === '' ? null : Number(e.target.value))} className={selectCls}>
                    {REMIND_OPTIONS.map((o) => <option key={String(o.value)} value={o.value === null ? '' : String(o.value)}>{o.label}</option>)}
                  </select>
                )}
              </Field>
            ) : null}
          </>
        ) : null}
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
              <span className="flex items-center gap-2 text-[13px]">{rec ? '¿Borrar esta tarea? La repetición termina.' : '¿Borrar esta tarea?'}
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
