import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface OnboardingStep { id: 'channel' | 'advisor' | 'department' | 'agent' | 'form'; label: string; hint: string; done: boolean; to: string }
export interface Onboarding { steps: OnboardingStep[]; done: number; total: number; complete: boolean }

/** Los «Primeros pasos» del administrador (M10.6). Para quien no administra el servidor responde 403 y la tarjeta simplemente no aparece. */
export function useOnboarding(enabled: boolean) {
  return useQuery({ queryKey: ['onboarding'], enabled, retry: false, staleTime: 30_000, queryFn: () => api<Onboarding>('/onboarding') });
}
