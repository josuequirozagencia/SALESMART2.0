import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, tokens, type ErrorDetail } from '../../lib/api';
import { useRealtimeStatus } from '../../lib/realtime';
import type { AgentStatus, ChatMessage, ChatMessagePage, Conversation, ConversationList, InboxFilters, InboxOptions, ResolvedQuickReply, RevokeResult, ScheduledMessage, TemplateList, TransferOptions, TransferResult } from '../../lib/types';

/**
 * Cada cuánto se vuelve a mirar el listado y el hilo abierto cuando NO hay conexión en vivo (respaldo). Con la conexión en vivo los cambios llegan solos y
 * solo queda una consulta lenta por si algún aviso se perdió. Con la pestaña en segundo plano no se consulta.
 */
export const LIST_POLL_MS = 10_000;
export const THREAD_POLL_MS = 5_000;
export const LIVE_LIST_POLL_MS = 60_000;
export const LIVE_THREAD_POLL_MS = 30_000;

/** Intervalos de consulta según haya o no conexión en vivo. */
function usePolling(): { list: number; thread: number } {
  const live = useRealtimeStatus() === 'live';
  return live ? { list: LIVE_LIST_POLL_MS, thread: LIVE_THREAD_POLL_MS } : { list: LIST_POLL_MS, thread: THREAD_POLL_MS };
}

/**
 * Conversaciones sin leer, para la insignia del menú lateral. Solo se consulta FUERA del Inbox (ahí el listado ya trae los conteos y la insignia conserva el último valor); la conexión en vivo la
 * refresca y, sin ella, una consulta lenta. Si falla, la insignia simplemente no aparece.
 */
export function useInboxUnread(enabled: boolean): number {
  const poll = usePolling();
  const q = useQuery({ queryKey: ['inbox-unread'], enabled, retry: false, staleTime: 30_000, refetchInterval: poll.list, queryFn: async () => (await api<ConversationList>('/conversations?tab=working&limit=1')).counts?.unread ?? 0 });
  return q.data ?? 0;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = { tab: 'working', q: '', owner: '', queue: '', channel: '', tag: '', unread: false, sla: '' };

/** Cuántos filtros (además de la pestaña) están puestos. */
export const activeFilterCount = (f: InboxFilters): number => [f.owner, f.queue, f.channel, f.tag, f.sla].filter(Boolean).length + (f.unread ? 1 : 0);

function listQuery(f: InboxFilters, cursor: string | undefined): string {
  const p = new URLSearchParams({ tab: f.tab });
  if (f.q.trim()) p.set('q', f.q.trim());
  for (const k of ['owner', 'queue', 'channel', 'tag'] as const) if (f[k]) p.set(k, f[k]);
  if (f.sla) p.set('sla', f.sla);
  if (f.unread) p.set('unread', '1');
  if (cursor) p.set('cursor', cursor);
  p.set('limit', '30');
  return `?${p.toString()}`;
}

/** Conversaciones que la persona puede ver, con la pestaña y los filtros puestos. La primera página trae además los conteos de las pestañas. */
export function useConversations(f: InboxFilters) {
  const poll = usePolling();
  return useInfiniteQuery({
    queryKey: ['conversations', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<ConversationList>(`/conversations${listQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: poll.list,
    placeholderData: keepPreviousData,
  });
}

export function useConversation(id: string) {
  const poll = usePolling();
  return useQuery({ queryKey: ['conversation', id], queryFn: () => api<Conversation>(`/conversations/${id}`), refetchInterval: poll.thread });
}

/** El hilo: la primera página es la más reciente; las siguientes, más antiguas. */
export function useMessages(id: string) {
  const poll = usePolling();
  return useInfiniteQuery({
    queryKey: ['messages', id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<ChatMessagePage>(`/conversations/${id}/messages?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: poll.thread,
  });
}

/** Opciones de los filtros (colas, conexiones, personas, etiquetas). */
export function useInboxOptions() {
  return useQuery({ queryKey: ['inbox-options'], staleTime: 60_000, queryFn: () => api<InboxOptions>('/conversations/options') });
}

function useRefresh(id: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['transfer-options', id] }), qc.invalidateQueries({ queryKey: ['conversation', id] }), qc.invalidateQueries({ queryKey: ['messages', id] }), qc.invalidateQueries({ queryKey: ['conversations'] })]);
}

/** Escribe al cliente. El mensaje vuelve con su estado (`queued`, `sent` o `failed`). */
export function useSendReply(id: string) {
  const refresh = useRefresh(id);
  return useMutation({ mutationFn: (text: string) => api<ChatMessage>(`/conversations/${id}/messages`, { method: 'POST', body: { text } }), onSettled: refresh });
}

/** Las plantillas que se pueden enviar en esta conversación (las de su conexión). Solo se piden al abrir el selector. */
export function useConversationTemplates(id: string, enabled: boolean) {
  return useQuery({ queryKey: ['conversation-templates', id], enabled, staleTime: 0, retry: false, queryFn: () => api<TemplateList>(`/conversations/${id}/templates`) });
}

/** Las respuestas rápidas que puede usar quien escribe, ya resueltas con los datos del contacto de la conversación. */
export function useConversationQuickReplies(id: string, enabled: boolean) {
  return useQuery({ queryKey: ['conversation-quick-replies', id], enabled, staleTime: 30_000, retry: false, queryFn: () => api<{ items: ResolvedQuickReply[] }>(`/conversations/${id}/quick-replies`) });
}

/** Los mensajes programados de la conversación (pendientes y, 24 h, los que no salieron). Se vuelven a pedir con el hilo. */
export function useScheduledMessages(id: string) {
  const poll = usePolling();
  return useQuery({ queryKey: ['scheduled', id], staleTime: 5_000, retry: false, refetchInterval: poll.thread, queryFn: () => api<{ items: ScheduledMessage[] }>(`/conversations/${id}/scheduled`) });
}

/** Programa un texto para que salga solo a la hora indicada (instante ISO con zona). */
export function useScheduleMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: { text: string; send_at: string }) => api<ScheduledMessage>(`/conversations/${id}/scheduled`, { method: 'POST', body: input }), onSettled: () => qc.invalidateQueries({ queryKey: ['scheduled', id] }) });
}

export function useCancelScheduled(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (scheduledId: string) => api<ScheduledMessage>(`/conversations/${id}/scheduled/${scheduledId}`, { method: 'DELETE' }), onSettled: () => qc.invalidateQueries({ queryKey: ['scheduled', id] }) });
}

/** Envía una plantilla aprobada con el valor de cada variable (clave = id de la variable). El mensaje vuelve con su estado. */
export function useSendTemplate(id: string) {
  const refresh = useRefresh(id);
  return useMutation({ mutationFn: (input: { template_id: string; params: Record<string, string> }) => api<ChatMessage>(`/conversations/${id}/template`, { method: 'POST', body: input }), onSettled: refresh });
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

/** A quién se puede transferir o compartir, con su carga y si está en la cola de la conversación. */
export function useTransferOptions(id: string, enabled: boolean) {
  return useQuery({ queryKey: ['transfer-options', id], enabled, staleTime: 0, queryFn: () => api<TransferOptions>(`/conversations/${id}/transfer-options`) });
}

export interface TransferInput {
  to_user_id: string;
  keep_as?: 'reply' | 'view';
  note?: string;
}

/** Pasa la conversación (y el lead) a otra persona, que debe aceptarla. */
export function useTransfer(id: string) {
  const refresh = useRefresh(id);
  return useMutation({ mutationFn: (input: TransferInput) => api<TransferResult>(`/conversations/${id}/transfer`, { method: 'POST', body: input }), onSettled: refresh });
}

export interface ShareInput {
  user_id: string;
  permission: 'reply' | 'view';
  note?: string;
}

/** Da acceso a otra persona sin cambiar el dueño. */
export function useShare(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (input: ShareInput) => api<Conversation>(`/conversations/${id}/share`, { method: 'POST', body: input }),
    onSuccess: (c) => qc.setQueryData(['conversation', id], c),
    onSettled: refresh,
  });
}

/** Quita el acceso de un colaborador (o la propia persona deja de participar). */
export function useRevoke(id: string) {
  const refresh = useRefresh(id);
  return useMutation({ mutationFn: (userId: string) => api<RevokeResult>(`/conversations/${id}/participants/${userId}`, { method: 'DELETE' }), onSettled: refresh });
}

/** Qué hace el agente de IA en la conversación (404 si la persona no puede verla; sin agente, `agent: null`). */
export function useAgentStatus(id: string) {
  const poll = usePolling();
  return useQuery({ queryKey: ['conversation-ai', id], retry: false, staleTime: 5_000, refetchInterval: poll.thread, queryFn: () => api<AgentStatus>(`/conversations/${id}/ai`) });
}

/** Tomar el control (pausar al agente) o reanudarlo. Devuelve el estado nuevo. */
export function useAgentControl(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause' | 'resume') => api<AgentStatus>(`/conversations/${id}/ai/${action}`, { method: 'POST' }),
    onSuccess: (s) => qc.setQueryData(['conversation-ai', id], s),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation-ai', id] }), qc.invalidateQueries({ queryKey: ['messages', id] })]),
  });
}

export function useRetryMessage(conversationId: string) {
  const refresh = useRefresh(conversationId);
  return useMutation({ mutationFn: (messageId: string) => api<ChatMessage>(`/messages/${messageId}/retry`, { method: 'POST' }), onSettled: refresh });
}

export interface UploadedAttachment {
  id: string;
  kind: string;
  mime_type: string;
  filename: string | null;
  size_bytes: number;
  scan_status: string;
}

/** Reacciona a un mensaje del cliente con un emoji (o la quita con `null`). Falla si el proveedor la rechaza: no hay cola, la persona reintenta. */
export function useReact(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string | null }) => api<{ id: string; my_reaction: string | null }>(`/conversations/${conversationId}/messages/${messageId}/reaction`, { method: 'PUT', body: { emoji } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['messages', conversationId] }),
  });
}

export function useUploadAttachment(conversationId: string) {
  return useMutation({
    mutationFn: async (file: File): Promise<UploadedAttachment> => {
      const res = await fetch(`/v1/conversations/${conversationId}/attachments`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
        body: await file.arrayBuffer(),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
        throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`, undefined, undefined, (body?.error?.details as ErrorDetail[]) ?? []);
      }
      return (await res.json()) as UploadedAttachment;
    },
  });
}

export function useSendMedia(conversationId: string) {
  const refresh = useRefresh(conversationId);
  return useMutation({ mutationFn: (input: { attachment_id: string; caption?: string }) => api<ChatMessage>(`/conversations/${conversationId}/media`, { method: 'POST', body: input }), onSettled: refresh });
}
