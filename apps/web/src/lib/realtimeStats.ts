import { useSyncExternalStore } from 'react';

/**
 * Lo que este navegador ve del tiempo real (v19 B2): cuántos avisos llegaron, cuándo fue el último, cuánto tardó el aviso en llegar desde que el servidor lo emitió (aproximado: depende del
 * reloj de este equipo) y cuántas veces hubo que volver a pedir un mensaje que el aviso anunciaba pero que aún no estaba. Sirve para MEDIR si el tiempo real llega a la pantalla; no se manda a ningún lado.
 */
export interface RealtimeStats {
  /** Avisos de conversación o mensaje recibidos desde que se abrió la sesión. */
  events: number;
  /** Cuándo llegó el último (milisegundos desde 1970), o null si aún no llegó ninguno. */
  lastEventAt: number | null;
  /** Mediana y máximo (ms) del retraso entre emitir y recibir, de los últimos avisos; null sin datos. */
  lagMedianMs: number | null;
  lagMaxMs: number | null;
  /** Mensajes anunciados que no estaban todavía al pedirlos y se volvieron a pedir. */
  missingRetries: number;
  /** Mensajes anunciados que, tras los reintentos, siguieron sin aparecer. */
  missingGaveUp: number;
}

const KEEP = 50;
const EMPTY: RealtimeStats = { events: 0, lastEventAt: null, lagMedianMs: null, lagMaxMs: null, missingRetries: 0, missingGaveUp: 0 };
let lags: number[] = [];
let state: RealtimeStats = EMPTY;
const listeners = new Set<() => void>();
const emit = (): void => { for (const fn of listeners) fn(); };

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Anota un aviso recibido. `serverAt` es la hora (ISO) con que el servidor lo emitió; si no es legible, solo cuenta el aviso. */
export function recordRealtimeEvent(serverAt: string | undefined, now = Date.now()): void {
  const t = serverAt ? Date.parse(serverAt) : Number.NaN;
  if (Number.isFinite(t)) lags = [...lags, Math.max(0, now - t)].slice(-KEEP);
  state = { ...state, events: state.events + 1, lastEventAt: now, lagMedianMs: median(lags), lagMaxMs: lags.length > 0 ? Math.max(...lags) : null };
  emit();
}

export function recordMissingRetry(): void {
  state = { ...state, missingRetries: state.missingRetries + 1 };
  emit();
}

export function recordMissingGaveUp(): void {
  state = { ...state, missingGaveUp: state.missingGaveUp + 1 };
  emit();
}

/** Borra las cifras (al cerrar sesión o cambiar de empresa). */
export function resetRealtimeStats(): void {
  lags = [];
  state = EMPTY;
  emit();
}

export const getRealtimeStats = (): RealtimeStats => state;
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function useRealtimeStats(): RealtimeStats {
  return useSyncExternalStore(subscribe, getRealtimeStats, getRealtimeStats);
}
