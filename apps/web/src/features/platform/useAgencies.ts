import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AgencyList, AgencyState, AssignAgencyResult, OwnershipHistoryItem } from '../../lib/types';

export interface AgencyFilters {
  q: string;
  state: '' | AgencyState;
}
export const NO_AGENCY_FILTERS: AgencyFilters = { q: '', state: '' };
const PAGE = 25;

export function agenciesQuery(f: AgencyFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.state) p.set('state', f.state);
  p.set('limit', String(PAGE));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export function useAgencies(f: AgencyFilters) {
  return useInfiniteQuery({
    queryKey: ['platform', 'agencies', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<AgencyList>(`/platform/agencies?${agenciesQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Todas las agencias (hasta 100) para los selectores de administración. */
export function useAgencyOptions() {
  return useQuery({
    queryKey: ['platform', 'agencies', 'options'],
    queryFn: () => api<AgencyList>('/platform/agencies?limit=100'),
  });
}

export function useAgencyHistory(id: string) {
  return useQuery({
    queryKey: ['platform', 'agencies', 'history', id],
    queryFn: () => api<{ items: OwnershipHistoryItem[] }>(`/platform/agencies/${id}/history`),
  });
}

/** Suspender o reactivar una agencia (revoca o restituye sus accesos a los clientes). Refresca agencias y empresas. */
export function useSetAgencySuspended() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, suspended }: { id: string; suspended: boolean }) => api<{ id: string; state: string; changed: boolean }>(`/platform/agencies/${id}/${suspended ? 'suspend' : 'reactivate'}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}

export interface AssignAgencyInput {
  /** Empresa cliente a administrar. */
  id: string;
  agencyId: string | null;
  reason?: string;
  notifyClient: boolean;
}

/** Cambiar quién administra a un cliente (una agencia o administración directa). Refresca empresas, agencias e historiales. */
export function useAssignAgency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, agencyId, reason, notifyClient }: AssignAgencyInput) =>
      api<AssignAgencyResult>(`/platform/organizations/${id}/agency`, { method: 'PUT', body: { agency_id: agencyId, notify_client: notifyClient, ...(reason?.trim() ? { reason: reason.trim() } : {}) } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}
