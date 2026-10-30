import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { businessHours, conversations, holidays, queues, responseTimers, slaPolicies, userHours, type TenantTx } from '../../db';
import { addBusinessMinutes, businessSecondsBetween, isOpenAt, OPEN_ALWAYS, weekFromJson, weekHasOpenTime, type Calendar } from './calendar';

/** Valores por omisión de la política de respuesta (F01: SLA de 15 minutos). */
export const DEFAULT_TARGET_MINUTES = 15;
export const DEFAULT_RISK_MINUTES = 3;

export interface SlaPolicy {
  readonly targetMinutes: number;
  readonly riskMinutes: number;
}

/** Los calendarios de la empresa: el suyo y, si la cola tiene horario propio, el de la cola. */
export interface Calendars {
  /** Horario de la empresa (`null` o una cola sin horario propio). */
  forQueue(queueId: string | null): Calendar;
  /** La cola tiene un horario propio. */
  hasOwn(queueId: string): boolean;
}

/** Lo que el cronómetro necesita saber de la conversación y del «ahora» (la zona horaria sale de la identidad: se lee ANTES de abrir la transacción). */
export interface TimerContext {
  readonly now: Date;
  readonly timeZone: string;
}
export interface TimerConversation {
  readonly id: string;
  readonly ownerId: string;
  readonly queueId: string | null;
}

export type SlaState = 'ok' | 'risk' | 'late' | 'paused' | 'done';

/** El SLA de una conversación como lo ve la interfaz. */
export interface SlaView {
  kind: 'first' | 'followup';
  state: SlaState;
  started_at: string;
  /** Fecha límite en tiempo ABIERTO; null cuando ya se respondió. */
  due_at: string | null;
  /** Tiempo de respuesta en tiempo abierto, si ya se respondió. */
  response_seconds: number | null;
}

type StopReason = 'human_reply' | 'closed' | 'transferred' | 'reassigned' | 'sale';

/**
 * Cronómetros de respuesta y calendario laboral (M5.5b, ADR-07/50; F08, F09). Todo va DENTRO de la transacción y el TenantContext de quien llama; la zona horaria viene de
 * fuera (identidad). Las reglas:
 *  - **Primera respuesta**: corre desde que la conversación se asigna (reparto, tomar, transferir o reasignar). **Respuestas posteriores**: desde el mensaje del cliente.
 *  - Solo cuenta el tiempo ABIERTO: horario de la empresa (o el propio de la cola), feriados y zona horaria. Sin horario configurado, abierto siempre.
 *  - Se detiene con el primer mensaje HUMANO (no automático, no una nota) de quien sea —dueño o colaborador—, al finalizar, al transferir y al reasignar; el tiempo de respuesta
 *    (en tiempo abierto) queda guardado y cada medición conserva su historial.
 *  - A lo sumo UN cronómetro abierto por conversación: lo garantiza un índice único parcial.
 */
@Injectable()
export class SlaService {
  /** La política de la empresa, o los valores por omisión si aún no la guardó. */
  async policy(tx: TenantTx): Promise<SlaPolicy> {
    const [p] = await tx.select({ target: slaPolicies.targetMinutes, risk: slaPolicies.riskMinutes }).from(slaPolicies).limit(1);
    return p ? { targetMinutes: p.target, riskMinutes: p.risk } : { targetMinutes: DEFAULT_TARGET_MINUTES, riskMinutes: DEFAULT_RISK_MINUTES };
  }

  /** Los calendarios de la empresa y de sus colas con horario propio (3 consultas pequeñas). */
  async calendars(tx: TenantTx, timeZone: string): Promise<Calendars> {
    const rows = await tx.select({ scope: businessHours.scope, queueId: businessHours.queueId, days: businessHours.days }).from(businessHours);
    const days = await tx.select({ day: holidays.day, yearly: holidays.yearly }).from(holidays).where(isNull(holidays.deletedAt));
    const org = rows.find((r) => r.scope === 'org');
    const orgWeek = org && weekHasOpenTime(weekFromJson(org.days)) ? weekFromJson(org.days) : OPEN_ALWAYS;
    const exact = new Set(days.filter((d) => !d.yearly).map((d) => d.day));
    const yearly = new Set(days.filter((d) => d.yearly).map((d) => d.day.slice(5)));
    const own = new Map<string, ReturnType<typeof weekFromJson>>();
    for (const r of rows) if (r.scope === 'queue' && r.queueId && weekHasOpenTime(weekFromJson(r.days))) own.set(r.queueId, weekFromJson(r.days));
    return {
      forQueue: (queueId) => ({ timeZone, week: (queueId ? own.get(queueId) : undefined) ?? orgWeek, holidays: exact, yearly }),
      hasOwn: (queueId) => own.has(queueId),
    };
  }

  /**
   * De estas personas, las que tienen un horario propio ACTIVO y ahora están fuera de él (o en un feriado de la empresa): el reparto automático no les asigna (M10.4). Sin horario
   * propio, la persona está disponible siempre (el horario de la empresa o de la cola lo decide aparte la cola con «respetar el horario»).
   */
  async closedUsers(tx: TenantTx, userIds: readonly string[], ctx: TimerContext): Promise<Set<string>> {
    const closed = new Set<string>();
    if (userIds.length === 0) return closed;
    const rows = await tx.select({ userId: userHours.userId, days: userHours.days }).from(userHours).where(and(inArray(userHours.userId, [...userIds]), eq(userHours.active, true)));
    if (rows.length === 0) return closed;
    const base = (await this.calendars(tx, ctx.timeZone)).forQueue(null);
    for (const r of rows) {
      const week = weekFromJson(r.days);
      if (weekHasOpenTime(week) && !isOpenAt({ ...base, week }, ctx.now)) closed.add(r.userId);
    }
    return closed;
  }

  /** ¿La cola está abierta ahora (con su horario propio o el de la empresa)? */
  async isOpen(tx: TenantTx, queueId: string | null, ctx: TimerContext): Promise<boolean> {
    return isOpenAt((await this.calendars(tx, ctx.timeZone)).forQueue(queueId), ctx.now);
  }

  /**
   * Empieza el cronómetro de PRIMERA respuesta de quien recibe la conversación. Si había uno abierto (de la persona anterior) se detiene con el motivo indicado: la
   * medición anterior queda en el historial y el SLA «pasa al nuevo». Calcula la fecha límite y, si la cola reasigna por falta de respuesta, cuándo toca.
   */
  async startFirst(tx: TenantTx, conv: TimerConversation, ctx: TimerContext, replaced: 'transferred' | 'reassigned' = 'transferred'): Promise<void> {
    await this.stopOpen(tx, conv.id, replaced, ctx.now);
    const [policy, cals] = await Promise.all([this.policy(tx), this.calendars(tx, ctx.timeZone)]);
    const cal = cals.forQueue(conv.queueId);
    let reassignAt: Date | null = null;
    if (conv.queueId) {
      const [q] = await tx.select({ minutes: queues.reassignMinutes }).from(queues).where(and(eq(queues.id, conv.queueId), isNull(queues.deletedAt))).limit(1);
      if (q && q.minutes > 0) reassignAt = addBusinessMinutes(cal, ctx.now, q.minutes);
    }
    await tx.insert(responseTimers).values({ conversationId: conv.id, kind: 'first', ownerId: conv.ownerId, startedAt: ctx.now, dueAt: addBusinessMinutes(cal, ctx.now, policy.targetMinutes), reassignAt });
  }

  /** Empieza el cronómetro de una respuesta POSTERIOR (el cliente volvió a escribir), salvo que ya haya uno abierto (la primera respuesta aún pendiente, o una posterior sin contestar). */
  async startFollowup(tx: TenantTx, conv: TimerConversation, ctx: TimerContext): Promise<void> {
    const [open] = await tx.select({ id: responseTimers.id }).from(responseTimers).where(and(eq(responseTimers.conversationId, conv.id), isNull(responseTimers.stoppedAt))).limit(1);
    if (open) return;
    const [policy, cals] = await Promise.all([this.policy(tx), this.calendars(tx, ctx.timeZone)]);
    await tx
      .insert(responseTimers)
      .values({ conversationId: conv.id, kind: 'followup', ownerId: conv.ownerId, startedAt: ctx.now, dueAt: addBusinessMinutes(cals.forQueue(conv.queueId), ctx.now, policy.targetMinutes) })
      // Dos mensajes simultáneos: gana uno (el predicado del índice parcial va SIN nombre de tabla)
      .onConflictDoNothing({ target: [responseTimers.organizationId, responseTimers.conversationId], where: sql`stopped_at IS NULL` });
  }

  /** Un mensaje HUMANO al cliente detiene el cronómetro abierto y guarda cuánto tardó (en tiempo abierto). Sin cronómetro abierto no hace nada. */
  async stopOnReply(tx: TenantTx, conversationId: string, messageId: string, ctx: TimerContext): Promise<void> {
    const [t] = await tx.select({ id: responseTimers.id, startedAt: responseTimers.startedAt }).from(responseTimers).where(and(eq(responseTimers.conversationId, conversationId), isNull(responseTimers.stoppedAt))).for('update').limit(1);
    if (!t) return;
    const [c] = await tx.select({ queueId: conversations.queueId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    const cal = (await this.calendars(tx, ctx.timeZone)).forQueue(c?.queueId ?? null);
    await tx.update(responseTimers).set({ stoppedAt: ctx.now, stopReason: 'human_reply', responseSeconds: businessSecondsBetween(cal, t.startedAt, ctx.now), repliedMessageId: messageId }).where(eq(responseTimers.id, t.id));
  }

  /** Detiene el cronómetro abierto sin respuesta (finalizar, transferir, reasignar). */
  async stopOpen(tx: TenantTx, conversationId: string, reason: Exclude<StopReason, 'human_reply'>, now: Date): Promise<void> {
    await tx.update(responseTimers).set({ stoppedAt: now, stopReason: reason }).where(and(eq(responseTimers.conversationId, conversationId), isNull(responseTimers.stoppedAt)));
  }

  /**
   * El SLA de cada conversación: el cronómetro abierto (en regla, en riesgo, vencido o en pausa por estar cerrado) o, si no hay, cuánto tardó la última primera respuesta.
   * Quien llama pasa la cola de cada conversación (su horario decide la «pausa»).
   */
  async views(tx: TenantTx, convs: ReadonlyArray<{ id: string; queueId: string | null }>, ctx: TimerContext): Promise<Map<string, SlaView>> {
    const out = new Map<string, SlaView>();
    if (convs.length === 0) return out;
    const rows = await tx
      .select({ conversationId: responseTimers.conversationId, kind: responseTimers.kind, startedAt: responseTimers.startedAt, dueAt: responseTimers.dueAt, stoppedAt: responseTimers.stoppedAt, responseSeconds: responseTimers.responseSeconds })
      .from(responseTimers)
      .where(and(inArray(responseTimers.conversationId, convs.map((c) => c.id)), or(isNull(responseTimers.stoppedAt), and(eq(responseTimers.kind, 'first'), eq(responseTimers.stopReason, 'human_reply')))))
      .orderBy(desc(responseTimers.startedAt), desc(responseTimers.id));
    if (rows.length === 0) return out;
    const [policy, cals] = await Promise.all([this.policy(tx), this.calendars(tx, ctx.timeZone)]);
    const queueOf = new Map(convs.map((c) => [c.id, c.queueId]));
    const byConv = new Map<string, typeof rows>();
    for (const r of rows) byConv.set(r.conversationId, [...(byConv.get(r.conversationId) ?? []), r]);
    const now = ctx.now.getTime();
    for (const [id, list] of byConv) {
      // Las filas vienen de la más reciente a la más antigua: si hay un cronómetro abierto, manda sobre cualquier medición ya cerrada
      const open = list.find((r) => r.stoppedAt === null);
      if (open) {
        const due = open.dueAt.getTime();
        const state: SlaState = now > due ? 'late' : !isOpenAt(cals.forQueue(queueOf.get(id) ?? null), ctx.now) ? 'paused' : due - now <= policy.riskMinutes * 60_000 ? 'risk' : 'ok';
        out.set(id, { kind: open.kind === 'first' ? 'first' : 'followup', state, started_at: open.startedAt.toISOString(), due_at: open.dueAt.toISOString(), response_seconds: null });
      } else {
        const done = list[0]!;
        out.set(id, { kind: 'first', state: 'done', started_at: done.startedAt.toISOString(), due_at: null, response_seconds: done.responseSeconds });
      }
    }
    return out;
  }
}
