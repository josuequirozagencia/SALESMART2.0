import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface Person { id: string; name: string }
export interface Reminder {
  id: string;
  offset_minutes: number;
  send_at: string;
  status: 'scheduled' | 'sent' | 'skipped' | 'failed' | 'cancelled';
  via: 'text' | 'template' | null;
  reason: string | null;
  /** Estado de entrega del mensaje (`queued`, `sent`, `delivered`, `read`, `failed`). */
  delivery: string | null;
}
export interface Appointment {
  id: string;
  contact: { id: string; name: string };
  conversation_id: string | null;
  owner: Person | null;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  kind: string;
  notes: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
  cancel_reason: string | null;
  created_at: string;
  reminders: Reminder[];
  reminder_offsets: number[];
  reminder_template: { id: string; name: string } | null;
  can: { edit: boolean; cancel: boolean; complete: boolean };
}
export interface TemplateVariable { id: string; part: string; key: string }
export interface AppointmentOptions {
  timezone: string;
  max_reminders: number;
  window: { open: boolean; expires_at: string | null };
  templates: Array<{ id: string; name: string; language: string; category: string; body: string; variables: TemplateVariable[] }>;
  blocked: 'unassigned' | 'not_owner' | 'channel_off' | null;
}
export interface AppointmentList { items: Appointment[]; timezone: string }
export interface AgendaFilters { from: string; to: string }

export interface CreateAppointmentInput {
  conversation_id: string;
  starts_at: string;
  duration_minutes: number;
  kind: string;
  notes?: string;
  reminders: number[];
  reminder_template_id?: string;
  reminder_params?: Record<string, string>;
}

export function useAppointmentOptions(conversationId: string) {
  return useQuery({ queryKey: ['appointment-options', conversationId], staleTime: 0, retry: false, queryFn: () => api<AppointmentOptions>(`/appointments/options?conversation_id=${conversationId}`) });
}

export function useAgenda(f: AgendaFilters) {
  return useQuery({
    queryKey: ['appointments', f],
    retry: false,
    queryFn: () => api<AppointmentList>(`/appointments?from=${encodeURIComponent(f.from)}&to=${encodeURIComponent(f.to)}`),
  });
}

export function useAppointment(id: string | undefined) {
  return useQuery({ queryKey: ['appointment', id], enabled: !!id, retry: false, queryFn: () => api<Appointment>(`/appointments/${id}`) });
}

function useDone() {
  const qc = useQueryClient();
  // Agendar mueve etiquetas, oportunidades y la conversación
  return () => Promise.all(['appointments', 'appointment', 'conversation', 'conversations', 'opportunities', 'contacts'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

export function useCreateAppointment() {
  const done = useDone();
  return useMutation({ mutationFn: ({ key, input }: { key: string; input: CreateAppointmentInput }) => api<Appointment>('/appointments', { method: 'POST', body: input, headers: { 'idempotency-key': key } }), onSettled: done });
}

export function useUpdateAppointment(id: string) {
  const done = useDone();
  return useMutation({ mutationFn: (input: { starts_at?: string; duration_minutes?: number; kind?: string; notes?: string | null; reminders?: number[] }) => api<Appointment>(`/appointments/${id}`, { method: 'PATCH', body: input }), onSettled: done });
}

export function useCancelAppointment(id: string) {
  const done = useDone();
  return useMutation({ mutationFn: (reason: string) => api<Appointment>(`/appointments/${id}/cancel`, { method: 'POST', body: { reason } }), onSettled: done });
}

export function useCompleteAppointment(id: string) {
  const done = useDone();
  return useMutation({ mutationFn: () => api<Appointment>(`/appointments/${id}/complete`, { method: 'POST' }), onSettled: done });
}

/** Opciones de «minutos antes» que se ofrecen (la API acepta cualquier valor entre 1 minuto y 30 días). */
export const REMINDER_CHOICES: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: '15 min antes' },
  { minutes: 30, label: '30 min antes' },
  { minutes: 60, label: '1 hora antes' },
  { minutes: 120, label: '2 horas antes' },
  { minutes: 1440, label: '1 día antes' },
  { minutes: 2880, label: '2 días antes' },
];
export const offsetLabel = (minutes: number): string => REMINDER_CHOICES.find((c) => c.minutes === minutes)?.label ?? (minutes % 1440 === 0 ? `${minutes / 1440} días antes` : minutes % 60 === 0 ? `${minutes / 60} h antes` : `${minutes} min antes`);
