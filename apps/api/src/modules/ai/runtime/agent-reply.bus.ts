import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../../db';
import type { AppLogger } from '../../../logger';
import { APP_LOGGER } from '../../../tokens';

/** El agente de IA acaba de enviar una respuesta al cliente y SIGUE atendiendo la conversación (v11 S5, ADR-68). */
export interface AgentReplyEvent {
  readonly conversationId: string;
  readonly agentId: string;
  readonly channelAccountId: string;
  readonly contactId: string;
  /** La hora del último mensaje que envió. */
  readonly sentAt: Date;
}

export type AgentReplyListener = (tx: TenantTx, event: AgentReplyEvent) => Promise<void>;

/**
 * Aviso interno de que el agente respondió (patrón de `TagChangeBus`): el agente en vivo lo emite DENTRO de su transacción y quien necesite reaccionar —los seguimientos automáticos, que viven en otro
 * módulo porque dependen de las automatizaciones— se registra una vez al arrancar. Cada oyente corre en su `SAVEPOINT`: un fallo del oyente se registra y NUNCA impide que el agente conteste.
 */
@Injectable()
export class AgentReplyBus {
  private readonly listeners: AgentReplyListener[] = [];

  constructor(@Inject(APP_LOGGER) private readonly log: AppLogger) {}

  subscribe(listener: AgentReplyListener): () => void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async publish(tx: TenantTx, event: AgentReplyEvent): Promise<void> {
    for (const l of this.listeners) {
      await tx.execute(sql`SAVEPOINT agent_reply_listener`);
      try {
        await l(tx, event);
        await tx.execute(sql`RELEASE SAVEPOINT agent_reply_listener`);
      } catch (e) {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT agent_reply_listener`);
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido', conversation_id: event.conversationId }, 'un oyente de la respuesta del agente falló (el agente contestó igual)');
      }
    }
  }
}
