import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface MetaSettings {
  configured: boolean;
  /** ¿El servidor puede hablar con Meta y cifrar credenciales? Si no, no se puede guardar. */
  available: boolean;
  dataset_id: string | null;
  /** Últimos 4 del token: lo único que se devuelve de él. */
  token_last4: string | null;
  grace_minutes: number;
  test_event_code: string | null;
  enabled: boolean;
  last_error: string | null;
  last_check_at: string | null;
  counts: Record<string, number>;
}
export interface MetaEvent {
  id: string;
  event_id: string;
  type: 'Lead' | 'Schedule' | 'Purchase' | 'SaleCanceled';
  status: 'pending' | 'sent' | 'skipped' | 'blocked' | 'failed' | 'expired' | 'cancelled';
  attempts: number;
  contact: { id: string; name: string } | null;
  send_after: string;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
  can_retry: boolean;
}
export interface MetaEventList { items: MetaEvent[]; next_cursor: string | null }
export interface SaveMetaInput { dataset_id: string; access_token?: string; grace_minutes: number; test_event_code: string | null; enabled: boolean }
export type EventStatusFilter = '' | MetaEvent['status'];

export function useMetaSettings() {
  return useQuery({ queryKey: ['meta-settings'], retry: false, queryFn: () => api<MetaSettings>('/meta/settings') });
}

export function useMetaEvents(status: EventStatusFilter, limit: number) {
  return useQuery({
    queryKey: ['meta-events', status, limit],
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => api<MetaEventList>(`/meta/events?limit=${limit}${status ? `&status=${status}` : ''}`),
  });
}

function useDone() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['meta-settings'] }), qc.invalidateQueries({ queryKey: ['meta-events'] })]);
}

export function useSaveMeta() {
  const done = useDone();
  return useMutation({ mutationFn: (input: SaveMetaInput) => api<MetaSettings>('/meta/settings', { method: 'PUT', body: input }), onSettled: done });
}

export function useTestMeta() {
  const done = useDone();
  return useMutation({ mutationFn: () => api<{ ok: true; dataset_name: string | null }>('/meta/settings/test', { method: 'POST' }), onSettled: done });
}

export function useRetryMetaEvent() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<MetaEvent>(`/meta/events/${id}/retry`, { method: 'POST' }), onSettled: done });
}
