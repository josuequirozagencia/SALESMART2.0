import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export type LedgerKind = 'welcome' | 'grant' | 'use' | 'test';
export const KIND_LABEL: Record<LedgerKind, string> = { welcome: 'Bienvenida', grant: 'Regalo', use: 'Uso', test: 'Prueba' };

/** Lo que ve el CLIENTE de un movimiento: créditos y a qué corresponde. Nunca el costo ni el margen. */
export interface LedgerItem {
  id: string;
  kind: LedgerKind;
  credits: number;
  balance_after: number;
  ref: string | null;
  created_at: string;
}
export interface CreditsPage<I = LedgerItem> {
  balance: number;
  held: number;
  available: number;
  items: I[];
  next_cursor: string | null;
}

/** Saldo y movimientos de la empresa (el saldo y el apartado vienen en cada página; se muestran los de la primera). */
export function useAiCredits() {
  return useInfiniteQuery({
    queryKey: ['ai-credits'],
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<CreditsPage>(`/ai/credits?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

// ---------------------------------------------------------------- plataforma (Súper Admin)

export interface AiPricing { usd_per_credit: string; global_margin_pct: string; updated_at: string }
export interface AiOrg {
  id: string;
  name: string;
  state: string;
  balance: number;
  held: number;
  granted: number;
  used: number;
  margin_pct: string;
  margin_override: boolean;
}
export interface AiOrgList { items: AiOrg[]; next_cursor: string | null; pricing: AiPricing }
/** Un movimiento visto por el Súper Admin: agrega costo y margen. */
export interface PlatformLedgerItem extends LedgerItem { cost_usd: string | null; margin_pct: string | null; created_by: string | null }

export function useAiOrgs(q: string) {
  return useQuery({ queryKey: ['platform', 'ai', 'orgs', q], retry: false, queryFn: () => api<AiOrgList>(`/platform/ai/organizations?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
}

export function useAiLedger(orgId: string) {
  return useInfiniteQuery({
    queryKey: ['platform', 'ai', 'ledger', orgId],
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<CreditsPage<PlatformLedgerItem>>(`/platform/ai/organizations/${orgId}/ledger?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useAiPlatformMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['platform', 'ai'] });
  return {
    setPricing: useMutation({ mutationFn: (b: { usd_per_credit: string; global_margin_pct: string }) => api<AiPricing>('/platform/ai/pricing', { method: 'PUT', body: b }), onSettled: done }),
    setMargin: useMutation({ mutationFn: ({ id, margin_pct }: { id: string; margin_pct: string | null }) => api<{ id: string; margin_pct: string; margin_override: boolean }>(`/platform/ai/organizations/${id}/margin`, { method: 'PUT', body: { margin_pct } }), onSettled: done }),
    grant: useMutation({
      mutationFn: ({ id, credits, note, key }: { id: string; credits: number; note: string; key: string }) =>
        api<{ item: LedgerItem; balance: number; replayed: boolean }>(`/platform/ai/organizations/${id}/grants`, { method: 'POST', body: { credits, note }, headers: { 'Idempotency-Key': key } }),
      onSettled: done,
    }),
  };
}

/** Precio de un modelo de IA (dólares por millón de tokens). SOLO plataforma. */
export interface AiModelPrice { model: string; kind: 'embedding' | 'chat'; usd_per_1m_input: string; usd_per_1m_output: string; updated_at: string }

export function useAiModels() {
  return useQuery({ queryKey: ['platform', 'ai', 'models'], retry: false, queryFn: () => api<AiModelPrice[]>('/platform/ai/models') });
}

export function useSetModelPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ model, usd_per_1m_input, usd_per_1m_output }: { model: string; usd_per_1m_input: string; usd_per_1m_output: string }) => api<AiModelPrice>(`/platform/ai/models/${encodeURIComponent(model)}`, { method: 'PUT', body: { usd_per_1m_input, usd_per_1m_output } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform', 'ai', 'models'] }),
  });
}
