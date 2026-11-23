import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ContactTag, TagList } from '../../lib/types';

/** Etiquetas de la empresa (las del sistema y las personalizadas) y si la persona puede administrarlas. */
export function useTags() {
  return useQuery({ queryKey: ['tags'], staleTime: 30_000, queryFn: () => api<TagList>('/tags') });
}

export interface LeadMarkResult { lead: boolean; event: 'queued' | 'skipped' | 'none' }

/** El texto que se le dice a la persona tras colocar o quitar «Lead»: si salió a Meta, o por qué no. */
export const leadNotice = (r: LeadMarkResult): string => {
  if (!r.lead) return 'Lead quitado.';
  if (r.event === 'queued') return 'Lead marcado: se avisa a Meta (una sola vez por contacto).';
  if (r.event === 'skipped') return 'Lead marcado. No llegó por un anuncio de Meta, así que no se envía el evento.';
  return 'Lead marcado.';
};

/**
 * Coloca o quita la etiqueta del sistema «Lead» de un contacto (la única que se maneja a mano). Al colocarla sale el Lead a Meta una vez por contacto. Refresca la conversación, el contacto y los listados.
 */
export function useSetLead(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => api<LeadMarkResult>(`/contacts/${contactId}/lead`, { method: on ? 'PUT' : 'DELETE' }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation'] }), qc.invalidateQueries({ queryKey: ['conversations'] }), qc.invalidateQueries({ queryKey: ['contacts'] }), qc.invalidateQueries({ queryKey: ['contact', contactId] })]),
  });
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
