import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { Alert, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import type { Appointment, AppointmentList } from '../appointments/useAppointments';

const STATUS: Record<Appointment['status'], { label: string; kind: 'ok' | 'muted' | 'warn' }> = {
  scheduled: { label: 'Agendada', kind: 'ok' },
  completed: { label: 'Completada', kind: 'muted' },
  cancelled: { label: 'Cancelada', kind: 'warn' },
};

/** Las citas del contacto (v11, S2: el icono de calendario de las acciones rápidas): de 90 días atrás a 180 por delante, las más cercanas primero. Sin permiso de agenda, el servidor responde 403 y el panel lo dice. */
export function ContactAppointmentsPanel({ contactId }: { contactId: string }) {
  const q = useQuery({
    queryKey: ['appointments', 'contact-panel', contactId],
    retry: false,
    staleTime: 15_000,
    queryFn: () => {
      const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 180 * 86_400_000).toISOString();
      return api<AppointmentList>(`/appointments?contact_id=${contactId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    },
  });
  if (q.isPending) return <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando citas" /></div>;
  if (q.isError) return <Alert>{friendlyError(q.error, 'No pudimos cargar las citas de este contacto.')}</Alert>;
  const tz = q.data.timezone;
  const when = (iso: string): string => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
  const items = [...q.data.items].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return (
    <section aria-label="Citas del contacto" className="grid gap-2">
      {items.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">Este contacto no tiene citas.</p> : null}
      <ul className="grid gap-2">
        {items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5 text-[13px]">
            <span className="min-w-0">
              <b className="block">{when(a.starts_at)}</b>
              <span className="text-[12px] text-muted">{a.duration_minutes} min · {a.kind}{a.owner ? ` · ${a.owner.name}` : ''}</span>
            </span>
            <Pill kind={STATUS[a.status].kind}>{STATUS[a.status].label}</Pill>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-muted">Las citas se agendan desde el chat; aquí se ven con la hora de la empresa. <Link to="/agenda" className="font-semibold text-accent hover:underline">Abrir la Agenda</Link></p>
    </section>
  );
}
