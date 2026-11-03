import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { CompanyCreated, CompanyExport, CompanyExportStatus, CompanyList, CompanyState, DeletionPreview, ExportDownloadLink, InvitationIssued } from '../../lib/types';

export interface CompanyFilters {
  q: string;
  kind: '' | 'client' | 'agency';
  state: '' | CompanyState;
  /** '' = todos · 'none' = sin plan · otro = id del plan */
  plan: string;
  /** '' = todas · 'none' = administración directa · otro = id de la agencia (su cartera) */
  agency: string;
}
export const NO_FILTERS: CompanyFilters = { q: '', kind: '', state: '', plan: '', agency: '' };
const PAGE = 25;

export function companiesQuery(f: CompanyFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.kind) p.set('kind', f.kind);
  if (f.state) p.set('state', f.state);
  if (f.plan) p.set('plan', f.plan);
  if (f.agency) p.set('agency', f.agency);
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
export function useCreateCompany(kind: 'client' | 'agency' = 'client') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NewCompanyInput) => api<CompanyCreated>(kind === 'agency' ? '/platform/agencies' : '/platform/companies', { method: 'POST', body: kind === 'agency' ? { name: input.name, owner_email: input.owner_email, timezone: input.timezone, country: input.country } : input }),
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

/** Lo que se pierde al eliminar una empresa (conteos, plan, si una agencia aún tiene clientes). No cambia nada. */
export function useDeletionPreview(id: string) {
  return useQuery({ queryKey: ['platform', 'deletion-preview', id], queryFn: () => api<DeletionPreview>(`/platform/companies/${id}/deletion-preview`), staleTime: 0, gcTime: 0 });
}

export interface DeleteCompanyInput {
  id: string;
  password: string;
  confirm_name: string;
  reason: string;
}

/** Eliminar una empresa (ADR-59): contraseña del Súper Admin, nombre exacto y motivo. La empresa queda «Eliminada» 7 días antes de borrarse. */
export function useDeleteCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: DeleteCompanyInput) => api<{ id: string; purge_after: string }>(`/platform/companies/${id}/delete`, { method: 'POST', body }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}

/** El estado de la copia completa de una empresa eliminada (F3b). Se consulta solo mientras el diálogo está abierto y se actualiza cada pocos segundos mientras se arma. */
export function useCompanyExport(id: string) {
  return useQuery({
    queryKey: ['platform', 'company-export', id],
    queryFn: () => api<CompanyExportStatus>(`/platform/companies/${id}/export`),
    refetchInterval: (q) => (q.state.data?.export && (q.state.data.export.state === 'queued' || q.state.data.export.state === 'running') ? 4000 : false),
  });
}

export function useRequestCompanyExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => api<CompanyExport>(`/platform/companies/${id}/export`, { method: 'POST', body: { password } }),
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: ['platform', 'company-export', v.id] }),
  });
}

/** Pide la URL firmada de una parte (vale 15 minutos). La descarga la inicia quien llama. */
export function useCompanyExportDownload() {
  return useMutation({
    mutationFn: ({ id, part }: { id: string; part: number }) => api<ExportDownloadLink>(`/platform/companies/${id}/export/download`, { method: 'POST', body: { part } }),
  });
}

/** Recuperar una empresa eliminada dentro de la ventana (ADR-59 #6): vuelve a su estado anterior. */
export function useRecoverCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => api<{ id: string; state: 'active' | 'suspended' }>(`/platform/companies/${id}/recover`, { method: 'POST', body: { password } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}
