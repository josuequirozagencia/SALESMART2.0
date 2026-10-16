import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AccessSessionList } from '../../lib/types';

export interface AccessFilters {
  q: string;
  actorRole: '' | 'super_admin' | 'agency';
  /** Solo las entradas que siguen abiertas. */
  open: boolean;
}
export const NO_ACCESS_FILTERS: AccessFilters = { q: '', actorRole: '', open: false };
const PAGE = 25;

export function accessQuery(f: AccessFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.actorRole) p.set('actor_role', f.actorRole);
  if (f.open) p.set('open', 'true');
  p.set('limit', String(PAGE));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** Historial de accesos (solo Súper Admin): quién entró a qué organización, cuándo y cuánto tiempo. */
export function useAccessSessions(f: AccessFilters) {
  return useInfiniteQuery({
    queryKey: ['platform', 'access', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<AccessSessionList>(`/platform/access-sessions?${accessQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}
