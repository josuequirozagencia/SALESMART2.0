import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { PlatformTrialList } from '../../lib/types';

export type TrialFilter = 'all' | 'pending' | 'active' | 'expired';

const PAGE = 25;

/** Convierte el filtro de la pantalla en los parámetros de la API (`extension` / `state`). */
export function filterQuery(f: TrialFilter): string {
  switch (f) {
    case 'pending': return 'extension=pending';
    case 'active': return 'state=active';
    case 'expired': return 'state=expired';
    default: return '';
  }
}

/** Lista paginada por cursor (id v7 descendente = más recientes primero). El resumen y la insignia vienen en cada página. */
export function usePlatformTrials(filter: TrialFilter) {
  return useInfiniteQuery({
    queryKey: ['platform', 'trials', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const q = [filterQuery(filter), `limit=${PAGE}`, pageParam ? `cursor=${pageParam}` : ''].filter(Boolean).join('&');
      return api<PlatformTrialList>(`/platform/trials?${q}`);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Insignia de navegación: solicitudes pendientes en toda la plataforma. Se refresca sola cada minuto. */
export function usePendingBadge() {
  return useQuery({
    queryKey: ['platform', 'trials', 'badge'],
    queryFn: () => api<PlatformTrialList>('/platform/trials?limit=1'),
    select: (d) => d.pending_extensions,
    refetchInterval: 60_000,
  });
}

/** Aprobar o denegar. Siempre refresca la lista, el resumen y la insignia (también si el servidor responde 409: ya la resolvió otra persona). */
export function useDecideExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'deny' }) => api(`/platform/trials/${id}/${action}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform', 'trials'] }),
  });
}
