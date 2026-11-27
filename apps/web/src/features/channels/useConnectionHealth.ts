import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export type HealthLevel = 'ok' | 'warn' | 'crit';
export type HealthReason = 'lag' | 'silent' | 'failed' | 'backlog' | 'session_down';
export type IgnoredReason = 'group' | 'status' | 'from_me' | 'no_phone' | 'malformed' | 'receipt' | 'unsupported';

export interface FailedEvent {
  id: string;
  received_at: string;
  attempts: number;
  /** Lo que falló, en palabras de la persona. */
  reason: string;
  retryable: boolean;
}

/** La salud de UNA conexión (v19 B1). Solo cifras y motivos fijos: nada de teléfonos ni textos de clientes. */
export interface ConnectionHealth {
  id: string;
  name: string;
  kind: 'whatsapp_official' | 'whatsapp_qr' | 'ghl';
  status: string;
  session: { state: string; down_since: string | null } | null;
  last_event_at: string | null;
  inbound_24h: { count: number; lag_median_s: number | null; lag_p95_s: number | null; lag_max_s: number | null; last_at: string | null };
  recent_lag_median_s: number | null;
  events: { pending: number; overdue: number; failed: number };
  ignored_24h: Partial<Record<IgnoredReason, number>>;
  failed_events: FailedEvent[];
  level: HealthLevel;
  reasons: HealthReason[];
}

export interface HealthList { generated_at: string; connections: ConnectionHealth[] }

/** La salud de las conexiones de la empresa (solo quien administra conexiones). Se refresca sola cada 30 s. */
export function useConnectionHealth(enabled = true) {
  return useQuery({ queryKey: ['connection-health'], enabled, retry: false, refetchInterval: 30_000, queryFn: () => api<HealthList>('/connection-health') });
}

/** Vuelve a poner en cola un aviso fallido. */
export function useRetryEvent() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; status: 'pending' }>(`/connection-health/events/${id}/retry`, { method: 'POST' }), onSettled: () => { void qc.invalidateQueries({ queryKey: ['connection-health'] }); } });
}
