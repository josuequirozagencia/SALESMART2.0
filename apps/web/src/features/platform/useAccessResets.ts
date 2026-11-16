import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AccessResetList } from '../../lib/types';

export interface ResetFilters {
  q: string;
  actorRole: '' | 'client_admin' | 'agency' | 'super_admin';
}
export const NO_RESET_FILTERS: ResetFilters = { q: '', actorRole: '' };
const PAGE = 25;

export function resetsQuery(f: ResetFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.actorRole) p.set('actor_role', f.actorRole);
  p.set('limit', String(PAGE));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** Restablecimientos de acceso hechos por otra persona (ADR-71; solo Súper Admin): quién, a quién, de qué empresa y por qué. */
export function useAccessResets(f: ResetFilters) {
  return useInfiniteQuery({
    queryKey: ['platform', 'access-resets', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<AccessResetList>(`/platform/access-resets?${resetsQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}
