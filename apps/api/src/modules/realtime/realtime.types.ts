/** Sala de una persona dentro de UNA empresa: una sesión que cambia de empresa (agencia, soporte) se reconecta y entra en otra sala, nunca en la anterior. */
export const personRoom = (organizationId: string, userId: string): string => `org:${organizationId}:user:${userId}`;

export type RealtimeEvent = 'conversation.created' | 'conversation.updated' | 'message.created' | 'message.updated' | 'scheduled.updated' | 'notification.created';

/**
 * Sobre de todo evento. `data` lleva SOLO identificadores: el cliente vuelve a pedir lo que cambió por la API normal, que aplica la visibilidad y el
 * aislamiento de siempre. Así un evento mal dirigido no puede filtrar contenido.
 */
export interface RealtimeEnvelope {
  organization_id: string;
  request_id: string;
  at: string;
  /** Eventos de una conversación llevan `conversation_id` (y a veces `message_id`); el aviso nuevo de una persona (F1, ADR-57) lleva solo `notification_id`. */
  data: { conversation_id?: string; message_id?: string; notification_id?: string };
}

export interface TouchOptions {
  /** La conversación acaba de crearse. */
  created?: boolean;
  /** Mensajes de la conversación que se crearon o cambiaron (id y qué pasó). */
  message?: { id: string; kind: 'created' | 'updated' };
  /** El mensaje `message` es un mensaje ENTRANTE del cliente: además del aviso en vivo, genera la notificación push (ADR-64). */
  inbound?: boolean;
  /** Cambiaron los mensajes programados de la conversación. */
  scheduled?: boolean;
  /** Personas que deben enterarse aunque ya no vean la conversación (p. ej. quien la tenía antes de transferirla). */
  alsoUsers?: readonly string[];
}
