import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ContactTag, TagList } from '../../lib/types';

/** Etiquetas de la empresa (las del sistema y las personalizadas) y si la persona puede administrarlas. */
export function useTags() {
  return useQuery({ queryKey: ['tags'], staleTime: 30_000, queryFn: () => api<TagList>('/tags') });
}

function useDone() {
  const qc = useQueryClient();
  // Renombrar o borrar una etiqueta cambia lo que muestran los contactos
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['tags'] }), qc.invalidateQueries({ queryKey: ['contacts'] })]);
}

export function useCreateTag() {
  const done = useDone();
  return useMutation({ mutationFn: (input: { name: string; color: string }) => api<ContactTag>('/tags', { method: 'POST', body: input }), onSettled: done });
}

export function useUpdateTag() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: { name?: string; color?: string } }) => api<ContactTag>(`/tags/${id}`, { method: 'PATCH', body: input }), onSettled: done });
}

export function useDeleteTag() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/tags/${id}`, { method: 'DELETE' }), onSettled: done });
}
