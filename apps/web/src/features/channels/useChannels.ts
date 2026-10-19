import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Channel, ChannelInput, ChannelList } from '../../lib/types';

/** Conexiones de canales de la empresa (solo quien administra conexiones; para el resto el servidor responde 403). */
export function useChannels() {
  return useQuery({ queryKey: ['channels'], retry: false, queryFn: () => api<ChannelList>('/channels') });
}

function useDone() {
  const qc = useQueryClient();
  // Las colas muestran qué conexiones las usan
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['channels'] }), qc.invalidateQueries({ queryKey: ['queues'] })]);
}

export function useConnectChannel() {
  const done = useDone();
  return useMutation({ mutationFn: (input: ChannelInput) => api<Channel>('/channels', { method: 'POST', body: input }), onSettled: done });
}

export function useUpdateChannel() {
  const done = useDone();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: { name?: string; status?: 'active' | 'disabled'; access_token?: string; queue_id?: string | null } }) => api<Channel>(`/channels/${id}`, { method: 'PATCH', body: input }),
    onSettled: done,
  });
}

/** Vuelve a preguntarle a Meta por el número: actualiza su teléfono visible y deja el último error si ya no responde. */
export function useCheckChannel() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<Channel>(`/channels/${id}/check`, { method: 'POST' }), onSettled: done });
}

export function useDisconnectChannel() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/channels/${id}`, { method: 'DELETE' }), onSettled: done });
}
