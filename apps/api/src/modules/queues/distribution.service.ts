import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { conversations, queueDistributionState, queueMembers, queues, type TenantTx } from '../../db';
import { parseState, pickNext, type Candidate, type DistMode, type DistRules } from './distribution';
import { startOfLocalDay } from './local-day';
import type { Assignment, AssignmentContext } from './queues.types';

/** Conversaciones que cuentan como «abiertas» de un asesor (las que atiende ahora). */
export const OPEN_STATUSES = ['pending', 'working', 'waiting'] as const;

type QueueRow = typeof queues.$inferSelect;

export interface MemberOverride {
  readonly userId: string;
  readonly weight: number;
}

/**
 * Reparto de una cola contra la base de datos (M5.3, ADR-07). Todo dentro de la transacción y el TenantContext de quien llama. El estado del reparto (a quién le
 * tocó, cuántas seguidas, créditos del ponderado) vive en `queue_distribution_state` y se lee con `FOR UPDATE`: dos repartos de la misma cola se hacen en fila.
 */
@Injectable()
export class DistributionService {
  /** Reglas de reparto de una cola. */
  rulesOf(q: Pick<QueueRow, 'mode' | 'batch' | 'dailyCap'>): DistRules {
    return { mode: q.mode as DistMode, batch: q.batch, dailyCap: q.dailyCap };
  }

  /**
   * A quién se le puede asignar en la cola, EN ORDEN ESTABLE (por alta en la cola y luego por id), con su peso y su carga. Solo cuenta quien está activo en la cola
   * y además puede recibir trabajo en la empresa. `members` sustituye lo guardado (simulación).
   */
  async candidates(tx: TenantTx, queueId: string, ctx: AssignmentContext, rules: DistRules, members?: readonly MemberOverride[]): Promise<Candidate[]> {
    const saved = await tx
      .select({ userId: queueMembers.userId, active: queueMembers.active, weight: queueMembers.weight, createdAt: queueMembers.createdAt })
      .from(queueMembers)
      .where(eq(queueMembers.queueId, queueId))
      .orderBy(asc(queueMembers.createdAt), asc(queueMembers.userId));
    const order = new Map(saved.map((r, i) => [r.userId, i]));
    const base: MemberOverride[] = members ? [...members] : saved.filter((r) => r.active).map((r) => ({ userId: r.userId, weight: r.weight }));
    const people = base
      .filter((m) => ctx.assignable.has(m.userId))
      // Los que ya estaban en la cola conservan su lugar; los nuevos van después, por id
      .sort((a, b) => (order.get(a.userId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.userId) ?? Number.MAX_SAFE_INTEGER) || a.userId.localeCompare(b.userId));
    if (people.length === 0) return [];
    const ids = people.map((p) => p.userId);

    const today = new Map<string, number>();
    if (rules.dailyCap > 0) {
      const since = startOfLocalDay(ctx.now, ctx.timeZone);
      const rows = await tx
        .select({ userId: conversations.ownerId, n: sql<number>`count(*)::int` })
        .from(conversations)
        .where(and(eq(conversations.queueId, queueId), inArray(conversations.ownerId, ids), gte(conversations.assignedAt, since)))
        .groupBy(conversations.ownerId);
      for (const r of rows) if (r.userId) today.set(r.userId, r.n);
    }
    const open = new Map<string, number>();
    if (rules.mode === 'load') {
      const rows = await tx
        .select({ userId: conversations.ownerId, n: sql<number>`count(*)::int` })
        .from(conversations)
        .where(and(inArray(conversations.ownerId, ids), inArray(conversations.status, [...OPEN_STATUSES])))
        .groupBy(conversations.ownerId);
      for (const r of rows) if (r.userId) open.set(r.userId, r.n);
    }
    return people.map((p) => ({ userId: p.userId, weight: p.weight, todayCount: today.get(p.userId) ?? 0, openCount: open.get(p.userId) ?? 0 }));
  }

  /**
   * Elige al asesor de una cola para una conversación nueva y deja guardado el estado del reparto.
   *  - Reparto apagado → nadie (queda «sin asignar»).
   *  - «Solo contactos no asignados» y el contacto ya tiene dueño que puede recibir trabajo → va a él (cartera), sin tocar el reparto.
   *  - Si no, rotación / ponderado / carga entre los asesores activos de la cola, respetando el tope diario.
   */
  async assignFor(tx: TenantTx, queueId: string, ctx: AssignmentContext, opts: { contactOwnerId: string | null }): Promise<Assignment> {
    const [queue] = await tx.select().from(queues).where(and(eq(queues.id, queueId), isNull(queues.deletedAt))).limit(1);
    if (!queue || !queue.distributionOn) return { ownerId: null, reason: 'off' };
    if (queue.onlyUnassigned && opts.contactOwnerId !== null && ctx.assignable.has(opts.contactOwnerId)) return { ownerId: opts.contactOwnerId, reason: 'cartera' };

    // El candado de la fila de estado serializa los repartos de ESTA cola
    await tx.insert(queueDistributionState).values({ queueId }).onConflictDoNothing();
    const [row] = await tx.select().from(queueDistributionState).where(eq(queueDistributionState.queueId, queueId)).for('update').limit(1);
    const rules = this.rulesOf(queue);
    const candidates = await this.candidates(tx, queueId, ctx, rules);
    const pick = pickNext(candidates, rules, parseState(row?.state));
    if (pick.userId === null) return { ownerId: null, reason: 'none_available' };
    await tx.update(queueDistributionState).set({ state: { last: pick.state.last, streak: pick.state.streak, current: pick.state.current }, updatedAt: ctx.now }).where(eq(queueDistributionState.queueId, queueId));
    return { ownerId: pick.userId, reason: 'distributed' };
  }
}
