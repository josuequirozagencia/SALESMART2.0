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
export type GhlEventOutcome = 'contact_created' | 'contact_linked' | 'contact_updated' | 'contact_unchanged' | 'message_received';
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

export type GhlOutboxStatus = 'pending' | 'done' | 'skipped' | 'failed';
export interface GhlOutboxItem {
  id: string;
  op: 'tag_add' | 'tag_remove' | 'tag_delete';
  tag: string;
  tag_kind: 'system' | 'custom';
  status: GhlOutboxStatus;
  contact: { id: string; name: string } | null;
  note: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
  can_retry: boolean;
}
export interface GhlOutboxList { items: GhlOutboxItem[]; next_cursor: string | null; counts: Record<string, number> }
export type GhlOutboxFilter = GhlOutboxStatus | '';

/** Etiquetas enviadas (o por enviar) a GoHighLevel. Se refrescan solas cada 10 s mientras la pantalla está abierta (el envío es asíncrono). */
export function useGhlOutbox(status: GhlOutboxFilter, limit: number) {
  return useQuery({
    queryKey: ['ghl-outbox', status, limit],
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
    queryFn: () => api<GhlOutboxList>(`/ghl/outbox?limit=${limit}${status ? `&status=${status}` : ''}`),
  });
}

export function useRetryGhlOutbox() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; status: 'pending' }>(`/ghl/outbox/${id}/retry`, { method: 'POST' }), onSettled: () => qc.invalidateQueries({ queryKey: ['ghl-outbox'] }) });
}

export type GhlReplyType = 'SMS' | 'WhatsApp' | 'IG' | 'FB' | 'Live_Chat';
export interface GhlChannel {
  configured: boolean;
  channel_id: string | null;
  /** Cola a la que van las conversaciones nuevas de GoHighLevel; sin cola quedan «sin asignar». */
  queue: { id: string; name: string } | null;
  /** Canal de GHL por el que se responde cuando el aviso no dice por cuál llegó el mensaje. */
  default_type: GhlReplyType | null;
}
export interface SaveGhlChannelInput { queue_id: string | null; default_type: GhlReplyType | null }

export function useGhlChannel(enabled: boolean) {
  return useQuery({ queryKey: ['ghl-channel'], enabled, retry: false, queryFn: () => api<GhlChannel>('/ghl/channel') });
}

export function useSaveGhlChannel() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: SaveGhlChannelInput) => api<GhlChannel>('/ghl/channel', { method: 'PUT', body: input }), onSettled: () => qc.invalidateQueries({ queryKey: ['ghl-channel'] }) });
}

export interface GhlWorkflow { id: string; name: string; enrollable: boolean }
export interface GhlWorkflowList { items: GhlWorkflow[]; fetched_at: string }
export interface GhlEnrollment {
  id: string;
  workflow: { id: string; name: string };
  status: 'done' | 'failed';
  error: string | null;
  by: { id: string; name: string } | null;
  created_at: string;
}

/** Los flujos de GoHighLevel (la lista se guarda 5 min en el servidor; «Actualizar» la salta). */
export function useGhlWorkflows(enabled: boolean) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['ghl-workflows'], enabled, retry: false, staleTime: 60_000, queryFn: () => api<GhlWorkflowList>('/ghl/workflows') });
  const refresh = async (): Promise<void> => {
    const fresh = await api<GhlWorkflowList>('/ghl/workflows?refresh=1');
    qc.setQueryData(['ghl-workflows'], fresh);
  };
  return { query, refresh };
}

export function useGhlEnrollments(contactId: string) {
  return useQuery({ queryKey: ['ghl-enrollments', contactId], retry: false, queryFn: () => api<{ items: GhlEnrollment[] }>(`/ghl/contacts/${contactId}/workflows`) });
}

export function useEnrollGhl(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) => api<GhlEnrollment>(`/ghl/contacts/${contactId}/workflows`, { method: 'POST', body: { workflow_id: workflowId } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ghl-enrollments', contactId] }),
  });
}
