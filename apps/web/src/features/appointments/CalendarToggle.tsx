import { Link } from 'react-router-dom';
import { Pill, type PillKind } from '../../ui/Pill';
import type { Appointment, AppointmentOptions } from './useAppointments';

type CalendarState = AppointmentOptions['calendar']['state'];

/**
 * «Crear evento en Google Calendar» (67c, ADR-67): el interruptor del formulario de «Agendar». Con el calendario conectado se puede encender o apagar; si no lo está, queda apagado y dice por qué y dónde
 * arreglarlo (no se oculta, para que se descubra).
 */
export function CalendarToggle({ state, value, onChange }: { state: CalendarState; value: boolean; onChange: (v: boolean) => void }) {
  const usable = state === 'connected';
  return (
    <section aria-label="Google Calendar" className="grid gap-1.5 rounded-xl border border-line p-3">
      <label className={`flex items-start gap-3 text-[13.5px] ${usable ? 'cursor-pointer' : 'opacity-70'}`}>
        <input type="checkbox" role="switch" className="mt-1" checked={usable && value} disabled={!usable} onChange={(e) => onChange(e.target.checked)} />
        <span className="grid">
          <span className="font-semibold">Crear evento en Google Calendar</span>
          <span className="text-[12.5px] text-muted">
            {usable
              ? 'La cita aparecerá en el calendario de Google de la empresa, y si la mueves o la cancelas aquí, el evento cambia o se borra. No lleva teléfono ni correo del cliente.'
              : state === 'needs_reconnect'
                ? 'El calendario de Google necesita volver a conectarse; mientras tanto la cita no se envía.'
                : state === 'pending_calendar'
                  ? 'Falta elegir el calendario de Google donde se guardarán las citas.'
                  : 'No hay un calendario de Google conectado.'}
          </span>
        </span>
      </label>
      {!usable ? <Link to="/settings/calendar" className="ml-7 w-fit text-[12.5px] font-semibold text-accent underline">Ir a Configuración › Google Calendar</Link> : null}
    </section>
  );
}

const MARK: Record<'off' | 'pending' | 'synced' | 'failed' | 'gone', { label: string; kind: PillKind }> = {
  off: { label: 'Sin Google Calendar', kind: 'muted' },
  pending: { label: 'Enviando a Google', kind: 'info' },
  synced: { label: 'En Google Calendar', kind: 'ok' },
  failed: { label: 'No se pudo enviar a Google', kind: 'crit' },
  gone: { label: 'Borrado en Google', kind: 'warn' },
};

/** Marca por cita: cómo va su evento en Google. Sin estado (cita de antes del calendario) no muestra nada. */
export function CalendarMark({ calendar }: { calendar: Appointment['calendar'] | undefined }) {
  if (!calendar || calendar.state === null) return null;
  const m = MARK[calendar.state];
  return <Pill kind={m.kind}>{m.label}</Pill>;
}
