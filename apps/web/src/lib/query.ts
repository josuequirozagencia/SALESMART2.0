import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Cliente de consultas. Si cualquier consulta recibe 403 TRIAL_EXPIRED (la prueba venció con la sesión abierta), se
 * invalida el estado de la prueba para que la app muestre la pantalla de «vencida» sin recargar.
 */
export function createQueryClient(): QueryClient {
  const qc: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'TRIAL_EXPIRED') void qc.invalidateQueries({ queryKey: ['trial'] });
      },
    }),
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return qc;
}
