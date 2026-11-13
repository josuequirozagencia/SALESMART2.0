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

/** Cada cuánto se repite el latido de presencia mientras la pestaña está a la vista (el servidor lo da por vencido a los 20 s). */
export const PRESENCE_HEARTBEAT_MS = 10_000;

/** Lo último que la persona dijo mirar; se reenvía al reconectar. */
let lastPresence: { conversationId: string | null; visible: boolean } = { conversationId: null, visible: false };
let activeSocket: Socket | null = null;

/**
 * Dice al servidor qué conversación se está mirando (v13 S4.1): `conversationId` la abierta (o null) y `visible` si la pestaña está a la vista (`visibilityState = visible`). Con eso el servidor
 * decide si un mensaje nuevo merece una notificación del sistema. Sin conexión no hace nada (y el servidor, ante la duda, avisa); al reconectar se reenvía lo último.
 */
export function reportPresence(conversationId: string | null, visible: boolean): void {
  lastPresence = { conversationId, visible };
  if (activeSocket?.connected) activeSocket.emit('presence', { conversation_id: conversationId, visible });
}

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
  /** A la persona le llegó un aviso nuevo (F1, ADR-57): solo el id; la lista se vuelve a pedir a la API. */
  onNotification?(): void;
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

  activeSocket = socket;
  socket.on('connect', () => {
    attempt = 0;
    setStatus('live');
    // Lo que se estaba mirando se vuelve a decir (la conexión nueva no sabe nada)
    socket.emit('presence', { conversation_id: lastPresence.conversationId, visible: lastPresence.visible });
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
  socket.on('notification.created', () => h.onNotification?.());
  for (const event of EVENTS) {
    socket.on(event, (body: { data?: { conversation_id?: string; message_id?: string } } | undefined) => {
      const conversationId = body?.data?.conversation_id;
      if (typeof conversationId === 'string') h.onChange({ event, conversationId, messageId: body?.data?.message_id });
    });
  }

  return () => {
    closed = true;
    clearTimeout(timer);
    if (activeSocket === socket) activeSocket = null;
    socket.close();
    setStatus('off');
  };
}
