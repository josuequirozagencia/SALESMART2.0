import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { startRealtime } from '../../lib/realtime';

/** Junta los avisos que llegan en ráfaga (un mensaje nuevo suele traer tres) y vuelve a pedir lo afectado una sola vez. */
const COALESCE_MS = 300;

/**
 * Conexión en vivo del Inbox (M5.7). Cada aviso trae solo identificadores: aquí se marcan como desactualizados el listado y lo abierto de esa conversación, y
 * la API (que aplica la visibilidad de siempre) entrega el dato nuevo. Al recuperar la conexión tras una caída se vuelve a pedir todo lo abierto: pudo perderse algo.
 * Se reinicia al cambiar de persona o de empresa (agencia, soporte): nunca queda una conexión de la empresa anterior.
 */
export function useInboxRealtime(userId: string, organizationId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    const conversations = new Set<string>();
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
      onChange: ({ conversationId }) => {
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
