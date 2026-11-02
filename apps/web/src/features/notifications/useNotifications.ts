import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useRealtimeStatus } from '../../lib/realtime';
import type { NotificationPage } from '../../lib/types';

/** Con la conexión en vivo basta una consulta lenta de respaldo; sin ella, una más seguida (igual que la insignia del Inbox). */
const LIVE_POLL_MS = 120_000;
const POLL_MS = 30_000;

function usePollMs(): number {
  return useRealtimeStatus() === 'live' ? LIVE_POLL_MS : POLL_MS;
}

/**
 * Cuántos avisos sin leer tiene la persona, para la campana (F1, ADR-57). Si la persona no tiene permiso de verlos o el servidor falla, devuelve `null`: la campana no se muestra.
 * Todo lo de avisos cuelga de la clave `['notifications']` para refrescarlo de una vez (aviso en vivo, marcar leído).
 */
export function useUnreadNotifications(): number | null {
  const poll = usePollMs();
  const q = useQuery({ queryKey: ['notifications', 'unread'], retry: false, staleTime: 15_000, refetchInterval: poll, queryFn: async () => (await api<NotificationPage>('/notifications?unread=1&limit=1')).unread ?? 0 });
  return q.isSuccess ? q.data : null;
}

/** La lista de avisos (lo más reciente primero), con «cargar más» por cursor. */
export function useNotifications(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['notifications', 'list'],
    enabled,
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<NotificationPage>(`/notifications?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; read_at: string }>(`/notifications/${id}/read`, { method: 'POST' }), onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api<{ updated: number }>('/notifications/read-all', { method: 'POST' }), onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
}
