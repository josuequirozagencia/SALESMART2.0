import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

export interface CompanyProfile {
  name: string;
  country: string | null;
  timezone: string;
  currency: string;
  currency_locked: boolean;
  currency_locked_reason: string | null;
  legal_name: string | null;
  tax_id: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  description: string | null;
  access: { edit: boolean };
}
export type ProfilePatch = Partial<Omit<CompanyProfile, 'currency' | 'currency_locked' | 'currency_locked_reason' | 'access' | 'country'> & { country: string }>;

const KEY = ['company-profile'] as const;

export function useCompanyProfile() {
  return useQuery({ queryKey: KEY, retry: false, queryFn: () => api<CompanyProfile>('/organization/profile') });
}

/** Guarda un bloque. Si cambió el nombre o la zona, la sesión vuelve a preguntar «quién soy» (menú, banner y selector) y se olvida lo que dependía de ellos. */
export function useSaveCompanyProfile() {
  const qc = useQueryClient();
  const { refreshMe } = useSession();
  return useMutation({
    mutationFn: (patch: ProfilePatch) => api<CompanyProfile>('/organization/profile', { method: 'PATCH', body: patch }),
    onSuccess: async (saved, patch) => {
      qc.setQueryData(KEY, saved);
      if (patch.name === undefined && patch.timezone === undefined) return;
      await Promise.all([refreshMe().catch(() => undefined), ...['context', 'conversation-quick-replies'].map((k) => qc.invalidateQueries({ queryKey: [k] }))]);
    },
  });
}
