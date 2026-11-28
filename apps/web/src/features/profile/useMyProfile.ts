import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { WeekHours } from '../../lib/types';

export interface MyProfile {
  email: string;
  full_name: string | null;
  phone: string | null;
  hours: WeekHours | null;
  time_zone: string | null;
  photo: boolean;
}

const KEY = ['my-profile'] as const;

export function useMyProfile() {
  return useQuery({ queryKey: KEY, retry: false, queryFn: () => api<MyProfile>('/me/profile') });
}

export function useSaveMyProfile() {
  const qc = useQueryClient();
  const { refreshMe } = useSession();
  return useMutation({
    mutationFn: (patch: { full_name?: string; phone?: string }) => api<MyProfile>('/me/profile', { method: 'PATCH', body: patch }),
    onSuccess: async (saved, patch) => {
      qc.setQueryData(KEY, saved);
      if (patch.full_name === undefined) return;
      await Promise.all([refreshMe().catch(() => undefined), qc.invalidateQueries({ queryKey: ['conversation-quick-replies'] })]);
    },
  });
}

export function useChangePassword() {
  return useMutation({ mutationFn: (input: { current_password: string; new_password: string }) => api<void>('/auth/password', { method: 'POST', body: input }) });
}
