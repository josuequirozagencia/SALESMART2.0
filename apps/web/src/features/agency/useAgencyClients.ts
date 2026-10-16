import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { CompanyCreated, CompanyList, CompanyState, InvitationIssued } from '../../lib/types';
import type { NewCompanyInput } from '../platform/useCompanies';

export interface ClientFilters {
  q: string;
  state: '' | CompanyState;
}
export const NO_CLIENT_FILTERS: ClientFilters = { q: '', state: '' };
const PAGE = 25;

export function clientsQuery(f: ClientFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.state) p.set('state', f.state);
  p.set('limit', String(PAGE));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** «Mis clientes»: SOLO la cartera de la agencia del contexto (el servidor la acota; aquí no se envía ningún id de organización). */
export function useAgencyClients(f: ClientFilters) {
  return useInfiniteQuery({
    queryKey: ['agency', 'clients', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<CompanyList>(`/agency/clients?${clientsQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** «Registrar cliente» (F02): crea el cliente en la cartera de la agencia e invita a su dueño. Sin plan: el cliente paga el suyo. */
export function useRegisterClient() {
  const qc = useQueryClient();
  return useMutation({
    // Misma forma que «Nueva empresa»; el plan no existe aquí (el cliente paga el suyo) y NO se envía
    mutationFn: (input: NewCompanyInput) => api<CompanyCreated>('/agency/clients', { method: 'POST', body: { name: input.name, owner_email: input.owner_email, timezone: input.timezone, country: input.country } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['agency'] }),
  });
}

/** Reenvía la invitación pendiente de un cliente de la cartera (el enlace anterior deja de valer). */
export function useResendClientInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<InvitationIssued>(`/agency/clients/${id}/invitation/resend`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['agency'] }),
  });
}
