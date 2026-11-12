import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export type CalendarStatus = 'pending_calendar' | 'connected' | 'needs_reconnect' | 'disconnected';
export type CalendarMode = 'own' | 'existing';
export type CalendarUnavailable = 'provider' | 'encryption' | 'base_url' | 'platform_credentials';

/** Cómo va el envío de las citas a Google (v11 Pista G, 67b). */
export interface CalendarSyncStats {
  pending: number;
  failed: number;
  /** Eventos que la persona borró en Google (se respetan). */
  gone: number;
  synced: number;
  last_synced_at: string | null;
}

export interface CalendarConnection {
  configured: boolean;
  /** ¿Se puede conectar ahora? Si no, `unavailable_reason` dice qué falta. */
  available: boolean;
  unavailable_reason: CalendarUnavailable | null;
  status: CalendarStatus | null;
  mode: CalendarMode | null;
  calendar_name: string | null;
  /** Correo de la cuenta de Google, ENMASCARADO. */
  account: string | null;
  scopes: string[];
  last_error: string | null;
  connected_at: string | null;
  sync?: CalendarSyncStats;
}

export interface CalendarChoice { id: string; name: string; primary: boolean }

/** El resultado con que el servidor devuelve a la persona desde Google (`?calendar=…`). */
export type CalendarOutcome = 'connected' | 'pick' | 'denied' | 'invalid' | 'scopes' | 'unavailable' | 'api' | 'error';
export const OUTCOMES: readonly CalendarOutcome[] = ['connected', 'pick', 'denied', 'invalid', 'scopes', 'unavailable', 'api', 'error'];

export function useCalendarConnection() {
  return useQuery({ queryKey: ['calendar-connection'], retry: false, queryFn: () => api<CalendarConnection>('/calendar/connection') });
}

/** Los calendarios de la cuenta donde se puede escribir (solo mientras falta elegir uno). */
export function useCalendarChoices(enabled: boolean) {
  return useQuery({ queryKey: ['calendar-choices'], enabled, retry: false, queryFn: () => api<{ items: CalendarChoice[] }>('/calendar/calendars') });
}

export function useCalendarMutations() {
  const qc = useQueryClient();
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: ['calendar-connection'] }), qc.invalidateQueries({ queryKey: ['calendar-choices'] })]);
  return {
    start: useMutation({ mutationFn: (mode: CalendarMode) => api<{ url: string }>('/calendar/connection/start', { method: 'POST', body: { mode } }) }),
    choose: useMutation({ mutationFn: (calendarId: string) => api<CalendarConnection>('/calendar/connection/calendar', { method: 'PUT', body: { calendar_id: calendarId } }), onSettled: done }),
    retry: useMutation({ mutationFn: () => api<{ requeued: number }>('/calendar/sync/retry', { method: 'POST' }), onSettled: done }),
    disconnect: useMutation({ mutationFn: () => api<CalendarConnection>('/calendar/connection/disconnect', { method: 'POST' }), onSettled: done }),
  };
}
