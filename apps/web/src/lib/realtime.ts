import { useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import { refreshSession, tokens } from './api';

/** Dónde está el tiempo real (Socket.IO en el mismo origen que la API, ADR-36/50). */
export const REALTIME_PATH = '/v1/realtime';

export type RealtimeStatus = 'off' | 'connecting' | 'live' | 'down';
export type RealtimeEventName = 'conversation.created' | 'conversation.updated' | 'message.created' | 'message.updated' | 'scheduled.updated';
export interface RealtimeChange {
  event: RealtimeEventName;
  conversationId: string;
  messageId: string | undefined;
}

const EVENTS: readonly RealtimeEventName[] = ['conversation.created', 'conversation.updated', 'message.created', 'message.updated', 'scheduled.updated'];
/** Espera antes de volver a conectar tras un fallo, creciendo hasta el tope (1, 2, 5, 10 y 30 s). */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

let status: RealtimeStatus = 'off';
const listeners = new Set<() => void>();
function setStatus(next: RealtimeStatus): void {
  if (status === next) return;
  status = next;
  for (const fn of listeners) fn();
}
export const getRealtimeStatus = (): RealtimeStatus => status;
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** Estado de la conexión en vivo: con `live` las pantallas dejan de consultar tan seguido y solo mantienen una consulta lenta de respaldo. */
export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(subscribe, getRealtimeStatus, getRealtimeStatus);
}

interface Handlers {
  /** Algo cambió en una conversación (solo identificadores: lo que cambió se vuelve a pedir a la API). */
  onChange(change: RealtimeChange): void;
  /** Se recuperó la conexión después de una caída: pudo perderse algún aviso, hay que volver a pedir todo lo abierto. */
  onResync(): void;
}

/**
 * Abre la conexión en vivo con la sesión vigente. Si el servidor rechaza la sesión (venció) o la cierra, se renueva y se reconecta con espera creciente;
 * mientras no hay conexión, las pantallas siguen consultando como antes. Devuelve la función que la cierra (al salir o al cambiar de empresa).
 */
export function startRealtime(h: Handlers): () => void {
  let closed = false;
  let attempt = 0;
  let wasDown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  setStatus('connecting');
  const socket: Socket = io({ path: REALTIME_PATH, transports: ['websocket', 'polling'], reconnectionDelayMax: 30_000, auth: (cb) => cb({ token: tokens.get() ?? '' }) });

  const retry = (): void => {
    if (closed) return;
    wasDown = true;
    setStatus('down');
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    attempt += 1;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // La sesión pudo vencer: se renueva antes de volver a intentar (si ya no hay sesión, la app vuelve al inicio de sesión por su cuenta)
      void refreshSession().then((ok) => {
        if (!closed && ok) socket.connect();
        else if (!closed) retry();
      });
    }, wait);
  };

  socket.on('connect', () => {
    attempt = 0;
    setStatus('live');
    if (wasDown) {
      wasDown = false;
      h.onResync();
    }
  });
  socket.on('connect_error', retry);
  socket.on('disconnect', (reason: string) => {
    // Cerrada por el servidor (sesión vencida, demasiadas pestañas): hay que pedir la conexión de nuevo; las demás causas las reintenta la propia librería
    if (reason === 'io server disconnect') retry();
    else if (!closed) {
      wasDown = true;
      setStatus('down');
    }
  });
  for (const event of EVENTS) {
    socket.on(event, (body: { data?: { conversation_id?: string; message_id?: string } } | undefined) => {
      const conversationId = body?.data?.conversation_id;
      if (typeof conversationId === 'string') h.onChange({ event, conversationId, messageId: body?.data?.message_id });
    });
  }

  return () => {
    closed = true;
    clearTimeout(timer);
    socket.close();
    setStatus('off');
  };
}
