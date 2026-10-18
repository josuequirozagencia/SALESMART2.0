import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { OpportunityDetail, OpportunityPage, StageSummary } from '../../lib/types';

/** Filtros del tablero (ADR-49 #7). `owner`: '' = todos · 'me' · 'none' · id de una persona (solo quien ve todo). */
export interface OpportunityFilters {
  q: string;
  owner: string;
  source: string;
  /** El contacto debe tener TODAS estas etiquetas. */
  tags: string[];
  /** Valor mínimo, como lo escribe la persona. */
  min: string;
}
export const NO_OPP_FILTERS: OpportunityFilters = { q: '', owner: '', source: '', tags: [], min: '' };

export const hasOppFilters = (f: OpportunityFilters): boolean => f.q.trim() !== '' || f.owner !== '' || f.source !== '' || f.tags.length > 0 || f.min.trim() !== '';
export const countOppFilters = (f: OpportunityFilters): number => [f.q.trim() !== '', f.owner !== '', f.source !== '', f.tags.length > 0, f.min.trim() !== ''].filter(Boolean).length;

/** Parámetros de consulta de los filtros (los vacíos no se envían). */
export function filterParams(f: OpportunityFilters, p = new URLSearchParams()): URLSearchParams {
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.owner) p.set('owner', f.owner);
  if (f.source) p.set('source', f.source);
  for (const t of f.tags) p.append('tag', t);
  const min = Number(f.min.replace(',', '.'));
  if (f.min.trim() !== '' && Number.isFinite(min) && min > 0) p.set('min', String(min));
  return p;
}

/** Una columna del tablero: las oportunidades de UNA etapa, la más reciente primero. */
export function useStageOpportunities(pipelineId: string, stageId: string, f: OpportunityFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['opportunities', 'stage', stageId, f],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const p = filterParams(f);
      p.set('pipeline', pipelineId);
      p.set('stage', stageId);
      p.set('limit', '20');
      if (pageParam) p.set('cursor', pageParam);
      return api<OpportunityPage>(`/opportunities?${p.toString()}`);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Cuántas oportunidades y cuánto valen en cada etapa, con los mismos filtros. */
export function usePipelineSummary(pipelineId: string | undefined, f: OpportunityFilters) {
  return useQuery({
    queryKey: ['opportunities', 'summary', pipelineId, f],
    enabled: pipelineId !== undefined,
    placeholderData: keepPreviousData,
    queryFn: async () => (await api<{ items: StageSummary[] }>(`/pipelines/${pipelineId}/summary?${filterParams(f).toString()}`)).items,
  });
}

/** Oportunidades de un contacto (todas, abiertas y cerradas). */
export function useContactOpportunities(contactId: string) {
  return useQuery({ queryKey: ['opportunities', 'contact', contactId], queryFn: () => api<OpportunityPage>(`/opportunities?contact=${contactId}&limit=50`) });
}

export function useOpportunity(id: string | null) {
  return useQuery({ queryKey: ['opportunities', 'detail', id], enabled: id !== null, queryFn: () => api<OpportunityDetail>(`/opportunities/${id}`) });
}

/** Cualquier cambio refresca el tablero, los resúmenes, los conteos de pipelines y las fichas. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['opportunities'] }), qc.invalidateQueries({ queryKey: ['pipelines'] })]);
}

export interface NewOpportunityInput {
  contact_id: string;
  pipeline_id?: string;
  stage_id?: string;
  amount?: string;
  owner_id?: string | null;
}

export function useCreateOpportunity() {
  const done = useRefresh();
  return useMutation({ mutationFn: (input: NewOpportunityInput) => api<OpportunityDetail>('/opportunities', { method: 'POST', body: input }), onSettled: done });
}
export function useUpdateOpportunity() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ id, patch }: { id: string; patch: { amount?: string; owner_id?: string | null } }) => api<OpportunityDetail>(`/opportunities/${id}`, { method: 'PATCH', body: patch }), onSettled: done });
}
export function useMoveOpportunity() {
  const done = useRefresh();
  return useMutation({
    mutationFn: ({ id, stageId, reason }: { id: string; stageId: string; reason?: string }) => api<OpportunityDetail>(`/opportunities/${id}/move`, { method: 'POST', body: { stage_id: stageId, ...(reason ? { lost_reason: reason } : {}) } }),
    onSettled: done,
  });
}
export function useDeleteOpportunity() {
  const done = useRefresh();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/opportunities/${id}`, { method: 'DELETE' }), onSettled: done });
}
