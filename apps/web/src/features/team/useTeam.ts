import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AccessResetResult, InviteResult, LeaveInput, LeaveResult, PermissionCatalog, PermissionOverrides, TeamList, TeamMemberFull, TeamRole, WeekHours } from '../../lib/types';

/** Equipo de la empresa e invitaciones pendientes (solo `users.manage`; para el resto el servidor responde 403). */
export function useTeam() {
  return useQuery({ queryKey: ['team'], retry: false, queryFn: () => api<TeamList>('/users') });
}

export function useTeamMember(userId: string) {
  return useQuery({ queryKey: ['team', 'member', userId], retry: false, queryFn: () => api<TeamMemberFull>(`/users/${userId}`) });
}

export function usePermissionCatalog() {
  return useQuery({ queryKey: ['team', 'catalog'], retry: false, staleTime: 5 * 60_000, queryFn: () => api<PermissionCatalog>('/users/permissions/catalog') });
}

/** Cualquier cambio del equipo refresca la lista y la ficha (y los departamentos: muestran sus asesores). */
function useDone() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['team'] }), qc.invalidateQueries({ queryKey: ['queues'] })]);
}

export interface InviteInput { email: string; role: TeamRole; permissions?: PermissionOverrides; queue_ids?: string[] }
export function useInviteMember() {
  const done = useDone();
  return useMutation({ mutationFn: (input: InviteInput) => api<InviteResult>('/users/invitations', { method: 'POST', body: input }), onSettled: done });
}

export function useResendInvitation() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<InviteResult>(`/users/invitations/${id}/resend`, { method: 'POST' }), onSettled: done });
}

export function useCancelInvitation() {
  const done = useDone();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; cancelled: true }>(`/users/invitations/${id}/cancel`, { method: 'POST' }), onSettled: done });
}

export function useSetRole(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (role: TeamRole) => api<TeamMemberFull>(`/users/${userId}`, { method: 'PATCH', body: { role } }), onSettled: done });
}

export function useSetPermissions(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (o: PermissionOverrides) => api<TeamMemberFull>(`/users/${userId}/permissions`, { method: 'PUT', body: o }), onSettled: done });
}

export function useSetDepartments(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (queue_ids: string[]) => api<TeamMemberFull>(`/users/${userId}/departments`, { method: 'PUT', body: { queue_ids } }), onSettled: done });
}

export function useSetHours(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (days: WeekHours | null) => api<TeamMemberFull>(`/users/${userId}/hours`, { method: 'PUT', body: { days } }), onSettled: done });
}

export function useLeaveTeam(userId: string, kind: 'deactivate' | 'remove') {
  const done = useDone();
  return useMutation({ mutationFn: (input: LeaveInput) => api<LeaveResult>(`/users/${userId}/${kind}`, { method: 'POST', body: input }), onSettled: done });
}

export function useReactivateMember(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: () => api<TeamMemberFull>(`/users/${userId}/reactivate`, { method: 'POST' }), onSettled: done });
}

/** Los restablecimientos de acceso de una persona (de la historia del equipo): quién lo hizo (agencia, administrador o plataforma), cuándo y el motivo. */
export interface ResetHistoryItem { at: string; by: 'client_admin' | 'agency' | 'super_admin'; reason: string | null; sessions_revoked: number }
export function useResetHistory(userId: string) {
  return useQuery({
    queryKey: ['team', 'reset-history', userId],
    retry: false,
    queryFn: async (): Promise<ResetHistoryItem[]> => {
      const r = await api<Array<{ at: string; kind: string; user_id: string | null; after: { by?: ResetHistoryItem['by']; reason?: string | null; sessions_revoked?: number } | null }>>('/users/history?limit=200');
      return r.filter((h) => h.kind === 'access_reset' && h.user_id === userId).slice(0, 5).map((h) => ({ at: h.at, by: h.after?.by ?? 'client_admin', reason: h.after?.reason ?? null, sessions_revoked: h.after?.sessions_revoked ?? 0 }));
    },
  });
}

/** ¿Se puede restablecer a esta persona desde aquí? Solo sí o no; sin el permiso el servidor responde 403 y el botón no aparece. */
export function useCanResetAccess(userId: string, enabled: boolean) {
  return useQuery({ queryKey: ['team', 'reset-check', userId], enabled, retry: false, staleTime: 30_000, queryFn: () => api<{ allowed: boolean }>(`/users/${userId}/reset-access`) });
}

export function useResetAccess(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (input: { current_password: string; reason?: string }) => api<AccessResetResult>(`/users/${userId}/reset-access`, { method: 'POST', body: input }), onSettled: done });
}

export function useRevokeSessions(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: () => api<{ user_id: string; sessions_revoked: number }>(`/users/${userId}/sessions/revoke`, { method: 'POST' }), onSettled: done });
}
