import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { channelAccounts, conversations, type TenantTx } from '../../db';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { SlaService } from '../sla';
import { DistributionService } from './distribution.service';
import type { AssignmentContext } from './queues.types';

export interface AssignResult {
  assigned: boolean;
  ownerId: string | null;
  queueId: string | null;
}

/**
 * Asigna una conversación «sin asignar» a un asesor según la cola de su conexión (M5.3, ADR-07/ADR-50). Lo usan la llegada de un mensaje y el «repartir ahora» de
 * una cola. Todo dentro de la transacción de quien llama. Reglas: la cola sale de la conversación o, si aún no la tiene, de su conexión (y se anota); sin cola o con
 * el reparto apagado queda «sin asignar»; con asesor queda `pending` (asignada, sin aceptar). Si el contacto no tenía dueño, el primer reparto se lo da al asesor
 * (así se forma su cartera). Nunca toca una conversación que ya tiene dueño o está cerrada.
 */
@Injectable()
export class AssignmentService {
  constructor(
    @Inject(DistributionService) private readonly distribution: DistributionService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(SlaService) private readonly sla: SlaService,
  ) {}

  async assignConversation(tx: TenantTx, conversationId: string, ctx: AssignmentContext): Promise<AssignResult> {
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update').limit(1);
    if (!conv) return { assigned: false, ownerId: null, queueId: null };
    if (conv.status !== 'unassigned') return { assigned: false, ownerId: conv.ownerId, queueId: conv.queueId };

    let queueId = conv.queueId;
    if (queueId === null) {
      const [ch] = await tx.select({ queueId: channelAccounts.queueId }).from(channelAccounts).where(and(eq(channelAccounts.id, conv.channelAccountId), isNull(channelAccounts.deletedAt))).limit(1);
      queueId = ch?.queueId ?? null;
      if (queueId !== null) await tx.update(conversations).set({ queueId, updatedAt: ctx.now }).where(eq(conversations.id, conv.id));
    }
    if (queueId === null) return { assigned: false, ownerId: null, queueId: null };

    const contactOwner = await this.contacts.ownerOf(tx, conv.contactId);
    const a = await this.distribution.assignFor(tx, queueId, ctx, { contactOwnerId: contactOwner });
    if (a.ownerId === null) return { assigned: false, ownerId: null, queueId };

    await tx.update(conversations).set({ ownerId: a.ownerId, assignedAt: ctx.now, assignmentSource: 'distribution', status: 'pending', rotations: 0, triedOwners: [], updatedAt: ctx.now }).where(eq(conversations.id, conv.id));
    await writeAudit(tx, { entityType: 'conversation', entityId: conv.id, field: 'owner_id', oldValue: null, newValue: a.ownerId, source: 'automation' });
    if (a.reason === 'distributed') await this.contacts.assignOwnerIfNone(tx, conv.contactId, a.ownerId);
    // El cronómetro de primera respuesta corre desde que se asigna (F08)
    await this.sla.startFirst(tx, { id: conv.id, ownerId: a.ownerId, queueId }, ctx);
    return { assigned: true, ownerId: a.ownerId, queueId };
  }
}
