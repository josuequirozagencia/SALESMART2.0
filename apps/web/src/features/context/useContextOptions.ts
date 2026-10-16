import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ContextOption } from '../../lib/types';

/** Clientes a los que la persona puede entrar con una membresía vigente (hasta 50); `q` filtra por nombre. El servidor decide quién ve qué. */
export function useContextOptions(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['context', 'options', term],
    queryFn: () => api<{ items: ContextOption[] }>(`/context/options${term ? `?q=${encodeURIComponent(term)}` : ''}`),
    placeholderData: keepPreviousData,
  });
}
