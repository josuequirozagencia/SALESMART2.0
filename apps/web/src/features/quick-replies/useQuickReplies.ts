import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { QuickReply, QuickReplyList } from '../../lib/types';

/** Las respuestas rápidas que la persona puede ver: las suyas y las compartidas por la empresa. */
export function useQuickReplies() {
  return useQuery({ queryKey: ['quick-replies'], staleTime: 15_000, retry: false, queryFn: () => api<QuickReplyList>('/quick-replies') });
}

function useDone() {
  const qc = useQueryClient();
  // El selector del redactor tiene las suyas ya resueltas por conversación: se vuelven a pedir
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['quick-replies'] }), qc.invalidateQueries({ queryKey: ['conversation-quick-replies'] })]);
}

export interface QuickReplyInput {
  shortcut: string;
  body: string;
  shared: boolean;
}

export function useCreateQuickReply() {
  const done = useDone();
  return useMutation({ mutationFn: (input: QuickReplyInput) => api<QuickReply>('/quick-replies', { method: 'POST', body: input }), onSettled: done });
}

export function useUpdateQuickReply() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<QuickReplyInput> }) => api<QuickReply>(`/quick-replies/${id}`, { method: 'PATCH', body: input }), onSettled: done });
}

export function useDeleteQuickReply() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/quick-replies/${id}`, { method: 'DELETE' }), onSettled: done });
}
