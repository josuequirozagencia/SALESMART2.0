import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface StoragePlanOption { id: string; name: string; extra_bytes: number; price_amount: string; currency: string; period: 'monthly' }
export interface StorageRequest { id: string; plan_id: string | null; plan_name: string | null; status: 'open' | 'granted' | 'dismissed'; note: string | null; created_at: string }

/** Los planes de espacio extra (solo el precio de lista) y la solicitud abierta de la empresa. */
export function useStorageOptions(enabled: boolean) {
  return useQuery({ queryKey: ['library-storage-plans'], enabled, retry: false, queryFn: () => api<{ plans: StoragePlanOption[]; request: StorageRequest | null }>('/library/storage-plans') });
}

/** Pedir más espacio al equipo de la plataforma (una solicitud abierta por empresa). */
export function useRequestSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { plan_id?: string; note?: string }) => api<StorageRequest>('/library/storage-requests', { method: 'POST', body: b }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['library'] }), qc.invalidateQueries({ queryKey: ['library-storage-plans'] })]),
  });
}
