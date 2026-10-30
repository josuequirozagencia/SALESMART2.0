import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { conversationParticipants, conversations, Database, messages, type TenantTx } from '../../db';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { OpportunitiesService } from '../opportunities';
import { OrgDirectoryService } from '../organizations';
import { SlaService } from '../sla';

/** Qué hacer con las conversaciones abiertas de una persona que deja el equipo (ADR-56 B3 #8): pasarlas a otra o dejarlas sin asignación. */
export type ReleasePlan = { action: 'transfer'; to: string; toName: string } | { action: 'unassign' };
export interface ReleaseResult {
  /** Conversaciones abiertas que la persona tenía asignadas y se movieron. */
  moved: number;
  /** Accesos como colaboradora que se quitaron (en cualquier conversación). */
  collaborations: number;
}

const OPEN = ['pending', 'working', 'waiting'] as const;
const BATCH = 100;

/**
 * Libera el trabajo de una persona que se desactiva o se quita del equipo (M10.3, ADR-56 B3 #8). Corre bajo el TenantContext de la empresa (lo pone quien llama), en lotes
 * de una transacción cada uno (una persona con muchas conversaciones no mantiene una transacción enorme) y es IDEMPOTENTE: lo ya movido no vuelve a aparecer en la consulta,
 * así que repetir la operación tras un corte termina el trabajo sin duplicar nada.
 *  - TRANSFERIR: igual que «Transferir» de ADR-50: la conversación queda «pendiente» para la persona destino, su cronómetro de respuesta corre desde ahora y el lead
 *    (el contacto y sus oportunidades abiertas) se va con ella.
 *  - SIN ASIGNACIÓN: la conversación queda «sin asignar» (el reparto del departamento la toma si está encendido) y su cronómetro se detiene; el contacto y las oportunidades
 *    conservan su dueño hasta que alguien los reasigne.
 * Cada conversación deja una nota interna automática y su auditoría (acción de la persona que desactivó). Las finalizadas no se tocan. Quitar a quien era colaborador
 * en cualquier conversación abierta o cerrada se hace siempre (ya no es de la empresa).
 */
@Injectable()
export class OwnerReleaseService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  /** ¿Cuántas conversaciones abiertas tiene asignadas? (para que el diálogo le diga a la persona cuántas son antes de elegir). */
  async openCount(userId: string): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(conversations).where(and(eq(conversations.ownerId, userId), inArray(conversations.status, [...OPEN])));
      return r?.n ?? 0;
    });
  }

  async release(userId: string, plan: ReleasePlan, actor: { id: string; name: string }, leaverName: string): Promise<ReleaseResult> {
    const timeZone = (await this.directory.current({ fresh: true })).timeZone;
    let moved = 0;
    for (;;) {
      const n = await this.db.withTenant((tx) => this.batch(tx, userId, plan, actor, leaverName, timeZone));
      moved += n;
      if (n < BATCH) break;
    }
    const collaborations = await this.db.withTenant(async (tx) => {
      const rows = await tx
        .update(conversationParticipants)
        .set({ revokedAt: new Date(), revokedBy: actor.id })
        .where(and(eq(conversationParticipants.userId, userId), isNull(conversationParticipants.revokedAt)))
        .returning({ conversationId: conversationParticipants.conversationId, permission: conversationParticipants.permission });
      for (const r of rows) await writeAudit(tx, { entityType: 'conversation', entityId: r.conversationId, field: 'participant', oldValue: { user_id: userId, permission: r.permission }, newValue: null });
      return rows.length;
    });
    return { moved, collaborations };
  }

  private async batch(tx: TenantTx, userId: string, plan: ReleasePlan, actor: { id: string; name: string }, leaverName: string, timeZone: string): Promise<number> {
    const rows = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.ownerId, userId), inArray(conversations.status, [...OPEN])))
      .orderBy(asc(conversations.id))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    const now = new Date();
    for (const c of rows) {
      if (plan.action === 'transfer') {
        // Quien recibe la conversación deja de ser colaborador: ahora es el dueño
        const gone = await tx.update(conversationParticipants).set({ revokedAt: now, revokedBy: actor.id }).where(and(eq(conversationParticipants.conversationId, c.id), eq(conversationParticipants.userId, plan.to), isNull(conversationParticipants.revokedAt))).returning({ permission: conversationParticipants.permission });
        if (gone[0]) await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'participant', oldValue: { user_id: plan.to, permission: gone[0].permission }, newValue: null });
        await tx.update(conversations).set({ ownerId: plan.to, assignedAt: now, assignmentSource: 'manual', status: 'pending', rotations: 0, triedOwners: [], updatedAt: now }).where(eq(conversations.id, c.id));
        await this.sla.startFirst(tx, { id: c.id, ownerId: plan.to, queueId: c.queueId }, { now, timeZone }, 'transferred');
        await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'owner_id', oldValue: userId, newValue: plan.to });
        if (c.status !== 'pending') await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'status', oldValue: c.status, newValue: 'pending' });
        await this.contacts.reassignOwner(tx, c.contactId, plan.to);
        await this.opportunities.reassignOpenOwner(tx, c.contactId, userId, plan.to);
        await this.note(tx, c, actor.id, `${leaverName} dejó el equipo: ${actor.name} pasó la conversación a ${plan.toName}.`, now);
      } else {
        await tx.update(conversations).set({ ownerId: null, assignedAt: null, status: 'unassigned', rotations: 0, triedOwners: [], updatedAt: now }).where(eq(conversations.id, c.id));
        await this.sla.stopOpen(tx, c.id, 'reassigned', now);
        await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'owner_id', oldValue: userId, newValue: null });
        await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'status', oldValue: c.status, newValue: 'unassigned' });
        await this.note(tx, c, actor.id, `${leaverName} dejó el equipo: ${actor.name} dejó la conversación sin asignar.`, now);
      }
    }
    return rows.length;
  }

  /** Aviso automático en el historial: nota INTERNA del sistema (nunca sale al cliente). */
  private async note(tx: TenantTx, c: { id: string; channelAccountId: string }, actorId: string, text: string, now: Date): Promise<void> {
    await tx.insert(messages).values({ conversationId: c.id, channelAccountId: c.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: text.slice(0, 2000), status: 'internal', sentAt: now, createdBy: actorId });
  }
}
