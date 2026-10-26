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
      for (const id of conversations) {
        void qc.invalidateQueries({ queryKey: ['conversation', id] });
        void qc.invalidateQueries({ queryKey: ['messages', id] });
        void qc.invalidateQueries({ queryKey: ['scheduled', id] });
        void qc.invalidateQueries({ queryKey: ['conversation-ai', id] });
      }
      conversations.clear();
    };
    const stop = startRealtime({
      onChange: ({ conversationId }) => {
        conversations.add(conversationId);
        timer ??= setTimeout(flush, COALESCE_MS);
      },
      onResync: () => {
        for (const key of ['conversations', 'conversation', 'messages', 'scheduled', 'conversation-ai']) void qc.invalidateQueries({ queryKey: [key] });
      },
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [qc, userId, organizationId]);
}
