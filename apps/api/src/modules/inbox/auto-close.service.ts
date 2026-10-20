import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { conversations, Database, queues } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { SlaService } from '../sla';
import { addSystemNote } from './system-note';

/** Conversaciones que una pasada finaliza por empresa. */
export const CLOSE_BATCH = 50;

/**
 * Finalizar por inactividad (M5.5c, ADR-07/50; F08): una conversación «esperando al cliente» —alguien ya le respondió y él no contesta— se finaliza sola cuando pasan las
 * horas que indica su cola (`auto_close_hours`; 0 = nunca) desde el último mensaje, contadas en reloj corrido. Nunca toca las que el CLIENTE espera que la empresa conteste
 * (pendientes, trabajando) ni las sin asignar: eso lo vigila el SLA. Los mensajes automáticos y las notas no mueven la última actividad, así que no la posponen. Corre dentro del
 * TenantContext de la empresa (lo pone la tarea). Cada conversación va en su `SAVEPOINT`. Al finalizar: queda una nota interna del sistema, la auditoría marca acción
 * automática y no sale ningún mensaje al cliente (la despedida llega con los ajustes de la conexión); si el cliente vuelve a escribir se abre otra conversación.
 */
@Injectable()
export class AutoCloseService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Finaliza las conversaciones vencidas. Devuelve cuántas finalizó. */
  async runDue(now: Date, batch = CLOSE_BATCH): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const at = now.toISOString();
      const due = await tx
        .select({ id: conversations.id, channelAccountId: conversations.channelAccountId, hours: queues.autoCloseHours })
        .from(conversations)
        .innerJoin(queues, and(eq(queues.organizationId, conversations.organizationId), eq(queues.id, conversations.queueId)))
        .where(and(eq(conversations.status, 'waiting'), isNull(queues.deletedAt), gt(queues.autoCloseHours, 0), sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}) <= ${at}::timestamptz - make_interval(hours => ${queues.autoCloseHours})`))
        .orderBy(asc(conversations.lastMessageAt), asc(conversations.id))
        .limit(batch)
        .for('update', { skipLocked: true, of: conversations });
      let closed = 0;
      for (const c of due) {
        await tx.execute(sql`SAVEPOINT auto_close_one`);
        try {
          await tx.update(conversations).set({ status: 'closed', closedAt: now, unreadCount: 0, updatedAt: now }).where(eq(conversations.id, c.id));
          await this.sla.stopOpen(tx, c.id, 'closed', now);
          await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'status', oldValue: 'waiting', newValue: 'closed', source: 'automation' });
          await addSystemNote(tx, c, `Finalizada automáticamente: pasaron ${c.hours} h sin mensajes del cliente después de la última respuesta.`, now);
          await tx.execute(sql`RELEASE SAVEPOINT auto_close_one`);
          closed += 1;
        } catch (e) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT auto_close_one`);
          this.log.warn({ conversation_id: c.id, err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo finalizar una conversación por inactividad; se reintenta');
        }
      }
      return closed;
    });
  }
}
