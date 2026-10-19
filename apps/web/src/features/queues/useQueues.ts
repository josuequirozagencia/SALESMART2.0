import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Queue, QueueList, QueueMemberInput, QueueMode, QueueSettings, QueueSimulation } from '../../lib/types';

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
