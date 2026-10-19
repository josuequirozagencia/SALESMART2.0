import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Holiday, Queue, SlaSettings, WeekHours } from '../../lib/types';

/** SLA, horario y feriados de la empresa (solo quien administra el SLA; para el resto el servidor responde 403). */
export function useSlaSettings() {
  return useQuery({ queryKey: ['sla'], retry: false, queryFn: () => api<SlaSettings>('/sla') });
}

/** Cambiar la política, el horario o los feriados mueve estados que se ven en otras pantallas: colas («abierta ahora») y Inbox (cronómetros). */
function useDone() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['sla'] }), qc.invalidateQueries({ queryKey: ['queues'] }), qc.invalidateQueries({ queryKey: ['conversations'] }), qc.invalidateQueries({ queryKey: ['conversation'] })]);
}

export function useSavePolicy() {
  const done = useDone();
  return useMutation({ mutationFn: (input: { target_minutes: number; risk_minutes: number }) => api<SlaSettings>('/sla/policy', { method: 'PUT', body: input }), onSettled: done });
}

/** `days: null` deja la empresa abierta siempre. */
export function useSaveHours() {
  const done = useDone();
  return useMutation({ mutationFn: (days: WeekHours | null) => api<SlaSettings>('/sla/hours', { method: 'PUT', body: { days } }), onSettled: done });
}

export function useAddHoliday() {
  const done = useDone();
  return useMutation({ mutationFn: (input: { date: string; name: string; yearly: boolean }) => api<Holiday>('/sla/holidays', { method: 'POST', body: input }), onSettled: done });
}

export function useRemoveHoliday() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; removed: true }>(`/sla/holidays/${id}`, { method: 'DELETE' }), onSettled: done });
}

/** Horario propio de una cola; `days: null` vuelve a usar el de la empresa. */
export function useSaveQueueHours() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, days }: { id: string; days: WeekHours | null }) => api<Queue>(`/queues/${id}/hours`, { method: 'PUT', body: { days } }), onSettled: done });
}
