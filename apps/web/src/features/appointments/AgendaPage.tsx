import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { useNow } from '../../lib/useNow';
import { addDays, dateTimeIn, dayLabel, isoToZoned, timeIn, todayIn, zonedToIso } from '../../lib/zone';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill, type PillKind } from '../../ui/Pill';
import { AgendaCalendar, periodLabel, shiftMonth, visibleDays, type AgendaView } from './AgendaCalendar';
import { offsetLabel, useAgenda, useAppointment, useCancelAppointment, useCompleteAppointment, useUpdateAppointment, type AgendaFilters, type Appointment, type Reminder } from './useAppointments';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const STATUS: Record<Appointment['status'], { label: string; kind: PillKind }> = { scheduled: { label: 'Agendada', kind: 'info' }, completed: { label: 'Completada', kind: 'ok' }, cancelled: { label: 'Cancelada', kind: 'crit' } };
const REMINDER_STATUS: Record<Reminder['status'], { label: string; kind: PillKind }> = {
  scheduled: { label: 'Programado', kind: 'muted' },
  sent: { label: 'Enviado', kind: 'ok' },
  skipped: { label: 'No se envió', kind: 'warn' },
  failed: { label: 'Falló', kind: 'crit' },
  cancelled: { label: 'Cancelado', kind: 'muted' },
};
const REASON: Record<string, string> = {
  window_closed: 'la ventana de 24 h estaba cerrada y no hay plantilla',
  template_unavailable: 'la plantilla ya no está disponible',
  late: 'se atrasó más de 30 minutos',
  expired: 'la cita ya había empezado',
  channel_off: 'la conexión de WhatsApp está desactivada',
  appointment_closed: 'la cita ya estaba cerrada',
  no_conversation: 'la cita no tiene conversación',
  rescheduled: 'se reprogramó la cita',
  appointment_cancelled: 'se canceló la cita',
  appointment_completed: 'la cita se completó',
  error: 'error inesperado',
};
const DELIVERY: Record<string, string> = { queued: 'en cola', sent: 'enviado', delivered: 'entregado', read: 'leído', failed: 'no se entregó' };

/** Cita abierta: recordatorios con su estado de entrega, reprogramar, cancelar (con motivo) o completar. */
function AppointmentDetail({ id, tz, onClose }: { id: string; tz: string; onClose: () => void }) {
  const q = useAppointment(id);
  const now = useNow(30_000);
  const update = useUpdateAppointment(id);
  const cancel = useCancelAppointment(id);
  const complete = useCompleteAppointment(id);
  const [panel, setPanel] = useState<'' | 'reschedule' | 'cancel'>('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const a = q.data;
  const fail = (e: unknown) => setError(friendlyError(e, 'No se pudo completar la acción'));

  const openReschedule = (): void => {
    if (!a) return;
    const z = isoToZoned(a.starts_at, tz);
    setDate(z.date);
    setTime(z.time);
    setPanel('reschedule');
    setError(undefined);
    setNotice(undefined);
  };
  const saveReschedule = (): void => {
    const iso = date && time ? zonedToIso(date, time, tz) : null;
    if (!iso) return setError('Elige el día y la hora');
    if (Date.parse(iso) < now - 60_000) return setError('La cita debe ser en el futuro');
    setError(undefined);
    update.mutate({ starts_at: iso }, { onSuccess: () => { setPanel(''); setNotice('Cita reprogramada: los recordatorios se rehicieron con la hora nueva'); }, onError: fail });
  };
  const saveCancel = (): void => {
    if (reason.trim() === '') return setError('Escribe el motivo');
    setError(undefined);
    cancel.mutate(reason.trim(), { onSuccess: () => { setPanel(''); setReason(''); setNotice('Cita cancelada'); }, onError: fail });
  };

  return (
    <Modal title="Cita" onClose={onClose} wide>
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando la cita" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudo cargar la cita')}</Alert> : null}
      {a ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <b className="text-[15px]">{a.contact.name}</b>
              <p className="text-[12.5px] text-muted">{a.kind} · {dateTimeIn(a.starts_at, tz)} · {a.duration_minutes} min · {a.owner?.name ?? '—'}</p>
            </div>
            <Pill kind={STATUS[a.status].kind}>{STATUS[a.status].label}</Pill>
          </div>
          {a.notes ? <p className="text-[13px]">Notas: {a.notes}</p> : null}
          {a.status === 'cancelled' ? <Alert>Cancelada: {a.cancel_reason}</Alert> : null}

          <section aria-label="Recordatorios" className="grid gap-1">
            <span className="text-[13px] font-semibold">Recordatorios</span>
            {a.reminders.length === 0 ? <p className="text-[12.5px] text-muted">Esta cita no tiene recordatorios.</p> : (
              <ul className="grid gap-1">
                {a.reminders.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                    <span>{offsetLabel(r.offset_minutes)} <span className="text-muted">· {dateTimeIn(r.send_at, tz)}{r.via ? ` · ${r.via === 'template' ? 'plantilla' : 'texto'}` : ''}</span></span>
                    <span className="flex items-center gap-2">
                      {r.delivery ? <span className="text-[12px] text-muted">{DELIVERY[r.delivery] ?? r.delivery}</span> : null}
                      <Pill kind={REMINDER_STATUS[r.status].kind}>{REMINDER_STATUS[r.status].label}</Pill>
                      {r.reason && r.status !== 'sent' ? <span className="text-[12px] text-muted">({REASON[r.reason] ?? r.reason})</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {a.reminder_template ? <p className="text-[12px] text-muted">Plantilla para los que salgan con la ventana de 24 h cerrada: {a.reminder_template.name}</p> : null}
          </section>

          {panel === 'reschedule' ? (
            <section aria-label="Reprogramar" className="grid gap-2 rounded-xl border border-line p-3">
              <b className="text-[13.5px]">Reprogramar</b>
              <div className="grid items-start gap-2 sm:grid-cols-2">
                <Field label="Día">{(f) => <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
                <Field label="Hora">{(f) => <Input {...f} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
              </div>
              <div className="flex justify-end gap-2">
                <Button className={SMALL} onClick={() => { setPanel(''); setError(undefined); }}>Cancelar</Button>
                <Button variant="primary" className={SMALL} loading={update.isPending} onClick={saveReschedule}>Guardar nueva hora</Button>
              </div>
            </section>
          ) : null}
          {panel === 'cancel' ? (
            <section aria-label="Cancelar cita" className="grid gap-2 rounded-xl border border-line p-3">
              <b className="text-[13.5px]">Cancelar la cita</b>
              <Field label="Motivo">{(f) => <Input {...f} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
              <div className="flex justify-end gap-2">
                <Button className={SMALL} onClick={() => { setPanel(''); setError(undefined); }}>Volver</Button>
                <Button variant="danger" className={SMALL} loading={cancel.isPending} onClick={saveCancel}>Cancelar cita</Button>
              </div>
            </section>
          ) : null}
          {error ? <Alert>{error}</Alert> : null}
          {notice ? <Alert kind="ok">{notice}</Alert> : null}

          {panel === '' && a.status === 'scheduled' ? (
            <div className="flex flex-wrap justify-end gap-2">
              {a.can.edit ? <Button className={SMALL} onClick={openReschedule}>Reprogramar</Button> : null}
              {a.can.complete ? <Button className={SMALL} loading={complete.isPending} onClick={() => { setError(undefined); complete.mutate(undefined, { onSuccess: () => setNotice('Cita completada'), onError: fail }); }}>Marcar completada</Button> : null}
              {a.can.cancel ? <Button variant="danger" className={SMALL} onClick={() => { setPanel('cancel'); setError(undefined); setNotice(undefined); }}>Cancelar cita</Button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}

/**
 * Agenda (M6.3, F13; calendario en M5.8): SIEMPRE un calendario, en vista de mes o de semana, con las citas en la HORA DE LA EMPRESA. El asesor ve las suyas; quien ve todo
 * (administrador) las de la empresa y puede filtrar por persona. Pulsar un día muestra sus citas debajo; abrir una cita muestra sus recordatorios con el estado de entrega y
 * deja reprogramar, cancelar o completar. Si la empresa no tiene un calendario externo conectado, un aviso lo dice y lleva a las conexiones.
 */
export function AgendaPage() {
  const { state } = useSession();
  const [view, setView] = useState<AgendaView>('month');
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState<string>();
  const [owner, setOwner] = useState('');
  const [open, setOpen] = useState<string>();
  // La zona se conoce con la primera respuesta; antes se usa la del navegador solo para armar el primer rango
  const [tzGuess] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const first = useAgenda(useAgendaRange(tzGuess, view, offset).range);
  const tz = first.data?.timezone ?? tzGuess;
  const { range, anchor, today } = useAgendaRange(tz, view, offset);
  const real = useAgenda(range);
  const data = real.data ?? first.data;
  const showOwner = state.status === 'authed' && state.me.role !== 'advisor';
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data?.items ?? []) if (a.owner) m.set(a.owner.id, a.owner.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const items = useMemo(() => (data?.items ?? []).filter((a) => !owner || a.owner?.id === owner), [data, owner]);
  const selected = picked ?? (visibleDays(view, anchor).includes(today) ? today : anchor);
  const ofDay = items.filter((a) => isoToZoned(a.starts_at, tz).date === selected).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const go = (n: number): void => { setOffset(offset + n); setPicked(undefined); };
  const changeView = (v: AgendaView): void => { setView(v); setOffset(0); setPicked(undefined); };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[20px] font-bold">Agenda</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Vista del calendario" className="flex gap-1">
            {(['month', 'week'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => changeView(v)} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${view === v ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>{v === 'month' ? 'Mes' : 'Semana'}</button>
            ))}
          </div>
          <Button className={SMALL} aria-label={view === 'month' ? 'Mes anterior' : 'Semana anterior'} onClick={() => go(-1)}>←</Button>
          <span className="min-w-[10ch] text-center text-[13px] font-semibold capitalize" aria-live="polite">{periodLabel(view, anchor)}</span>
          <Button className={SMALL} aria-label={view === 'month' ? 'Mes siguiente' : 'Semana siguiente'} onClick={() => go(1)}>→</Button>
          {offset !== 0 || picked ? <Button className={SMALL} onClick={() => { setOffset(0); setPicked(undefined); }}>Hoy</Button> : null}
        </div>
      </div>
      <Alert kind="info">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          Aún no hay ningún calendario conectado.
          <Link to="/settings/connections" className="inline-flex items-center rounded-[10px] border border-line px-3 py-1 text-[12.5px] font-semibold hover:bg-surface2">Conectar calendario</Link>
        </span>
      </Alert>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[12px] text-muted">Hora de la empresa: {tz}</p>
        {showOwner && people.length > 0 ? (
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            Persona
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className="rounded-[10px] border border-line bg-surface px-2.5 py-1.5 text-[13px] text-fg">
              <option value="">Todas</option>
              {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {(first.isPending && !data) ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando la agenda" /></div> : null}
      {first.isError ? <Alert>{friendlyError(first.error, 'No se pudo cargar la agenda')}</Alert> : null}
      <AgendaCalendar view={view} anchor={anchor} today={today} tz={tz} items={items} selected={selected} onSelect={setPicked} onOpen={setOpen} />
      <section aria-label={`Citas del ${dayLabel(selected)}`} className="grid gap-2">
        <h2 className="text-[13px] font-semibold capitalize">{dayLabel(selected)}</h2>
        {data && ofDay.length === 0 ? <p className="py-4 text-[13.5px] text-muted">No hay citas este día. Se agendan desde una conversación, con «Agendar».</p> : null}
        <ul className="grid gap-2">
          {ofDay.map((a) => (
            <li key={a.id}>
              <button type="button" aria-label={`Abrir la cita de ${a.contact.name}`} onClick={() => setOpen(a.id)} className={`grid w-full gap-1 rounded-xl border border-line bg-surface px-4 py-3 text-left hover:bg-surface2 ${a.status === 'cancelled' ? 'opacity-60' : ''}`}>
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <b className="text-[14px]"><span className="font-mono">{timeIn(a.starts_at, tz)}</span> · {a.contact.name}</b>
                  <Pill kind={STATUS[a.status].kind}>{STATUS[a.status].label}</Pill>
                </span>
                <span className="text-[12.5px] text-muted">{a.kind} · {a.duration_minutes} min{showOwner && a.owner ? ` · ${a.owner.name}` : ''}{a.reminders.length > 0 ? ` · ${a.reminders.filter((r) => r.status === 'sent').length}/${a.reminders.length} recordatorios enviados` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {open ? <AppointmentDetail id={open} tz={tz} onClose={() => setOpen(undefined)} /> : null}
    </div>
  );
}

/**
 * El periodo que se pinta (mes de 6 semanas o semana) `offset` pasos desde hoy, en la zona de la empresa, y el rango de la consulta: desde las 00:00 del primer día visible
 * hasta las 00:00 del día siguiente al último (42 días como máximo, dentro del tope de 62 del servidor).
 */
function useAgendaRange(tz: string, view: AgendaView, offset: number): { range: AgendaFilters; anchor: string; today: string } {
  return useMemo(() => {
    const today = todayIn(tz);
    const anchor = view === 'month' ? shiftMonth(today, offset) : addDays(today, offset * 7);
    const days = visibleDays(view, anchor);
    const from = zonedToIso(days[0]!, '00:00', tz) ?? new Date().toISOString();
    const to = zonedToIso(addDays(days[days.length - 1]!, 1), '00:00', tz) ?? new Date(Date.parse(from) + days.length * 86_400_000).toISOString();
    return { range: { from, to }, anchor, today };
  }, [tz, view, offset]);
}
