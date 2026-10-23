import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Queue, QueueList, QueueMemberInput, QueueMode, QueueProduct, QueueProductList, QueueSettings, QueueSimulation } from '../../lib/types';

/** Colas de la empresa con sus asesores, conexiones y cifras (solo quien administra colas; para el resto el servidor responde 403). */
export function useQueues() {
  return useQuery({ queryKey: ['queues'], retry: false, queryFn: () => api<QueueList>('/queues') });
}

function useDone() {
  const qc = useQueryClient();
  // Las conexiones muestran el nombre de su cola
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['queues'] }), qc.invalidateQueries({ queryKey: ['channels'] })]);
}

export function useCreateQueue() {
  const done = useDone();
  return useMutation({ mutationFn: (input: { name: string; color?: string }) => api<Queue>('/queues', { method: 'POST', body: input }), onSettled: done });
}

export function useUpdateQueue() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: QueueSettings }) => api<Queue>(`/queues/${id}`, { method: 'PATCH', body: input }), onSettled: done });
}

export function useSetQueueMembers() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, members }: { id: string; members: QueueMemberInput[] }) => api<Queue>(`/queues/${id}/members`, { method: 'PUT', body: { members } }), onSettled: done });
}

export function useArchiveQueue() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; archived: true }>(`/queues/${id}`, { method: 'DELETE' }), onSettled: done });
}

/** Catálogo de productos y servicios de una cola (M6.1). */
export function useQueueProducts(queueId: string) {
  return useQuery({ queryKey: ['queue-products', queueId], retry: false, queryFn: () => api<QueueProductList>(`/queues/${queueId}/products`) });
}

export function useCreateProduct(queueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; kind: QueueProduct['kind']; price: string }) => api<QueueProduct>(`/queues/${queueId}/products`, { method: 'POST', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue-products', queueId] }),
  });
}

export function useUpdateProduct(queueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, input }: { productId: string; input: Partial<{ name: string; kind: QueueProduct['kind']; price: string; active: boolean }> }) =>
      api<QueueProduct>(`/queues/${queueId}/products/${productId}`, { method: 'PATCH', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue-products', queueId] }),
  });
}

/** Simula el reparto con lo que hay en pantalla (sin guardar nada). */
export function useSimulateQueue() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: { count?: number; mode?: QueueMode; batch?: number; daily_cap?: number; members?: QueueMemberInput[] } }) =>
      api<QueueSimulation>(`/queues/${id}/simulate`, { method: 'POST', body: input }),
  });
}

/** Reparte ahora las conversaciones «sin asignar» de la cola. */
export function useDistributeQueue() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<{ assigned: number; remaining: number }>(`/queues/${id}/distribute`, { method: 'POST' }), onSettled: done });
}
