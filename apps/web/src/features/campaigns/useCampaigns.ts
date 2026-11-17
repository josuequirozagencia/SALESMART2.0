import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { newKey, useIdempotencyKey } from '../../lib/idempotency';

export { useIdempotencyKey, newKey };

export type ChannelKind = 'official' | 'qr';
export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
/** Por qué un contacto de la audiencia no recibirá el mensaje (ADR-72). */
export type AudienceState = 'eligible' | 'revoked' | 'excluded' | 'no_phone' | 'no_consent' | 'duplicate';

/** De dónde salen los destinatarios (las «bases» del prototipo): toda la base visible o una lista guardada; `excluded_contact_ids` son los que se desmarcaron a mano. */
export interface CampaignAudience {
  source: 'all' | 'list';
  list_id?: string;
  excluded_contact_ids?: string[];
}

export interface CampaignCounts {
  total: number;
  by_status: Record<string, number>;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  status_reason: string | null;
  mode: 'template' | 'text';
  channel: { id: string; name: string; kind: ChannelKind } | null;
  template_id: string | null;
  template_params: Record<string, string>;
  body: string | null;
  audience: CampaignAudience & { source: string };
  include_unknown_consent: boolean;
  scheduled_at: string | null;
  gap_seconds: number;
  daily_cap: number;
  created_by: { id: string; name: string };
  created_at: string;
  updated_at: string;
  launched_at: string | null;
  finished_at: string | null;
  counts: CampaignCounts;
  can_edit: boolean;
}
export interface CampaignList { items: Campaign[]; next_cursor: string | null }

export interface CampaignAccessInfo { plan_enabled: boolean; read: boolean; send: boolean; view_all: boolean; manage_limits: boolean }
export interface CampaignOptions {
  channels: Array<{ id: string; name: string; kind: ChannelKind }>;
  limits: { official_daily_cap: number; qr_min_gap_seconds: number; official_min_gap_seconds: number; advisor_daily_cap: number | null; max_audience: number };
}
export interface CampaignTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  header: { format: string; text: string | null } | null;
  footer: string | null;
  variables: Array<{ id: string; part: string; key: string; example: string | null }>;
}

export interface CampaignPreview {
  campaign_id: string | null;
  audience: { in_scope: number; out_of_scope: number; eligible: number; skipped: { revoked: number; excluded: number; no_phone: number; no_consent: number; duplicate: number }; sample: Array<{ id: string; name: string }> };
  limits: { channel_kind: ChannelKind; daily_cap: number; channel_cap: number; advisor_cap: number | null; min_gap_seconds: number } | null;
  estimate: { days: number; first_day_minutes: number } | null;
  message: { text: string; missing: string[]; contact: { id: string; name: string } } | null;
  warnings: Array<'official_marketing_cost' | 'qr_unofficial_risk' | 'unknown_consent_included' | 'spans_days'>;
}

export interface AudienceItem { id: string; name: string; phone: string | null; state: AudienceState }
export interface AudiencePage { items: AudienceItem[]; total: number; next_cursor: string | null }

/** Lo que se manda a crear o editar un borrador (el servidor vuelve a validar todo). */
export interface CampaignInput {
  name: string;
  channel_id: string;
  mode: 'template' | 'text';
  template_id?: string | null;
  template_params?: Record<string, string>;
  body?: string | null;
  audience: CampaignAudience;
  include_unknown_consent?: boolean;
  scheduled_at?: string | null;
  gap_seconds: number;
  daily_cap: number;
}

export interface PreviewInput {
  audience: CampaignAudience;
  include_unknown_consent?: boolean;
  channel_id?: string | null;
  mode?: 'template' | 'text' | null;
  template_id?: string | null;
  template_params?: Record<string, string>;
  body?: string | null;
  gap_seconds?: number | null;
  daily_cap?: number | null;
}

const idem = (key: string): Record<string, string> => ({ 'idempotency-key': key });

/** Qué puede hacer la persona con campañas y si su plan las incluye: el menú y la pantalla se arman con esto. No trae datos de la empresa. */
export function useCampaignAccess() {
  return useQuery({ queryKey: ['campaigns', 'access'], staleTime: 60_000, retry: false, queryFn: () => api<CampaignAccessInfo>('/campaigns/access') });
}

export function useCampaignOptions(enabled: boolean) {
  return useQuery({ queryKey: ['campaigns', 'options'], enabled, staleTime: 15_000, retry: false, queryFn: () => api<CampaignOptions>('/campaigns/options') });
}

export function useCampaigns(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['campaigns', 'list'],
    enabled,
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<CampaignList>(`/campaigns?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useCampaignTemplates(channelId: string | null) {
  return useQuery({ queryKey: ['campaigns', 'templates', channelId], enabled: !!channelId, staleTime: 30_000, retry: false, queryFn: () => api<{ items: CampaignTemplate[] }>(`/campaigns/channels/${channelId}/templates`) });
}

/** Vista previa EN VIVO (sin borrador guardado). Conserva la anterior mientras llega la nueva: los números no parpadean al escribir. */
export function useLivePreview(input: PreviewInput | null) {
  return useQuery({
    queryKey: ['campaigns', 'preview', input],
    enabled: input !== null,
    staleTime: 10_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => api<CampaignPreview>('/campaigns/preview', { method: 'POST', body: input }),
  });
}

/** La lista de destinatarios, por páginas. Las exclusiones a mano NO van en la llave: se aplican en pantalla para no volver a pedir la lista con cada casilla. */
export function useAudienceList(audience: Pick<CampaignAudience, 'source' | 'list_id'> | null, includeUnknown: boolean) {
  return useInfiniteQuery({
    queryKey: ['campaigns', 'audience', audience, includeUnknown],
    enabled: audience !== null,
    staleTime: 15_000,
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<AudiencePage>('/campaigns/audience', { method: 'POST', body: { audience, include_unknown_consent: includeUnknown, limit: 100, ...(pageParam ? { cursor: pageParam } : {}) } }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

/** Trae TODOS los contactos de la audiencia que reciben el mensaje (para «Ninguno»: desmarcarlos a todos). */
export async function fetchEligibleIds(audience: Pick<CampaignAudience, 'source' | 'list_id'>, includeUnknown: boolean): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api<AudiencePage>('/campaigns/audience', { method: 'POST', body: { audience, include_unknown_consent: includeUnknown, limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const i of page.items) if (i.state === 'eligible') out.push(i.id);
    if (!page.next_cursor) return out;
    cursor = page.next_cursor;
  }
}

function useDone() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['campaigns'] });
}

export function useCreateCampaign() {
  const done = useDone();
  return useMutation({ mutationFn: ({ key, input }: { key: string; input: CampaignInput }) => api<Campaign>('/campaigns', { method: 'POST', body: input, headers: idem(key) }), onSettled: done });
}

export function useUpdateCampaign(id: string) {
  const done = useDone();
  return useMutation({ mutationFn: (input: Partial<CampaignInput>) => api<Campaign>(`/campaigns/${id}`, { method: 'PATCH', body: input }), onSettled: done });
}

export function useDuplicateCampaign() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, key }: { id: string; key: string }) => api<Campaign>(`/campaigns/${id}/duplicate`, { method: 'POST', headers: idem(key) }), onSettled: done });
}

export function useAdvisorLimits(enabled: boolean) {
  return useQuery({ queryKey: ['campaigns', 'advisor-limits'], enabled, staleTime: 15_000, retry: false, queryFn: () => api<{ items: Array<{ user_id: string; daily_cap: number; updated_at: string }> }>('/campaigns/advisor-limits') });
}

export function useSetAdvisorLimit(userId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (daily_cap: number) => api<{ user_id: string; daily_cap: number }>(`/campaigns/advisor-limits/${userId}`, { method: 'PUT', body: { daily_cap } }), onSettled: done });
}
