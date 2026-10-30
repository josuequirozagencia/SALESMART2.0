import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { initials } from '../../lib/format';
import type { Queue, QueueMode, WeekHours } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { cloneWeek, defaultWeek, sameWeek, validateWeek } from '../sla/hours';
import { HoursEditor } from '../sla/HoursEditor';
import { useSaveQueueHours } from '../sla/useSla';
import { ColorPicker, DEFAULT_QUEUE_COLOR } from './ColorPicker';
import { MODE_LABEL } from './QueueDialog';
import { useQueues, useSetQueueMembers, useUpdateQueue, useCreateQueue } from './useQueues';

const STEPS = ['Nombre', 'Equipo', 'Horario', 'Reparto'] as const;
const intIn = (v: string, min: number, max: number): number | null => (/^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max ? Number(v) : null);

/**
 * Asistente para crear un departamento (M10.1, ADR-56): nombre y color → equipo → horario → reparto. **Cada paso guarda al avanzar**: el departamento nace al terminar el primer
 * paso (con el reparto apagado) y, si se cierra el asistente a medias, queda un departamento válido que se completa en su configuración. Usa las mismas APIs de siempre
 * (`/queues`); en el código y la API el departamento sigue llamándose `queue`.
 */
export function DepartmentWizard({ onClose, onFinished }: { onClose: () => void; onFinished: (queueId: string | null) => void }) {
  const [step, setStep] = useState(0);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const list = useQueues();
  const queue: Queue | undefined = createdId ? list.data?.items.find((q) => q.id === createdId) : undefined;
  const create = useCreateQueue();
  const update = useUpdateQueue();
  const setMembers = useSetQueueMembers();
  const saveHours = useSaveQueueHours();

  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_QUEUE_COLOR);
  const [picked, setPicked] = useState<Record<string, boolean> | null>(null);
  const [ownHours, setOwnHours] = useState(false);
  const [week, setWeek] = useState<WeekHours>(() => defaultWeek());
  const [on, setOn] = useState(false);
  const [mode, setMode] = useState<QueueMode>('equal');
  const [batch, setBatch] = useState('1');
  const [cap, setCap] = useState('0');
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const members = queue?.members ?? [];
  const chosen = picked ?? Object.fromEntries(members.map((m) => [m.user_id, m.active]));
  const fail = (e: unknown, fallback: string): void => setError(friendlyError(e, fallback));

  async function saveStep(): Promise<boolean> {
    setError(undefined);
    setFieldError(undefined);
    try {
      if (step === 0) {
        const n = name.trim();
        if (n === '') { setFieldError('Escribe el nombre del departamento'); return false; }
        if (n.length > 60) { setFieldError('Usa como máximo 60 caracteres'); return false; }
        if (!createdId) {
          const q = await create.mutateAsync({ name: n, color });
          setCreatedId(q.id);
        } else if (queue && (n !== queue.name || color !== queue.color)) {
          await update.mutateAsync({ id: createdId, input: { name: n, color } });
        }
      } else if (step === 1 && queue) {
        const changed = members.some((m) => (chosen[m.user_id] ?? false) !== m.active);
        if (changed) await setMembers.mutateAsync({ id: queue.id, members: members.map((m) => ({ user_id: m.user_id, active: chosen[m.user_id] ?? false, weight: m.weight })) });
      } else if (step === 2 && queue) {
        const days = ownHours ? week : null;
        if (ownHours) {
          const problem = validateWeek(week);
          if (problem) { setError(problem); return false; }
        }
        if (!sameWeek(days, queue.hours)) await saveHours.mutateAsync({ id: queue.id, days });
      } else if (step === 3 && queue) {
        const b = intIn(batch, 1, 50);
        const c = intIn(cap, 0, 1000);
        if (b === null || c === null) { setError('Revisa los números: seguidas entre 1 y 50 y tope entre 0 y 1000 (0 = sin tope)'); return false; }
        await update.mutateAsync({ id: queue.id, input: { distribution_on: on, mode, batch: b, daily_cap: c } });
      }
      return true;
    } catch (e) {
      fail(e, 'No pudimos guardar este paso.');
      return false;
    }
  }

  async function next(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    setBusy(true);
    const ok = await saveStep();
    setBusy(false);
    if (!ok) return;
    if (step === STEPS.length - 1) onFinished(createdId);
    else setStep(step + 1);
  }

  const last = step === STEPS.length - 1;
  return (
    <Modal title="Nuevo departamento" onClose={onClose} wide>
      <ol aria-label="Pasos" className="flex flex-wrap gap-2 text-[12.5px] font-semibold">
        {STEPS.map((s, i) => (
          <li key={s} {...(i === step ? { 'aria-current': 'step' as const } : {})} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${i === step ? 'border-accent bg-accent-soft text-accent' : i < step ? 'border-line text-fg' : 'border-line text-muted'}`}>
            <span aria-hidden="true">{i < step ? '✓' : i + 1}</span>{s}
          </li>
        ))}
      </ol>
      <p className="text-[12.5px] text-muted" aria-live="polite">Paso {step + 1} de {STEPS.length}. Cada paso se guarda al avanzar: puedes cerrar cuando quieras y seguir después desde la configuración del departamento.</p>

      <form onSubmit={(e) => void next(e)} noValidate className="grid gap-3" aria-label={`Paso ${step + 1}: ${STEPS[step]}`}>
        {step === 0 ? (
          <>
            <Field label="Nombre" error={fieldError} hint="Un equipo o área, por ejemplo «Ventas» o «Soporte».">
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" autoFocus />}
            </Field>
            <div className="grid gap-1.5 text-[12.5px] font-semibold">Color<ColorPicker value={color} onChange={setColor} /></div>
          </>
        ) : null}

        {step === 1 ? (
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-[13px] font-semibold">¿Quiénes atienden este departamento?</legend>
            {!queue ? <p className="text-[12.5px] text-muted">Cargando el equipo…</p> : members.length === 0 ? <p className="text-[12.5px] text-muted">Todavía no hay personas que puedan recibir conversaciones. Invítalas desde Usuarios y vuelve aquí.</p> : null}
            <ul className="grid max-h-64 gap-1.5 overflow-y-auto">
              {members.map((m) => (
                <li key={m.user_id}>
                  <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-xl border border-line px-3 text-[13.5px]">
                    <input type="checkbox" aria-label={`${m.name} atiende este departamento`} checked={chosen[m.user_id] ?? false} onChange={(e) => setPicked({ ...chosen, [m.user_id]: e.target.checked })} />
                    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">{initials(m.name)}</span>
                    <span className="truncate font-semibold">{m.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-muted">Los pesos de cada persona se ajustan después, en la configuración completa.</p>
          </fieldset>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-3">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[13px] font-semibold">¿Cuándo atiende este departamento?</legend>
              <label className="flex items-start gap-2 text-[13.5px]">
                <input type="radio" name="hours" checked={!ownHours} onChange={() => setOwnHours(false)} className="mt-1" />
                <span><b>Usar el horario de la empresa</b><span className="block text-[12px] text-muted">El de Configuración › SLA y horario.</span></span>
              </label>
              <label className="flex items-start gap-2 text-[13.5px]">
                <input type="radio" name="hours" checked={ownHours} onChange={() => { setOwnHours(true); if (queue?.hours) setWeek(cloneWeek(queue.hours)); }} className="mt-1" />
                <span><b>Horario propio</b><span className="block text-[12px] text-muted">Manda sobre el de la empresa para este departamento.</span></span>
              </label>
            </fieldset>
            {ownHours ? <HoursEditor value={week} onChange={setWeek} /> : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="grid gap-3">
            <label className="flex items-start gap-2 text-[13.5px] font-semibold">
              <input type="checkbox" aria-label="Repartir las conversaciones nuevas automáticamente" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-1" />
              <span>Repartir las conversaciones nuevas automáticamente<span className="block text-[12px] font-normal text-muted">{on ? 'Cada conversación nueva de las conexiones de este departamento se asigna a una persona del equipo.' : 'Con el reparto apagado las conversaciones quedan «sin asignar» hasta que alguien las tome.'}</span></span>
            </label>
            {on && Object.values(chosen).every((v) => !v) ? <Alert kind="info">Elegiste repartir pero no hay nadie en el equipo: el reparto no podrá asignar. Vuelve al paso «Equipo».</Alert> : null}
            {on ? (
              <div className="grid items-start gap-3 sm:grid-cols-2">
                <Field label="Cómo repartir">
                  {(p) => (
                    <select {...p} value={mode} onChange={(e) => setMode(e.target.value as QueueMode)} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg">
                      {(Object.keys(MODE_LABEL) as QueueMode[]).map((k) => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}
                    </select>
                  )}
                </Field>
                {mode !== 'load' ? <Field label="Conversaciones seguidas por persona" hint="Con 1 es rotación pura.">{(p) => <Input {...p} inputMode="numeric" value={batch} onChange={(e) => setBatch(e.target.value)} />}</Field> : null}
                <Field label="Tope diario por persona" hint="0 = sin tope.">{(p) => <Input {...p} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />}</Field>
              </div>
            ) : null}
            <p className="text-[12px] text-muted">El catálogo de productos, los mensajes automáticos y la reasignación por falta de respuesta están en la configuración completa del departamento.</p>
          </div>
        ) : null}

        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" onClick={onClose}>{createdId ? 'Cerrar' : 'Cancelar'}</Button>
          <span className="flex flex-wrap gap-2">
            {step > 0 ? <Button type="button" disabled={busy} onClick={() => { setError(undefined); setStep(step - 1); }}>Atrás</Button> : null}
            {step > 0 && !last ? <Button type="button" disabled={busy} onClick={() => { setError(undefined); setStep(step + 1); }}>Saltar este paso</Button> : null}
            <Button type="submit" variant="primary" loading={busy}>{last ? 'Terminar' : 'Siguiente'}</Button>
          </span>
        </div>
      </form>
    </Modal>
  );
}
