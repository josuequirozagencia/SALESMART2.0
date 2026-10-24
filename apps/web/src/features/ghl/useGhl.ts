import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export type GhlStatus = 'active' | 'needs_reconnect' | 'disconnected';

export interface GhlConnection {
  configured: boolean;
  /** ¿El servidor puede hablar con GoHighLevel y cifrar credenciales? Si no, no se puede guardar. */
  available: boolean;
  auth_type: 'private_token' | 'oauth';
  status: GhlStatus | null;
  location_id: string | null;
  /** Últimos 4 del token: lo único que se devuelve de él. */
  token_last4: string | null;
  last_error: string | null;
  last_check_at: string | null;
  webhook: { configured: boolean; id: string | null; path: string | null; created_at: string | null; rotated_at: string | null; last_used_at: string | null };
}
export interface GhlWebhookIssued { id: string; secret: string; rotated: boolean; path: string }
export interface SaveGhlInput { location_id: string; access_token?: string }

export function useGhlConnection() {
  return useQuery({ queryKey: ['ghl-connection'], retry: false, queryFn: () => api<GhlConnection>('/ghl/connection') });
}

function useDone() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['ghl-connection'] });
}

export function useSaveGhl() {
  const done = useDone();
  return useMutation({ mutationFn: (input: SaveGhlInput) => api<GhlConnection>('/ghl/connection', { method: 'PUT', body: input }), onSettled: done });
}

export function useTestGhl() {
  const done = useDone();
  return useMutation({ mutationFn: () => api<{ ok: true; location_name: string | null }>('/ghl/connection/test', { method: 'POST' }), onSettled: done });
}

export function useDisconnectGhl() {
  const done = useDone();
  return useMutation({ mutationFn: () => api<GhlConnection>('/ghl/connection/disconnect', { method: 'POST' }), onSettled: done });
}

export function useIssueGhlSecret() {
  const done = useDone();
  return useMutation({ mutationFn: () => api<GhlWebhookIssued>('/ghl/webhook/secret', { method: 'POST' }), onSettled: done });
}

export type GhlEventStatus = 'pending' | 'done' | 'skipped' | 'failed';
export type GhlEventOutcome = 'contact_created' | 'contact_linked' | 'contact_updated' | 'contact_unchanged';
export interface GhlEvent {
  id: string;
  type: 'contact' | 'message_in';
  ghl_contact_id: string;
  status: GhlEventStatus;
  outcome: GhlEventOutcome | null;
  note: string | null;
  contact: { id: string; name: string } | null;
  attempts: number;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}
export interface GhlEventList { items: GhlEvent[]; next_cursor: string | null }
export type GhlEventFilter = GhlEventStatus | '';

/** Avisos recibidos del Workflow. Se refrescan solos cada 10 s mientras la pantalla está abierta (el proceso es asíncrono). */
export function useGhlEvents(status: GhlEventFilter, limit: number) {
  return useQuery({
    queryKey: ['ghl-events', status, limit],
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
    queryFn: () => api<GhlEventList>(`/ghl/events?limit=${limit}${status ? `&status=${status}` : ''}`),
  });
}
