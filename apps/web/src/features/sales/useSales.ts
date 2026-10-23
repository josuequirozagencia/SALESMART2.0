import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { newKey, useIdempotencyKey } from '../../lib/idempotency';

export type PaymentMethod = 'cash' | 'transfer' | 'card' | 'other';
export { newKey, useIdempotencyKey };
export const METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'Efectivo', transfer: 'Transferencia', card: 'Tarjeta', other: 'Otro' };

export interface Person { id: string; name: string }
export interface Sale {
  id: string;
  contact: { id: string; name: string };
  conversation_id: string | null;
  product: { id: string; name: string; kind: 'product' | 'service' };
  quantity: number;
  amount: string;
  currency: string;
  paid: string;
  balance: string;
  collected: boolean;
  status: 'active' | 'cancelled';
  seller: Person | null;
  note: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  open_requests: number;
  purchase: string | null;
}
export interface Payment { id: string; kind: 'payment' | 'correction'; amount: string; method: PaymentMethod | null; note: string | null; reason: string | null; by: Person | null; created_at: string }
export interface ChangeRequest {
  id: string;
  sale_id: string;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  requested_by: Person | null;
  resolved_by: Person | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}
export interface SaleDetail extends Sale {
  payments: Payment[];
  history: Array<{ from: string | null; to: string; reason: string | null; by: Person | null; at: string }>;
  change_requests: ChangeRequest[];
  purchase_at_cancel: string | null;
  can: { pay: boolean; cancel: boolean; correct: boolean; request_change: boolean };
}
export interface SaleList { items: Sale[]; next_cursor: string | null }
export interface SaleOptions {
  currency: string;
  queue: { id: string; name: string } | null;
  products: Array<{ id: string; name: string; kind: 'product' | 'service'; price: string }>;
  blocked: 'no_queue' | 'no_products' | 'unassigned' | 'not_owner' | null;
}
export interface SaleFilters { status: '' | 'active' | 'cancelled'; collected: '' | 'yes' | 'no' }
export interface RequestRow extends ChangeRequest { sale: { id: string; contact: string; amount: string; currency: string } }

const idem = (key: string): Record<string, string> => ({ 'idempotency-key': key });

export function useSaleOptions(conversationId: string, enabled: boolean) {
  return useQuery({ queryKey: ['sale-options', conversationId], enabled, staleTime: 0, retry: false, queryFn: () => api<SaleOptions>(`/sales/options?conversation_id=${conversationId}`) });
}

export function useSales(f: SaleFilters) {
  return useQuery({
    queryKey: ['sales', f],
    retry: false,
    queryFn: () => {
      const p = new URLSearchParams({ limit: '50' });
      if (f.status) p.set('status', f.status);
      if (f.collected) p.set('collected', f.collected);
      return api<SaleList>(`/sales?${p.toString()}`);
    },
  });
}

export function useSale(id: string | undefined) {
  return useQuery({ queryKey: ['sale', id], enabled: !!id, retry: false, queryFn: () => api<SaleDetail>(`/sales/${id}`) });
}

export function useSalesSettings() {
  return useQuery({ queryKey: ['sales-settings'], retry: false, queryFn: () => api<{ currency: string; locked: boolean }>('/sales/settings') });
}

export function useChangeRequests(enabled: boolean) {
  return useQuery({ queryKey: ['sale-requests'], enabled, retry: false, queryFn: () => api<{ items: RequestRow[] }>('/sales/change-requests') });
}

function useDone() {
  const qc = useQueryClient();
  // Una venta mueve etiquetas, oportunidades y el SLA de la conversación
  return () => Promise.all(['sales', 'sale', 'sale-requests', 'sales-settings', 'conversation', 'conversations', 'opportunities', 'contacts'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

export interface CreateSaleInput { conversation_id: string; product_id: string; quantity: number; amount: string; down_payment?: string; method?: PaymentMethod; note?: string }
export function useCreateSale() {
  const done = useDone();
  return useMutation({ mutationFn: ({ key, input }: { key: string; input: CreateSaleInput }) => api<Sale>('/sales', { method: 'POST', body: input, headers: idem(key) }), onSettled: done });
}

export function useAddPayment(saleId: string) {
  const done = useDone();
  return useMutation({ mutationFn: ({ key, input }: { key: string; input: { amount: string; method: PaymentMethod; note?: string } }) => api<SaleDetail>(`/sales/${saleId}/payments`, { method: 'POST', body: input, headers: idem(key) }), onSettled: done });
}

export function useCorrectPayment(saleId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (input: { amount: string; reason: string }) => api<SaleDetail>(`/sales/${saleId}/corrections`, { method: 'POST', body: input }), onSettled: done });
}

export function useCancelSale(saleId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (reason: string) => api<SaleDetail>(`/sales/${saleId}/cancel`, { method: 'POST', body: { reason } }), onSettled: done });
}

export function useRequestChange(saleId: string) {
  const done = useDone();
  return useMutation({ mutationFn: (reason: string) => api<ChangeRequest>(`/sales/${saleId}/change-requests`, { method: 'POST', body: { reason } }), onSettled: done });
}

export function useResolveRequest() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, status, note }: { id: string; status: 'resolved' | 'dismissed'; note?: string }) => api<ChangeRequest>(`/sales/change-requests/${id}/resolve`, { method: 'POST', body: { status, ...(note ? { note } : {}) } }), onSettled: done });
}

export function useSetCurrency() {
  const done = useDone();
  return useMutation({ mutationFn: (currency: string) => api<{ currency: string; locked: boolean }>('/sales/settings', { method: 'PUT', body: { currency } }), onSettled: done });
}
