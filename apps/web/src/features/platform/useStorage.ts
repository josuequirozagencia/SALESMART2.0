import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface StoragePlan { id: string; name: string; extra_bytes: number; price_amount: string; currency: string; period: 'monthly'; active: boolean; sort: number }
export interface QuotaSummary { included_bytes: number; extra_bytes: number; effective_bytes: number; next_expiry_at: string | null }
export interface SpaceRequest { id: string; plan_id: string | null; plan_name: string | null; status: string; note: string | null; created_at: string }
export interface CompanySpace { id: string; name: string; state: string; quota: QuotaSummary; open_request: SpaceRequest | null }
export interface StorageGrant {
  id: string; kind: 'grant' | 'revoke'; plan_name: string; extra_bytes: number; price_amount: string | null; currency: string | null; starts_at: string; ends_at: string | null;
  revokes_grant_id: string | null; origin: 'manual' | 'payment'; reason: string | null; created_at: string; active: boolean; revoked: boolean;
}

export interface PlanInput { name: string; extra_gb: number; price_amount: string; currency: string; active: boolean; sort: number }
export interface GrantInput { plan_id?: string; extra_gb?: number; ends_at?: string | null; reason?: string }

export const usePlatformStoragePlans = () => useQuery({ queryKey: ['platform', 'storage', 'plans'], queryFn: () => api<{ items: StoragePlan[] }>('/platform/storage-plans') });
export const useSpaceRequests = () => useQuery({ queryKey: ['platform', 'storage', 'requests'], queryFn: () => api<{ items: CompanySpace[]; truncated: boolean }>('/platform/storage-requests') });
export const useCompaniesSpace = () => useQuery({ queryKey: ['platform', 'storage', 'companies'], queryFn: () => api<{ items: CompanySpace[]; truncated: boolean }>('/platform/storage-companies') });
export const useCompanyGrants = (orgId: string) => useQuery({ queryKey: ['platform', 'storage', 'grants', orgId], queryFn: () => api<{ items: StorageGrant[]; quota: QuotaSummary }>(`/platform/companies/${orgId}/storage-grants`) });

/** Todo lo que cambia el espacio refresca el catálogo, las solicitudes y las empresas. */
export function useStorageMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['platform', 'storage'] });
  return {
    createPlan: useMutation({ mutationFn: (b: PlanInput) => api<StoragePlan>('/platform/storage-plans', { method: 'POST', body: b }), onSettled: done }),
    updatePlan: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<PlanInput> }) => api<StoragePlan>(`/platform/storage-plans/${id}`, { method: 'PATCH', body: patch }), onSettled: done }),
    grant: useMutation({ mutationFn: ({ orgId, body, key }: { orgId: string; body: GrantInput; key: string }) => api<{ item: StorageGrant; replayed: boolean }>(`/platform/companies/${orgId}/storage-grants`, { method: 'POST', body, headers: { 'Idempotency-Key': key } }), onSettled: done }),
    revoke: useMutation({ mutationFn: ({ orgId, grantId, reason }: { orgId: string; grantId: string; reason: string }) => api<{ item: StorageGrant }>(`/platform/companies/${orgId}/storage-grants/${grantId}/revoke`, { method: 'POST', body: { reason } }), onSettled: done }),
    dismiss: useMutation({ mutationFn: (orgId: string) => api<{ dismissed: boolean }>(`/platform/companies/${orgId}/storage-request/dismiss`, { method: 'POST' }), onSettled: done }),
  };
}
