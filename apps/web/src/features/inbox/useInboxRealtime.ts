import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import { playIncomingSound, soundEnabled } from '../../lib/notifySound';
import { PRESENCE_HEARTBEAT_MS, reportPresence, startRealtime } from '../../lib/realtime';
import type { Conversation } from '../../lib/types';

/** Junta los avisos que llegan en ráfaga (un mensaje nuevo suele traer tres) y vuelve a pedir lo afectado una sola vez. */
const COALESCE_MS = 300;

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
    };
    const stop = startRealtime({
      onChange: ({ conversationId, event }) => {
        if (event === 'message.created') void maybeSound(conversationId);
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
      stop();
    };
  }, [qc, userId, organizationId]);
}
