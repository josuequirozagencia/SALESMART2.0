import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { Trial } from '../../lib/types';

/** Estado de la prueba de la organización activa. null = la organización no tiene prueba (404). */
export function useTrial(enabled: boolean) {
  return useQuery({
    queryKey: ['trial'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<Trial | null> => {
      try {
        return await api<Trial>('/trials/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
}

/** Pide la única extensión de la cuenta. El servidor decide si procede (409 si ya se usó). */
export function useRequestExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => api<Trial>('/trials/me/extension', { method: 'POST', body: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trial'] }),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'EXTENSION_ALREADY_USED') void qc.invalidateQueries({ queryKey: ['trial'] });
    },
  });
}
