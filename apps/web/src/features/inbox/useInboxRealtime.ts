import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import { playIncomingSound, soundEnabled } from '../../lib/notifySound';
import { PRESENCE_HEARTBEAT_MS, reportPresence, startRealtime } from '../../lib/realtime';
import { recordMissingGaveUp, recordMissingRetry } from '../../lib/realtimeStats';
import type { ChatMessagePage, Conversation } from '../../lib/types';

/** Junta los avisos que llegan en ráfaga (un mensaje nuevo suele traer tres) y vuelve a pedir lo afectado una sola vez. */
const COALESCE_MS = 300;
/** Si el aviso anunciaba un mensaje que al pedir el hilo aún no estaba (el dato se confirmó un instante después), se vuelve a pedir a estos plazos y luego se deja al respaldo. */
export const MISSING_RETRY_MS = [1_200, 3_500] as const;

/**
 * ¿El hilo abierto de esa conversación ya trae ese mensaje? `true` también cuando el hilo no está en memoria (no está abierto: no hay nada que reintentar). Función pura sobre la caché.
 */
export function threadHasMessage(qc: QueryClient, conversationId: string, messageId: string): boolean {
  const data = qc.getQueryData<InfiniteData<ChatMessagePage>>(['messages', conversationId]);
  if (!data) return true;
  return data.pages.some((p) => p.items.some((m) => m.id === messageId));
}

/**
 * Conexión en vivo del Inbox (M5.7). Cada aviso trae solo identificadores: aquí se marcan como desactualizados el listado y lo abierto de esa conversación, y
 * la API (que aplica la visibilidad de siempre) entrega el dato nuevo. Al recuperar la conexión tras una caída se vuelve a pedir todo lo abierto: pudo perderse algo.
 * Se reinicia al cambiar de persona o de empresa (agencia, soporte): nunca queda una conexión de la empresa anterior.
 */
export function useInboxRealtime(userId: string, organizationId: string, pathname = ''): void {
  const qc = useQueryClient();
  // La ruta actual, para no sonar por la conversación que la persona ya está mirando (sin reiniciar la conexión al navegar)
  const here = useRef(pathname);
  useEffect(() => {
    here.current = pathname;
  }, [pathname]);
  // v13 S4.1: presencia. Se dice qué conversación está abierta y si la pestaña está a la vista, al cambiar de pantalla, al cambiar de pestaña y cada 10 s mientras se ve. Nada de esto abre
  // permisos: solo sirve para que el servidor no mande una notificación del sistema de lo que la persona ya está leyendo.
  useEffect(() => {
    const open = /^\/inbox\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(pathname)?.[1] ?? null;
    const say = (): void => reportPresence(open, document.visibilityState === 'visible');
    say();
    const beat = setInterval(() => { if (document.visibilityState === 'visible') say(); }, PRESENCE_HEARTBEAT_MS);
    const onHide = (): void => reportPresence(open, false);
    document.addEventListener('visibilitychange', say);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('focus', say);
    return () => {
      clearInterval(beat);
      document.removeEventListener('visibilitychange', say);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('focus', say);
    };
  }, [pathname]);
  useEffect(() => {
    const conversations = new Set<string>();
    const lastSound = new Map<string, string>();
    /**
     * Sonido de mensaje entrante: solo si llegó un mensaje NUEVO del cliente (el último de la conversación es entrante: lo propio, las notas internas y los automáticos salen como «out»), la persona
     * lo tiene activado y no está mirando esa conversación con la pestaña visible. Una vez por mensaje.
     */
    const maybeSound = async (id: string): Promise<void> => {
      if (!soundEnabled(userId, organizationId)) return;
      try {
        const c = await qc.fetchQuery({ queryKey: ['conversation', id], staleTime: 0, queryFn: () => api<Conversation>(`/conversations/${id}`) });
        const last = c.last_message;
        if (!last || last.direction !== 'in' || lastSound.get(id) === last.at) return;
        lastSound.set(id, last.at);
        if (document.visibilityState === 'visible' && here.current.startsWith(`/inbox/${id}`)) return;
        playIncomingSound();
      } catch {
        // sin permiso para verla o sin red: no suena
      }
    };
    /** Mensajes nuevos anunciados por conversación, a comprobar después de pedir el hilo. */
    const announced = new Map<string, Set<string>>();
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    const verify = (conversationId: string, messageId: string, attempt: number): void => {
      const wait = MISSING_RETRY_MS[attempt];
      if (wait === undefined) return;
      const t = setTimeout(() => {
        retryTimers.delete(t);
        if (threadHasMessage(qc, conversationId, messageId)) return;
        recordMissingRetry();
        void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
        void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
        if (attempt + 1 < MISSING_RETRY_MS.length) verify(conversationId, messageId, attempt + 1);
        else {
          const last = setTimeout(() => {
            retryTimers.delete(last);
            if (!threadHasMessage(qc, conversationId, messageId)) recordMissingGaveUp();
          }, 1_500);
          retryTimers.add(last);
        }
      }, wait);
      retryTimers.add(t);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      timer = undefined;
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['inbox-unread'] });
      for (const id of conversations) {
        void qc.invalidateQueries({ queryKey: ['conversation', id] });
        void qc.invalidateQueries({ queryKey: ['messages', id] });
        void qc.invalidateQueries({ queryKey: ['scheduled', id] });
        void qc.invalidateQueries({ queryKey: ['conversation-ai', id] });
      }
      // La vista global de programados (M5.10) cuelga de ['scheduled', 'all', …]: cualquier cambio de una conversación puede moverla
      if (conversations.size > 0) void qc.invalidateQueries({ queryKey: ['scheduled', 'all'] });
      conversations.clear();
      for (const [conversationId, ids] of announced) for (const id of ids) verify(conversationId, id, 0);
      announced.clear();
    };
    const stop = startRealtime({
      onChange: ({ conversationId, event, messageId }) => {
        if (event === 'message.created') {
          void maybeSound(conversationId);
          if (messageId) announced.set(conversationId, (announced.get(conversationId) ?? new Set<string>()).add(messageId));
        }
        conversations.add(conversationId);
        timer ??= setTimeout(flush, COALESCE_MS);
      },
      onNotification: () => {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
      },
      onResync: () => {
        for (const key of ['conversations', 'inbox-unread', 'conversation', 'messages', 'scheduled', 'conversation-ai', 'notifications']) void qc.invalidateQueries({ queryKey: [key] });
      },
    });
    return () => {
      clearTimeout(timer);
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.clear();
      stop();
    };
  }, [qc, userId, organizationId]);
}
