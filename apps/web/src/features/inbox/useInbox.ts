import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ChatMessage, ChatMessagePage, Conversation, ConversationList, InboxFilters, InboxOptions } from '../../lib/types';

/** Cada cuánto se vuelve a mirar (sin tiempo real hasta M5.7): el listado y el hilo abierto. Con la pestaña en segundo plano no se consulta. */
export const LIST_POLL_MS = 10_000;
export const THREAD_POLL_MS = 5_000;

export const DEFAULT_INBOX_FILTERS: InboxFilters = { tab: 'working', q: '', owner: '', queue: '', channel: '', tag: '', unread: false };

/** Cuántos filtros (además de la pestaña) están puestos. */
export const activeFilterCount = (f: InboxFilters): number => [f.owner, f.queue, f.channel, f.tag].filter(Boolean).length + (f.unread ? 1 : 0);

function listQuery(f: InboxFilters, cursor: string | undefined): string {
  const p = new URLSearchParams({ tab: f.tab });
  if (f.q.trim()) p.set('q', f.q.trim());
  for (const k of ['owner', 'queue', 'channel', 'tag'] as const) if (f[k]) p.set(k, f[k]);
  if (f.unread) p.set('unread', '1');
  if (cursor) p.set('cursor', cursor);
  p.set('limit', '30');
  return `?${p.toString()}`;
}

/** Conversaciones que la persona puede ver, con la pestaña y los filtros puestos. La primera página trae además los conteos de las pestañas. */
export function useConversations(f: InboxFilters) {
  return useInfiniteQuery({
    queryKey: ['conversations', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<ConversationList>(`/conversations${listQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: LIST_POLL_MS,
    placeholderData: keepPreviousData,
  });
}

export function useConversation(id: string) {
  return useQuery({ queryKey: ['conversation', id], queryFn: () => api<Conversation>(`/conversations/${id}`), refetchInterval: THREAD_POLL_MS });
}

/** El hilo: la primera página es la más reciente; las siguientes, más antiguas. */
export function useMessages(id: string) {
  return useInfiniteQuery({
    queryKey: ['messages', id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<ChatMessagePage>(`/conversations/${id}/messages?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: THREAD_POLL_MS,
  });
}

/** Opciones de los filtros (colas, conexiones, personas, etiquetas). */
export function useInboxOptions() {
  return useQuery({ queryKey: ['inbox-options'], staleTime: 60_000, queryFn: () => api<InboxOptions>('/conversations/options') });
}

function useRefresh(id: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation', id] }), qc.invalidateQueries({ queryKey: ['messages', id] }), qc.invalidateQueries({ queryKey: ['conversations'] })]);
}

/** Escribe al cliente. El mensaje vuelve con su estado (`queued`, `sent` o `failed`). */
export function useSendReply(id: string) {
  const refresh = useRefresh(id);
  return useMutation({ mutationFn: (text: string) => api<ChatMessage>(`/conversations/${id}/messages`, { method: 'POST', body: { text } }), onSettled: refresh });
}

export function useSendNote(id: string) {
  const refresh = useRefresh(id);
  return useMutation({ mutationFn: (text: string) => api<ChatMessage>(`/conversations/${id}/notes`, { method: 'POST', body: { text } }), onSettled: refresh });
}

export type ConversationAction = 'accept' | 'take' | 'close';

/** Aceptar, tomar o finalizar: el servidor devuelve la conversación ya actualizada. */
export function useConversationAction(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (action: ConversationAction) => api<Conversation>(`/conversations/${id}/${action}`, { method: 'POST' }),
    onSuccess: (c) => qc.setQueryData(['conversation', id], c),
    onSettled: refresh,
  });
}

/** Marca como leída (solo cuenta si quien la abre es su dueño). Un fallo aquí no se le muestra a nadie: se reintenta en el siguiente aviso. */
export function useMarkRead(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<Conversation>(`/conversations/${id}/read`, { method: 'POST' }),
    onSuccess: (c) => {
      qc.setQueryData(['conversation', id], c);
      return qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useRetryMessage(conversationId: string) {
  const refresh = useRefresh(conversationId);
  return useMutation({ mutationFn: (messageId: string) => api<ChatMessage>(`/messages/${messageId}/retry`, { method: 'POST' }), onSettled: refresh });
}
