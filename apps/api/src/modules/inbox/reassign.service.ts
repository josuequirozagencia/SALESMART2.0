import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { conversations, Database, queues, responseTimers, type TenantTx } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { OpportunitiesService } from '../opportunities';
import { OrgMembersService, type OrgDirectory } from '../organizations';
import { DistributionService, QueuesService, type AssignmentContext } from '../queues';
import { SlaService } from '../sla';
import { addSystemNote } from './system-note';

export const REASSIGN_BATCH = 20;
/** Si una pasada falla con una conversación, se vuelve a intentar con ella en este tiempo (no en un bucle). */
const RETRY_MS = 60_000;
/** Conversaciones sin asignar que una pasada reparte por cola cuando esta abre. */
const PICKUP_BATCH = 50;
const OPEN = new Set(['pending', 'working', 'waiting']);

export type ReassignResult = 'reassigned' | 'exhausted' | 'deferred' | 'stale';

/**
 * Lo que la empresa hace sola con el tiempo (M5.5b, ADR-07/50; F08): REASIGNA una conversación a otra persona de su cola si nadie respondió (mensaje humano) en los minutos
 * de TIEMPO ABIERTO que la cola indica, con un máximo de rotaciones, y REPARTE al abrir lo que esperó con una cola que «respeta el horario». Corre dentro del TenantContext de la
 * empresa (lo pone la tarea). Cada reasignación es una sola transacción con su SAVEPOINT:
 *  - nunca vuelve a darle la conversación a quien ya la tuvo en ese ciclo (`tried_owners`), ni a quien no pueda recibir trabajo;
 *  - la conversación queda «pendiente» para quien la recibe, con su propio cronómetro; el lead (contacto y oportunidades abiertas del anterior) pasa con ella;
 *  - queda un aviso automático en el historial y la auditoría (acción automática); no consume el rótulo «manual» ni el tope diario del que la perdió;
 *  - al llegar al máximo (o si no hay a quién) deja de reasignar y la conversación sigue vencida a la vista, con un aviso.
 */
@Injectable()
export class ReassignService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(DistributionService) private readonly distribution: DistributionService,
    @Inject(QueuesService) private readonly queuesSvc: QueuesService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Reasigna las conversaciones cuya hora ya llegó. Devuelve cuántas tocó. `dir` (zona horaria y quién recibe trabajo) lo lee quien llama ANTES de la transacción. */
  async runDue(now: Date, dir: OrgDirectory, batch = REASSIGN_BATCH): Promise<number> {
    const any = await this.db.withTenant((tx) => tx.select({ id: responseTimers.id }).from(responseTimers).where(this.dueWhere(now)).limit(1));
    if (any.length === 0) return 0;
    // Los nombres (identidad) para los avisos del historial, antes de abrir la transacción
    const names = new Map((await this.members.assignable()).map((p) => [p.id, p.name]));
    const ctx: AssignmentContext = { now, timeZone: dir.timeZone, assignable: dir.assignable };
    return this.db.withTenant(async (tx) => {
      const due = await tx
        .select({ t: responseTimers })
        .from(responseTimers)
        .where(this.dueWhere(now))
        .orderBy(asc(responseTimers.reassignAt), asc(responseTimers.id))
        .limit(batch)
        .for('update', { skipLocked: true, of: responseTimers });
      for (const { t } of due) {
        await tx.execute(sql`SAVEPOINT reassign_one`);
        try {
          await this.processOne(tx, t, ctx, names);
          await tx.execute(sql`RELEASE SAVEPOINT reassign_one`);
        } catch (e) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT reassign_one`);
          this.log.warn({ timer_id: t.id, err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo reasignar una conversación; se reintenta');
          await tx.update(responseTimers).set({ reassignAt: new Date(now.getTime() + RETRY_MS) }).where(eq(responseTimers.id, t.id));
        }
      }
      return due.length;
    });
  }

  /** Reparte lo que esperó a que abriera: las colas con reparto y «respetar el horario», ya abiertas, reparten sus conversaciones sin asignar. Devuelve cuántas asignó. */
  async runPickup(now: Date, dir: OrgDirectory): Promise<number> {
    const ctx: AssignmentContext = { now, timeZone: dir.timeZone, assignable: dir.assignable };
    return this.db.withTenant(async (tx) => {
      const waiting = await tx.select({ id: queues.id }).from(queues).where(and(isNull(queues.deletedAt), eq(queues.distributionOn, true), eq(queues.respectHours, true)));
      let assigned = 0;
      for (const q of waiting) {
        if (!(await this.sla.isOpen(tx, q.id, ctx))) continue;
        assigned += await this.queuesSvc.distributeWithin(tx, q.id, ctx, PICKUP_BATCH);
      }
      return assigned;
    });
  }

  private dueWhere(now: Date) {
    return and(isNull(responseTimers.stoppedAt), eq(responseTimers.kind, 'first'), lte(responseTimers.reassignAt, now));
  }

  private async processOne(tx: TenantTx, timer: typeof responseTimers.$inferSelect, ctx: AssignmentContext, names: ReadonlyMap<string, string>): Promise<ReassignResult> {
    const { now } = ctx;
    const stopWatching = () => tx.update(responseTimers).set({ reassignAt: null }).where(eq(responseTimers.id, timer.id));
    const [c] = await tx.select().from(conversations).where(eq(conversations.id, timer.conversationId)).for('update').limit(1);
    // Cambió de manos o se cerró mientras tanto: ya no hay nada que reasignar por este cronómetro
    if (!c || c.ownerId !== timer.ownerId || !OPEN.has(c.status)) {
      await stopWatching();
      return 'stale';
    }
    const [q] = c.queueId ? await tx.select().from(queues).where(and(eq(queues.id, c.queueId), isNull(queues.deletedAt))).limit(1) : [];
    if (!q || q.reassignMinutes === 0 || !q.distributionOn) {
      await stopWatching();
      return 'stale';
    }
    const who = (id: string | null): string => (id ? (names.get(id) ?? 'otra persona') : 'nadie');
    if (c.rotations >= q.maxRotations) {
      await stopWatching();
      await this.note(tx, c, `Nadie respondió en ${q.reassignMinutes} min de horario laboral y ya se reasignó ${c.rotations} ${c.rotations === 1 ? 'vez' : 'veces'}, el máximo de la cola. Ya no se reasigna: ${who(c.ownerId)} sigue con la conversación.`, now);
      return 'exhausted';
    }
    const exclude = new Set<string>([...c.triedOwners, c.ownerId]);
    const pick = await this.distribution.assignFor(tx, q.id, ctx, { contactOwnerId: null, exclude });
    if (pick.reason === 'closed') {
      // La cola respeta el horario y ahora está cerrada: se vuelve a mirar en un rato
      await tx.update(responseTimers).set({ reassignAt: new Date(now.getTime() + RETRY_MS) }).where(eq(responseTimers.id, timer.id));
      return 'deferred';
    }
    if (pick.ownerId === null) {
      await stopWatching();
      await this.note(tx, c, `Nadie respondió en ${q.reassignMinutes} min de horario laboral y no hay a quién reasignarla en la cola (todas las personas disponibles ya la tuvieron o no pueden recibir más). ${who(c.ownerId)} sigue con la conversación.`, now);
      return 'exhausted';
    }
    const prev = c.ownerId;
    await tx
      .update(conversations)
      .set({ ownerId: pick.ownerId, assignedAt: now, assignmentSource: 'distribution', status: 'pending', rotations: sql`${conversations.rotations} + 1`, triedOwners: sql`array_append(${conversations.triedOwners}, ${prev}::uuid)`, updatedAt: now })
      .where(eq(conversations.id, c.id));
    await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'owner_id', oldValue: prev, newValue: pick.ownerId, source: 'automation' });
    if (c.status !== 'pending') await writeAudit(tx, { entityType: 'conversation', entityId: c.id, field: 'status', oldValue: c.status, newValue: 'pending', source: 'automation' });
    // El cronómetro anterior queda en el historial como «reasignado» y la nueva persona empieza el suyo
    await this.sla.startFirst(tx, { id: c.id, ownerId: pick.ownerId, queueId: q.id }, ctx, 'reassigned');
    // El lead se mueve con la conversación (igual que al transferir): si no, la nueva persona no vería el contacto
    await this.contacts.reassignOwner(tx, c.contactId, pick.ownerId, 'automation');
    await this.opportunities.reassignOpenOwner(tx, c.contactId, prev, pick.ownerId, 'automation');
    await this.note(tx, c, `La conversación pasó de ${who(prev)} a ${who(pick.ownerId)}: no hubo respuesta en ${q.reassignMinutes} min de horario laboral.`, now);
    return 'reassigned';
  }

  /** Aviso automático en el historial: nota interna del sistema, sin autor (la hizo la propia empresa). */
  private note(tx: TenantTx, c: Pick<typeof conversations.$inferSelect, 'id' | 'channelAccountId'>, text: string, now: Date): Promise<void> {
    return addSystemNote(tx, c, text, now);
  }
}
