import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SavedFilters, SavedList } from '../../lib/types';

/** Listas que la persona puede ver: las suyas y las compartidas. */
export function useLists() {
  return useQuery({ queryKey: ['contact-lists'], staleTime: 15_000, queryFn: async () => (await api<{ items: SavedList[] }>('/contact-lists')).items });
}

export interface ListInput {
  name: string;
  kind: 'dynamic' | 'fixed';
  filters?: SavedFilters;
  columns?: string[];
  sort?: { key: string; order: 'asc' | 'desc' };
  shared?: boolean;
  contact_ids?: string[];
}
export interface ListPatch {
  name?: string;
  shared?: boolean;
  filters?: SavedFilters;
  columns?: string[] | null;
  sort?: { key: string; order: 'asc' | 'desc' } | null;
}

export function useCreateList() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: ListInput) => api<SavedList>('/contact-lists', { method: 'POST', body: input }), onSettled: () => qc.invalidateQueries({ queryKey: ['contact-lists'] }) });
}

export function useUpdateList() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, patch }: { id: string; patch: ListPatch }) => api<SavedList>(`/contact-lists/${id}`, { method: 'PATCH', body: patch }), onSettled: () => qc.invalidateQueries({ queryKey: ['contact-lists'] }) });
}

export function useDeleteList() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/contact-lists/${id}`, { method: 'DELETE' }), onSettled: () => qc.invalidateQueries({ queryKey: ['contact-lists'] }) });
}

/** Agrega contactos a una lista fija (solo entran los que la persona ve). */
export function useAddMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ids }: { id: string; ids: string[] }) => api<{ added: number; skipped: number }>(`/contact-lists/${id}/members`, { method: 'POST', body: { contact_ids: ids } }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['contact-lists'] }), qc.invalidateQueries({ queryKey: ['contacts'] })]),
  });
}
