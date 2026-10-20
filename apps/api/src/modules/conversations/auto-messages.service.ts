import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { channelAccounts, conversations, messages, queues, type TenantTx } from '../../db';
import { businessMsBetween, isOpenAt, SlaService } from '../sla';

export type AutoMessageKind = 'greeting' | 'out_of_hours';

/** Un aviso que llega con más retraso que esto (p. ej. tras una caída del proceso) ya no se saluda: el cliente escribió hace rato y la ventana de 24 h podría estar por cerrarse. */
export const AUTO_MESSAGE_MAX_AGE_MS = 60 * 60_000;

export interface InboundContext {
  conversationId: string;
  channelAccountId: string;
  /** Cola de la conversación (null = sin cola: no hay mensajes que enviar). */
  queueId: string | null;
  /** Este mensaje abrió la conversación. */
  created: boolean;
  /** Cuándo escribió el cliente, sin pasar de ahora (de aquí salen el horario y la antigüedad del aviso). */
  receivedAt: Date;
  /** La hora que trae el mensaje del cliente: el automático va siempre DESPUÉS de él en el hilo, aunque el reloj del proveedor adelante al nuestro. */
  inboundAt: Date;
  now: Date;
  /** Zona horaria de la empresa (identidad: se lee antes de la transacción). */
  timeZone: string;
}

/**
 * Mensajes automáticos de la cola que SALEN al cliente cuando escribe (M5.5c, ADR-07/50; F08). Corre dentro de la transacción de quien registra el mensaje que entra, así
 * que es tan idempotente como él (un aviso repetido no llega aquí). Dos mensajes, ambos texto plano que el administrador escribe en la cola (vacío = no se envía):
 *  - **Saludo**: una sola vez, cuando el mensaje del cliente ABRE una conversación nueva con la cola abierta.
 *  - **Fuera de horario**: cuando el cliente escribe con la cola cerrada (horario propio o de la empresa, y feriados). Reemplaza al saludo (sale un solo mensaje). No se repite
 *    mientras la cola no haya abierto desde el último aviso de esa conversación.
 * El mensaje se guarda `queued` como cualquier saliente (lo envía el mismo despachador, «al menos una vez»), con `sender_type = automation`: NO es una respuesta humana —no
 * detiene el SLA—, no cambia el estado de la conversación ni su última actividad, no la deja «esperando al cliente» y no cuenta para finalizar por inactividad.
 * Nada sale si la cola no tiene el texto, la conversación no tiene cola o la conexión no está activa.
 */
@Injectable()
export class AutoMessagesService {
  constructor(@Inject(SlaService) private readonly sla: SlaService) {}

  async afterInbound(tx: TenantTx, p: InboundContext): Promise<AutoMessageKind | null> {
    if (p.queueId === null) return null;
    if (p.now.getTime() - p.receivedAt.getTime() > AUTO_MESSAGE_MAX_AGE_MS) return null;
    const [q] = await tx.select({ greeting: queues.greetingText, outOfHours: queues.outOfHoursText }).from(queues).where(and(eq(queues.id, p.queueId), isNull(queues.deletedAt))).limit(1);
    if (!q || (q.greeting === null && q.outOfHours === null)) return null;
    const [channel] = await tx.select({ status: channelAccounts.status, deletedAt: channelAccounts.deletedAt }).from(channelAccounts).where(eq(channelAccounts.id, p.channelAccountId)).limit(1);
    if (!channel || channel.deletedAt !== null || channel.status !== 'active') return null;

    const cal = (await this.sla.calendars(tx, p.timeZone)).forQueue(p.queueId);
    let kind: AutoMessageKind;
    let body: string;
    if (!isOpenAt(cal, p.receivedAt) && q.outOfHours !== null) {
      // Con la cola cerrada solo se avisa una vez por periodo cerrado: si desde el último aviso la cola abrió, vuelve a avisarse
      const [c] = await tx.select({ at: conversations.outOfHoursNoticeAt }).from(conversations).where(eq(conversations.id, p.conversationId)).limit(1);
      if (c?.at && businessMsBetween(cal, c.at, p.receivedAt) <= 0) return null;
      kind = 'out_of_hours';
      body = q.outOfHours;
    } else if (p.created && q.greeting !== null) {
      kind = 'greeting';
      body = q.greeting;
    } else {
      return null;
    }

    // Va después del mensaje del cliente en el hilo
    const sentAt = new Date(Math.max(p.now.getTime(), p.inboundAt.getTime() + 1));
    await tx.insert(messages).values({ conversationId: p.conversationId, channelAccountId: p.channelAccountId, direction: 'out', senderType: 'automation', kind: 'text', body, status: 'queued', sentAt, attempts: 0, nextAttemptAt: p.now, meta: { auto: kind } });
    if (kind === 'out_of_hours') await tx.update(conversations).set({ outOfHoursNoticeAt: p.receivedAt }).where(eq(conversations.id, p.conversationId));
    return kind;
  }
}
