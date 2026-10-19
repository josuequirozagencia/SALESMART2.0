import { useEffect, useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { initials } from '../../lib/format';
import type { Queue, QueueMemberInput, QueueMode, QueueSettings, QueueSimulation } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { ColorPicker } from './ColorPicker';
import { useArchiveQueue, useDistributeQueue, useSetQueueMembers, useSimulateQueue, useUpdateQueue } from './useQueues';

export const MODE_LABEL: Record<QueueMode, string> = { equal: 'Rotación', weighted: 'Ponderado por peso', load: 'Menos conversaciones abiertas' };
/** Nombre corto del modo (tarjetas). */
export const MODE_SHORT: Record<QueueMode, string> = { equal: 'Rotación', weighted: 'Ponderado', load: 'Por carga' };
const ROLE_LABEL: Record<string, string> = { client_admin: 'Administrador', advisor: 'Asesor' };
const SIM_COUNT = 20;

interface MemberState { active: boolean; weight: string }
const toMemberState = (q: Queue): Record<string, MemberState> => Object.fromEntries(q.members.map((m) => [m.user_id, { active: m.active, weight: String(m.weight) }]));
const intIn = (v: string, min: number, max: number): number | null => (/^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max ? Number(v) : null);

/**
 * Configuración de una cola (M5.3, ADR-07): nombre y color, quiénes participan y con qué peso, cómo se reparten las conversaciones nuevas, un simulador y los
 * «sin asignar». Lo que se edita se guarda con «Guardar»; el simulador usa lo que hay en pantalla (no guarda nada). El horario, el reasignar por falta de
 * respuesta y los mensajes automáticos de la cola llegan con el SLA (M5.5).
 */
export function QueueDialog({ queue, onClose }: { queue: Queue; onClose: () => void }) {
  const [name, setName] = useState(queue.name);
  const [color, setColor] = useState(queue.color);
  const [on, setOn] = useState(queue.distribution_on);
  const [mode, setMode] = useState<QueueMode>(queue.mode);
  const [batch, setBatch] = useState(String(queue.batch));
  const [cap, setCap] = useState(String(queue.daily_cap));
  const [onlyNew, setOnlyNew] = useState(queue.only_unassigned);
  const [members, setMembers] = useState(() => toMemberState(queue));
  const [errors, setErrors] = useState<Partial<Record<'name' | 'batch' | 'cap' | 'weights', string>>>({});
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [sim, setSim] = useState<QueueSimulation>();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const update = useUpdateQueue();
  const setMembersMut = useSetQueueMembers();
  const archive = useArchiveQueue();
  const simulate = useSimulateQueue();
  const distribute = useDistributeQueue();

  // Después de guardar, la pantalla vuelve a mostrar lo que quedó en el servidor. Solo cuando la cola cambió de verdad: una actualización de las cifras de
  // fondo (sin asignar, carga de los asesores) no debe borrar lo que la persona está escribiendo.
  const synced = useRef(queue.updated_at);
  useEffect(() => {
    if (synced.current === queue.updated_at) return;
    synced.current = queue.updated_at;
    setName(queue.name); setColor(queue.color); setOn(queue.distribution_on); setMode(queue.mode); setBatch(String(queue.batch)); setCap(String(queue.daily_cap)); setOnlyNew(queue.only_unassigned); setMembers(toMemberState(queue));
  }, [queue]);

  const active = queue.members.filter((m) => members[m.user_id]?.active);
  const weightOf = (id: string): number => (mode === 'weighted' ? (intIn(members[id]?.weight ?? '1', 1, 100) ?? 1) : 1);
  const totalWeight = active.reduce((s, m) => s + weightOf(m.user_id), 0);

  /** Lo que hay en pantalla como valores ya validados, o los errores de cada campo. */
  function read(): { settings: QueueSettings; members: QueueMemberInput[] } | null {
    const next: typeof errors = {};
    const n = name.trim();
    if (n === '') next.name = 'Escribe el nombre de la cola';
    else if (n.length > 60) next.name = 'Usa como máximo 60 caracteres';
    const b = intIn(batch, 1, 50);
    if (b === null) next.batch = 'Un número entero entre 1 y 50';
    const c = intIn(cap, 0, 1000);
    if (c === null) next.cap = 'Un número entero entre 0 y 1000 (0 = sin tope)';
    const list: QueueMemberInput[] = queue.members.map((m) => ({ user_id: m.user_id, active: members[m.user_id]?.active ?? false, weight: intIn(members[m.user_id]?.weight ?? '1', 1, 100) ?? 0 }));
    if (list.some((m) => m.weight === 0)) next.weights = 'El peso de cada asesor es un número entero entre 1 y 100';
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    const settings: QueueSettings = {};
    if (n !== queue.name) settings.name = n;
    if (color !== queue.color) settings.color = color;
    if (on !== queue.distribution_on) settings.distribution_on = on;
    if (mode !== queue.mode) settings.mode = mode;
    if (b !== queue.batch) settings.batch = b!;
    if (c !== queue.daily_cap) settings.daily_cap = c!;
    if (onlyNew !== queue.only_unassigned) settings.only_unassigned = onlyNew;
    return { settings, members: list };
  }

  async function save() {
    setNote(undefined);
    setError(undefined);
    const v = read();
    if (!v) return;
    const membersChanged = v.members.some((m, i) => m.active !== queue.members[i]!.active || m.weight !== queue.members[i]!.weight);
    try {
      if (Object.keys(v.settings).length > 0) await update.mutateAsync({ id: queue.id, input: v.settings });
      if (membersChanged) await setMembersMut.mutateAsync({ id: queue.id, members: v.members });
      setNote(Object.keys(v.settings).length > 0 || membersChanged ? 'Cambios guardados.' : 'No había cambios que guardar.');
    } catch (e) {
      setError(friendlyError(e, 'No pudimos guardar los cambios.'));
    }
  }

  function runSimulation() {
    setError(undefined);
    const v = read();
    if (!v) return;
    simulate.mutate(
      { id: queue.id, input: { count: SIM_COUNT, mode, batch: v.settings.batch ?? queue.batch, daily_cap: v.settings.daily_cap ?? queue.daily_cap, members: v.members.filter((m) => m.active) } },
      { onSuccess: setSim, onError: (e) => setError(friendlyError(e, 'No pudimos simular el reparto.')) },
    );
  }

  const busy = update.isPending || setMembersMut.isPending;
  return (
    <Modal title={`Configurar ${queue.name}`} onClose={onClose} wide>
      <div className="grid max-h-[72vh] gap-4 overflow-y-auto pr-1" aria-label={`Configuración de ${queue.name}`}>
        <section className="grid gap-3" aria-label="General">
          <Field label="Nombre de la cola" error={errors.name}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />}</Field>
          <div className="grid gap-1.5 text-[12.5px] font-semibold">Color<ColorPicker value={color} onChange={setColor} /></div>
        </section>

        <section className="grid gap-3 rounded-2xl border border-line p-4" aria-label="Reparto de conversaciones">
          <label className="flex items-start gap-2 text-[13.5px] font-semibold">
            <input type="checkbox" aria-label="Repartir las conversaciones nuevas automáticamente" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-1" />
            <span>Repartir las conversaciones nuevas automáticamente<span className="block text-[12px] font-normal text-muted">{on ? 'Cada conversación nueva de las conexiones de esta cola se asigna a un asesor según esta regla.' : 'Con el reparto apagado las conversaciones quedan «sin asignar» hasta que alguien las tome.'}</span></span>
          </label>

          <div className="grid gap-1" aria-label="Asesores de la cola">
            <span className="text-[12.5px] font-semibold">Asesores de la cola</span>
            {queue.members.length === 0 ? <p className="text-[12.5px] text-muted">Todavía no hay personas que puedan recibir conversaciones.</p> : null}
            <ul className="grid gap-1.5">
              {queue.members.map((m) => {
                const st = members[m.user_id] ?? { active: false, weight: '1' };
                return (
                  <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
                    <label className="flex min-w-0 items-center gap-2 text-[13.5px]">
                      <input type="checkbox" aria-label={`${m.name} participa`} checked={st.active} onChange={(e) => setMembers((cur) => ({ ...cur, [m.user_id]: { ...st, active: e.target.checked } }))} />
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent" aria-hidden="true">{initials(m.name)}</span>
                      <span className="truncate font-semibold">{m.name}</span>
                      <Pill kind="muted">{ROLE_LABEL[m.role] ?? m.role}</Pill>
                    </label>
                    <span className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
                      <span>{m.open_count} abiertas · {m.today_count} hoy</span>
                      {mode === 'weighted' && st.active ? (
                        <label className="flex items-center gap-1">Peso <input aria-label={`Peso de ${m.name}`} inputMode="numeric" value={st.weight} onChange={(e) => setMembers((cur) => ({ ...cur, [m.user_id]: { ...st, weight: e.target.value } }))} className="w-16 rounded-lg border border-line bg-surface px-2 py-1 text-[13px] text-fg" /></label>
                      ) : null}
                      {st.active && totalWeight > 0 ? <span className="w-10 text-right font-mono">{Math.round((weightOf(m.user_id) / totalWeight) * 100)} %</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {errors.weights ? <span role="alert" className="text-[12px] font-medium text-crit">{errors.weights}</span> : null}
            {active.length === 0 ? <p className="text-[12.5px] text-muted">Elige al menos un asesor para que el reparto pueda asignar.</p> : null}
          </div>

          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label="Cómo repartir">
              {(p) => (
                <select {...p} value={mode} onChange={(e) => setMode(e.target.value as QueueMode)} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg">
                  {(Object.keys(MODE_LABEL) as QueueMode[]).map((k) => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}
                </select>
              )}
            </Field>
            {mode !== 'load' ? (
              <Field label="Conversaciones seguidas por asesor" error={errors.batch} hint="Cuántas recibe un asesor antes de pasar al siguiente. Con 1 es rotación pura.">
                {(p) => <Input {...p} inputMode="numeric" value={batch} onChange={(e) => setBatch(e.target.value)} />}
              </Field>
            ) : null}
            <Field label="Tope diario por asesor" error={errors.cap} hint="Conversaciones nuevas que puede recibir por día de esta cola. 0 = sin tope.">
              {(p) => <Input {...p} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />}
            </Field>
          </div>

          <label className="flex items-start gap-2 text-[13.5px]">
            <input type="checkbox" aria-label="Aplicar solo a contactos sin dueño" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} className="mt-1" />
            <span><b>Aplicar solo a contactos sin dueño</b><span className="block text-[12px] text-muted">Si el contacto ya tiene dueño, la conversación va a él y no entra al reparto. El primer reparto de un contacto sin dueño se lo da al asesor elegido.</span></span>
          </label>

          <div className="grid gap-2">
            <div><Button onClick={runSimulation} loading={simulate.isPending}>Simular {SIM_COUNT} conversaciones</Button></div>
            {sim ? (
              <div role="region" aria-label="Resultado de la simulación" className="grid gap-1.5 rounded-xl bg-surface2 p-3 text-[12.5px]">
                {sim.sequence.length === 0 ? <span>No hay a quién asignar: elige al menos un asesor.</span> : (
                  <>
                    <span>{sim.counts.filter((c) => c.count > 0).map((c) => `${c.name}: ${c.count}`).join(' · ')}</span>
                    <span className="flex flex-wrap gap-1" aria-label="Orden de asignación">{sim.sequence.map((s, i) => <span key={i} title={s.name} className="grid size-6 place-items-center rounded-full bg-accent-soft text-[10px] font-bold text-accent">{initials(s.name)}</span>)}</span>
                  </>
                )}
                {sim.stopped_early && sim.sequence.length > 0 ? <span className="text-muted">Se detuvo en {sim.sequence.length}: nadie más podía recibir por el tope diario.</span> : null}
                {mode === 'load' ? <span className="text-muted">Con «menos conversaciones abiertas» el orden real depende de la carga de cada asesor en ese momento.</span> : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="grid gap-2 rounded-2xl border border-line p-4" aria-label="Sin asignar">
          <span className="text-[13.5px] font-semibold">Conversaciones sin asignar: {queue.unassigned_count}</span>
          <p className="text-[12.5px] text-muted">Las que llegaron con el reparto apagado, sin asesores disponibles o antes de enlazar la conexión. Encender el reparto no las reasigna: hazlo aquí cuando quieras.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={queue.unassigned_count === 0 || !queue.distribution_on} loading={distribute.isPending} onClick={() => { setNote(undefined); setError(undefined); distribute.mutate(queue.id, { onSuccess: (r) => setNote(`Se asignaron ${r.assigned} conversaciones; quedan ${r.remaining} sin asignar.`), onError: (e) => setError(friendlyError(e, 'No pudimos repartir.')) }); }}>Repartir ahora</Button>
            {!queue.distribution_on && queue.unassigned_count > 0 ? <span className="text-[12px] text-muted">Enciende y guarda el reparto para poder repartir.</span> : null}
          </div>
        </section>

        <section className="grid gap-1" aria-label="Conexiones de la cola">
          <span className="text-[12.5px] font-semibold">Conexiones que usan esta cola</span>
          {queue.channels.length === 0 ? <p className="text-[12.5px] text-muted">Ninguna todavía. Se elige en Configuración › Conexiones.</p> : <p className="text-[13px]">{queue.channels.map((c) => c.name).join(', ')}</p>}
        </section>
      </div>

      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {confirmArchive ? (
          <span className="flex flex-wrap items-center gap-2 text-[13px]">¿Archivar «{queue.name}»?
            <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={archive.isPending} onClick={() => archive.mutate(queue.id, { onSuccess: onClose, onError: (e) => { setConfirmArchive(false); setError(friendlyError(e, 'No pudimos archivar la cola.')); } })}>Sí, archivar</Button>
            <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirmArchive(false)}>No</Button>
          </span>
        ) : <Button variant="danger" onClick={() => setConfirmArchive(true)}>Archivar cola</Button>}
        <span className="flex gap-2">
          <Button onClick={onClose}>Cerrar</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>Guardar</Button>
        </span>
      </div>
    </Modal>
  );
}
