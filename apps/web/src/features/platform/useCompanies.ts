import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { CompanyCreated, CompanyList, CompanyState, InvitationIssued } from '../../lib/types';

export interface CompanyFilters {
  q: string;
  kind: '' | 'client' | 'agency';
  state: '' | CompanyState;
  /** '' = todos · 'none' = sin plan · otro = id del plan */
  plan: string;
}
export const NO_FILTERS: CompanyFilters = { q: '', kind: '', state: '', plan: '' };
const PAGE = 25;

export function companiesQuery(f: CompanyFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.kind) p.set('kind', f.kind);
  if (f.state) p.set('state', f.state);
  if (f.plan) p.set('plan', f.plan);
  p.set('limit', String(PAGE));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export function useCompanies(f: CompanyFilters) {
  return useInfiniteQuery({
    queryKey: ['platform', 'companies', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<CompanyList>(`/platform/companies?${companiesQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Asignar o quitar el plan de una empresa. Refresca empresas, planes (conteos) y pruebas (la empresa sale de la prueba). */
export function useAssignPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, planId }: { id: string; planId: string | null }) => api(`/platform/companies/${id}/plan`, { method: 'PUT', body: { plan_id: planId } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}

export interface NewCompanyInput {
  name: string;
  owner_email: string;
  timezone: string;
  country: string;
  plan_id: string | null;
}

/** «Nueva empresa» (F01): crea la empresa y la invitación del dueño. La lista y los planes (conteos) se refrescan. */
export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NewCompanyInput) => api<CompanyCreated>('/platform/companies', { method: 'POST', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}

/** Reenvía la invitación pendiente (el enlace anterior deja de valer). */
export function useResendInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<InvitationIssued>(`/platform/companies/${id}/invitation/resend`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}
