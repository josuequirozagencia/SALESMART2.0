import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Plan, PlanList } from '../../lib/types';

export interface PlanInput {
  name: string;
  description: string | null;
  max_users: number | null;
  max_connections: number | null;
  max_queues: number | null;
  features: Record<string, boolean>;
}

export function usePlans(includeArchived: boolean) {
  return useQuery({
    queryKey: ['platform', 'plans', includeArchived],
    queryFn: () => api<PlanList>(`/platform/plans?include_archived=${includeArchived}`),
  });
}

/** Crear, editar, archivar y restaurar. Todo refresca planes Y empresas (el número de empresas por plan y su estado cambian). */
export function usePlanMutations() {
  const qc = useQueryClient();
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: ['platform', 'plans'] }), qc.invalidateQueries({ queryKey: ['platform', 'companies'] })]);
  return {
    create: useMutation({ mutationFn: (b: PlanInput) => api<Plan>('/platform/plans', { method: 'POST', body: b }), onSettled: done }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<PlanInput> }) => api<Plan>(`/platform/plans/${id}`, { method: 'PATCH', body: patch }), onSettled: done }),
    setArchived: useMutation({ mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api<Plan>(`/platform/plans/${id}/${archived ? 'archive' : 'restore'}`, { method: 'POST' }), onSettled: done }),
  };
}
