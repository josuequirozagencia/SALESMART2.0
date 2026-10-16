import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ProviderItem, ProvidersList } from '../../lib/types';

const KEY = ['platform', 'providers'] as const;

/** Catálogo de proveedores con su estado. El servidor nunca manda un secreto: solo si existe y su final. */
export function useProviders() {
  return useQuery({ queryKey: KEY, queryFn: () => api<ProvidersList>('/platform/providers') });
}

export interface SaveCredentialsInput {
  service: string;
  provider: string;
  values?: Record<string, string>;
  clear?: string[];
}

/** Guardar (parcialmente) los valores de un proveedor; todos se cifran en el servidor. */
export function useSaveCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ service, provider, values, clear }: SaveCredentialsInput) =>
      api<ProviderItem>(`/platform/providers/${service}/${provider}/credentials`, {
        method: 'PUT',
        body: { ...(values && Object.keys(values).length > 0 ? { values } : {}), ...(clear && clear.length > 0 ? { clear } : {}) },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useClearCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ service, provider }: { service: string; provider: string }) => api<{ cleared: boolean }>(`/platform/providers/${service}/${provider}/credentials`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Elegir el proveedor en uso de un servicio (`null` = ninguno). */
export function useSetActiveProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ service, provider }: { service: string; provider: string | null }) => api<{ active: string | null; changed: boolean }>(`/platform/providers/${service}/active`, { method: 'PUT', body: { provider } }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
