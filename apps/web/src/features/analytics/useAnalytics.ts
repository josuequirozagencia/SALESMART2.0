import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload, type Download } from '../../lib/api';
import { useNow } from '../../lib/useNow';

export interface Summary {
  period: { from: string; to: string };
  timezone: string;
  currency: string;
  /** `all` = toda la empresa; `own` = solo lo de la persona. */
  scope: 'all' | 'own';
  leads: number;
  appointments: { total: number; scheduled: number; completed: number; cancelled: number };
  sales: { count: number; cancelled: number; revenue: string; paid: string; balance: string };
  funnel: Array<{ pipeline_id: string; pipeline: string; stage_id: string; stage: string; kind: 'open' | 'won' | 'lost'; count: number; amount: string }>;
  response: { count: number; avg_seconds: number; median_seconds: number };
  series: Array<{ day: string; leads: number; sales: number; revenue: string }>;
  access: Access;
}
/** Lo que el servidor deja hacer a la persona: descargar CSV y administrar (ver las descargas y decidir si el asesor puede). */
export interface Access { export: boolean; manage: boolean }
export type ReportName = 'sales' | 'appointments' | 'funnel' | 'advisors';
export interface ReportColumn { key: string; label: string; type: 'text' | 'number' | 'money' | 'date' | 'person' | 'status' }
export interface Report {
  report: ReportName;
  title: string;
  period: { from: string; to: string };
  timezone: string;
  currency: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  totals: Record<string, string | number> | null;
  truncated: boolean;
  access: Access;
}
export interface Period { from: string; to: string }

export const PERIODS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: 'Últimos 7 días' },
  { days: 30, label: 'Últimos 30 días' },
  { days: 90, label: 'Últimos 90 días' },
];
const HOUR = 3_600_000;

/**
 * El periodo «últimos N días» hasta el final de la hora en curso: se redondea para que la consulta no cambie (ni se repita) a cada minuto. `to` es exclusivo.
 */
export function usePeriod(days: number): Period {
  const now = useNow(60_000);
  const hour = Math.floor(now / HOUR);
  return useMemo(() => {
    const to = (hour + 1) * HOUR;
    return { from: new Date(to - days * 24 * HOUR).toISOString(), to: new Date(to).toISOString() };
  }, [hour, days]);
}

const range = (p: Period): string => `from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}`;

export function useSummary(p: Period) {
  return useQuery({ queryKey: ['analytics-summary', p], retry: false, queryFn: () => api<Summary>(`/analytics/summary?${range(p)}`) });
}

export function useReport(name: ReportName, p: Period) {
  return useQuery({ queryKey: ['analytics-report', name, p], retry: false, queryFn: () => api<Report>(`/analytics/reports/${name}?${range(p)}`) });
}

export const exportReport = (name: ReportName, p: Period): Promise<Download> => apiDownload('/analytics/export', { method: 'POST', body: { report: name, from: p.from, to: p.to }, fallbackName: `${name}.csv` });

export interface ExportRecord {
  id: string;
  by: { id: string; name: string } | null;
  report: ReportName;
  from: string;
  to: string;
  rows: number;
  scope: 'all' | 'own';
  at: string;
}
interface ExportsPage { items: ExportRecord[]; next_cursor: string | null }

/** Registro de descargas (solo quien administra): de la más reciente a la más antigua, de a 30. */
export function useExportsLog(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['analytics-exports'],
    enabled,
    retry: false,
    initialPageParam: '',
    queryFn: ({ pageParam }) => api<ExportsPage>(`/analytics/exports${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useAdvisorExport(enabled: boolean) {
  return useQuery({ queryKey: ['analytics-settings'], enabled, retry: false, queryFn: () => api<{ advisor_export: boolean }>('/analytics/settings') });
}

export function useSetAdvisorExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (advisor_export: boolean) => api<{ advisor_export: boolean }>('/analytics/settings', { method: 'PUT', body: { advisor_export } }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['analytics-settings'] }), qc.invalidateQueries({ queryKey: ['analytics-report'] }), qc.invalidateQueries({ queryKey: ['analytics-summary'] })]),
  });
}

/** Tras descargar, el registro cambia: se vuelve a pedir la próxima vez que se abra. */
export function useRefreshExports() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['analytics-exports'] });
}
