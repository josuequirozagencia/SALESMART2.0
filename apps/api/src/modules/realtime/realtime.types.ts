/** Sala de una persona dentro de UNA empresa: una sesión que cambia de empresa (agencia, soporte) se reconecta y entra en otra sala, nunca en la anterior. */
export const personRoom = (organizationId: string, userId: string): string => `org:${organizationId}:user:${userId}`;

export type RealtimeEvent = 'conversation.created' | 'conversation.updated' | 'message.created' | 'message.updated' | 'scheduled.updated';

/**
 * Sobre de todo evento. `data` lleva SOLO identificadores: el cliente vuelve a pedir lo que cambió por la API normal, que aplica la visibilidad y el
 * aislamiento de siempre. Así un evento mal dirigido no puede filtrar contenido.
 */
export interface RealtimeEnvelope {
  organization_id: string;
  request_id: string;
  at: string;
  data: { conversation_id: string; message_id?: string };
}

export interface TouchOptions {
  /** La conversación acaba de crearse. */
  created?: boolean;
  /** Mensajes de la conversación que se crearon o cambiaron (id y qué pasó). */
  message?: { id: string; kind: 'created' | 'updated' };
  /** Cambiaron los mensajes programados de la conversación. */
  scheduled?: boolean;
  /** Personas que deben enterarse aunque ya no vean la conversación (p. ej. quien la tenía antes de transferirla). */
  alsoUsers?: readonly string[];
}
