import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { useNow } from '../../lib/useNow';
import { addDays, dateTimeIn, dayLabel, isoToZoned, timeIn, todayIn, zonedToIso } from '../../lib/zone';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill, type PillKind } from '../../ui/Pill';
import { offsetLabel, useAgenda, useAppointment, useCancelAppointment, useCompleteAppointment, useUpdateAppointment, type Appointment, type Reminder } from './useAppointments';

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
 * Agenda (M6.3, F13): las citas de la semana, agrupadas por día en la HORA DE LA EMPRESA. El asesor ve las suyas; quien ve todo (administrador), las de la empresa.
 * Navega por semanas; abrir una cita muestra sus recordatorios con el estado de entrega y deja reprogramar, cancelar o completar.
 */
export function AgendaPage() {
  const { state } = useSession();
  const [week, setWeek] = useState(0);
  const [open, setOpen] = useState<string>();
  // La zona se conoce con la primera respuesta; antes se usa la del navegador solo para armar el primer rango
  const [tzGuess] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const first = useAgendaRange(tzGuess, week);
  const q = useAgenda(first);
  const tz = q.data?.timezone ?? tzGuess;
  const range = useAgendaRange(tz, week);
  const real = useAgenda(range);
  const data = real.data ?? q.data;
  const groups = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    for (const a of data?.items ?? []) {
      const key = isoToZoned(a.starts_at, tz).date;
      m.set(key, [...(m.get(key) ?? []), a]);
    }
    return [...m.entries()];
  }, [data, tz]);
  const showOwner = state.status === 'authed' && state.me.role !== 'advisor';
  const startDate = range.startDate;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[20px] font-bold">Agenda</h1>
        <div className="flex items-center gap-2">
          <Button className={SMALL} aria-label="Semana anterior" onClick={() => setWeek(week - 1)}>←</Button>
          <span className="text-[13px] font-semibold" aria-live="polite">{dayLabel(startDate)} – {dayLabel(addDays(startDate, 6))}</span>
          <Button className={SMALL} aria-label="Semana siguiente" onClick={() => setWeek(week + 1)}>→</Button>
          {week !== 0 ? <Button className={SMALL} onClick={() => setWeek(0)}>Hoy</Button> : null}
        </div>
      </div>
      <p className="text-[12px] text-muted">Hora de la empresa: {tz}</p>
      {(q.isPending && !data) ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando la agenda" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudo cargar la agenda')}</Alert> : null}
      {data && groups.length === 0 ? <p className="py-8 text-center text-[13.5px] text-muted">No hay citas esta semana. Se agendan desde una conversación, con «Agendar».</p> : null}
      {groups.map(([day, items]) => (
        <section key={day} aria-label={dayLabel(day)} className="grid gap-2">
          <h2 className="text-[13px] font-semibold capitalize">{dayLabel(day)}</h2>
          <ul className="grid gap-2">
            {items.map((a) => (
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
      ))}
      {open ? <AppointmentDetail id={open} tz={tz} onClose={() => setOpen(undefined)} /> : null}
    </div>
  );
}

/** El rango de la semana `offset` (0 = la actual) en la zona de la empresa: desde las 00:00 del lunes hasta el lunes siguiente. */
function useAgendaRange(tz: string, offset: number): { from: string; to: string; startDate: string } {
  return useMemo(() => {
    const today = todayIn(tz);
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = domingo
    const monday = addDays(today, -((dow + 6) % 7) + offset * 7);
    const from = zonedToIso(monday, '00:00', tz) ?? new Date().toISOString();
    const to = zonedToIso(addDays(monday, 7), '00:00', tz) ?? new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
    return { from, to, startDate: monday };
  }, [tz, offset]);
}
