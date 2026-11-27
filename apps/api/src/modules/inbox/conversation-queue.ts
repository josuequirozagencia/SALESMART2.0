import { and, eq, isNull } from 'drizzle-orm';
import { channelAccounts, conversations, messages, queues, type TenantTx } from '../../db';
import { writeAudit } from '../audit';
import type { ConversationRow } from './inbox.access';

export interface QueueRef {
  id: string;
  name: string;
}

/** El departamento VIGENTE de la conexión de una conversación (null si no tiene o está archivado). */
export async function channelQueueOf(tx: TenantTx, channelAccountId: string): Promise<QueueRef | null> {
  const [row] = await tx
    .select({ id: queues.id, name: queues.name })
    .from(channelAccounts)
    .innerJoin(queues, and(eq(queues.organizationId, channelAccounts.organizationId), eq(queues.id, channelAccounts.queueId)))
    .where(and(eq(channelAccounts.id, channelAccountId), isNull(queues.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Pone el departamento de una conversación YA BLOQUEADA (V24): cambia `queue_id` y nada más de ella —no reparte ni toca dueño, estado, SLA, ventas, oportunidades ni contacto—, deja una nota
 * interna del sistema y la auditoría. La asignación vigente pasa a `manual` para que no consuma el tope diario del departamento que la recibe.
 */
export async function setConversationQueue(
  tx: TenantTx,
  c: Pick<ConversationRow, 'id' | 'channelAccountId' | 'queueId'>,
  queue: QueueRef,
  o: { actorId: string; source: 'manual' | 'automation'; note: string; now: Date },
): Promise<void> {
  await tx.update(conversations).set({ queueId: queue.id, assignmentSource: 'manual', updatedAt: o.now }).where(eq(conversations.id, c.id));
  await tx.insert(messages).values({ conversationId: c.id, channelAccountId: c.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: o.note.slice(0, 2000), status: 'internal', sentAt: o.now, createdBy: o.actorId });
  await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'queue_id', oldValue: c.queueId, newValue: queue.id, source: o.source });
}
