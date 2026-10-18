import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Pipeline, PipelineList, StageColor, StageKind } from '../../lib/types';

/** Pipelines de la empresa con sus etapas (también las ocultas). La primera vez el servidor crea «Ventas». */
export function usePipelines() {
  return useQuery({ queryKey: ['pipelines'], staleTime: 15_000, queryFn: () => api<PipelineList>('/pipelines') });
}

/** Cualquier cambio de configuración refresca los pipelines; en M4.2 también el tablero de oportunidades. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['pipelines'] }), qc.invalidateQueries({ queryKey: ['opportunities'] })]);
}

export interface NewStageInput {
  name: string;
  color?: StageColor;
  kind?: 'open' | 'lost';
}
export interface StagePatch {
  name?: string;
  color?: StageColor;
  is_hidden?: boolean;
  kind?: StageKind;
}

export function useCreatePipeline() {
  const done = useRefresh();
  return useMutation({ mutationFn: (name: string) => api<Pipeline>('/pipelines', { method: 'POST', body: { name } }), onSettled: done });
}
export function useUpdatePipeline() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ id, patch }: { id: string; patch: { name?: string; appointment_stage_id?: string | null } }) => api<Pipeline>(`/pipelines/${id}`, { method: 'PATCH', body: patch }), onSettled: done });
}
export function useDeletePipeline() {
  const done = useRefresh();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/pipelines/${id}`, { method: 'DELETE' }), onSettled: done });
}
export function useCreateStage() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ pipelineId, input }: { pipelineId: string; input: NewStageInput }) => api<Pipeline>(`/pipelines/${pipelineId}/stages`, { method: 'POST', body: input }), onSettled: done });
}
export function useUpdateStage() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ id, patch }: { id: string; patch: StagePatch }) => api<Pipeline>(`/pipeline-stages/${id}`, { method: 'PATCH', body: patch }), onSettled: done });
}
export function useDeleteStage() {
  const done = useRefresh();
  return useMutation({ mutationFn: (id: string) => api<Pipeline>(`/pipeline-stages/${id}`, { method: 'DELETE' }), onSettled: done });
}
export function useReorderStages() {
  const done = useRefresh();
  return useMutation({ mutationFn: ({ pipelineId, ids }: { pipelineId: string; ids: string[] }) => api<Pipeline>(`/pipelines/${pipelineId}/stages/order`, { method: 'PUT', body: { ids } }), onSettled: done });
}
