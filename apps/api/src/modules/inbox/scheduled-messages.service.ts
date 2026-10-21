import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, or, sql } from 'drizzle-orm';
import { conversations, Database, messages, scheduledMessages, type TenantTx } from '../../db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { OrgDirectoryService, OrgMembersService, type OrgDirectory } from '../organizations';
import { assertCanReply, assertWindowOpen, loadConversation, scopeOf, WINDOW_MS, type InboxAccess, type InboxScope } from './inbox.access';
import type { CreateScheduledDto } from './inbox.dto';
import { OutboundDispatcher } from './outbound-dispatcher.service';
import { OutboundService } from './outbound.service';

/** Lo más pronto que se puede programar (la tarea corre cada pocos segundos) y cuánto antes de cerrarse la ventana de 24 h debe salir. */
export const MIN_LEAD_MS = 60_000;
export const WINDOW_MARGIN_MS = 60_000;
/** Pendientes por conversación y mensajes programados que una pasada envía por empresa. */
export const MAX_PENDING_PER_CONVERSATION = 10;
export const SCHEDULED_BATCH = 50;
/** Cuánto tiempo se siguen mostrando los que no salieron (cancelados o fallidos), para que se sepa por qué. */
const RESOLVED_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** Un error inesperado se reintenta en las pasadas siguientes; pasado este tiempo desde la hora programada, el mensaje se da por fallido. */
const RETRY_GIVE_UP_MS = 10 * 60_000;

type Row = typeof scheduledMessages.$inferSelect;

export interface ScheduledView {
  id: string;
  text: string;
  send_at: string;
  status: 'scheduled' | 'sent' | 'cancelled' | 'failed';
  /** Código del motivo cuando no salió (la interfaz lo redacta). */
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
  author: { id: string; name: string };
  mine: boolean;
  /** ¿Puedo cancelarlo? Quien lo programó, o quien ve todas las conversaciones. */
  can_cancel: boolean;
}

/** Códigos de error de responder → qué le pasó al mensaje programado. */
const OUTCOME: Record<string, { status: 'cancelled' | 'failed'; reason: string }> = {
  CONVERSATION_CLOSED: { status: 'cancelled', reason: 'conversation_closed' },
  CONVERSATION_UNASSIGNED: { status: 'cancelled', reason: 'conversation_changed' },
  CONVERSATION_NOT_ACCEPTED: { status: 'cancelled', reason: 'conversation_changed' },
  NOT_OWNER: { status: 'cancelled', reason: 'conversation_changed' },
  NOT_FOUND: { status: 'cancelled', reason: 'conversation_changed' },
  WINDOW_CLOSED: { status: 'failed', reason: 'window_closed' },
  CHANNEL_DISABLED: { status: 'failed', reason: 'channel_unavailable' },
};

/**
 * Mensajes programados (M5.6c, ADR-50; F09): un texto que sale solo a la hora elegida, dentro de la ventana de 24 h de WhatsApp. Quien puede responder una conversación puede dejarle
 * mensajes programados; cualquiera que la vea los ve (con quién los dejó) y los cancela quien los programó o quien ve todas las conversaciones. Se CANCELAN SOLOS si el cliente
 * responde antes (ya no hacen falta), si la conversación se finaliza o si quien los programó deja de poder responderla; si la ventana se cerró o la conexión dejó de estar activa, quedan
 * como fallidos con el motivo. Al salir se convierten en un mensaje normal, en nombre de quien los programó (cuenta como respuesta humana y detiene el SLA). El texto es dato
 * personal: no va a logs ni a la auditoría.
 */
@Injectable()
export class ScheduledMessagesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OutboundService) private readonly outbound: OutboundService,
    @Inject(OutboundDispatcher) private readonly dispatcher: OutboundDispatcher,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Los pendientes de la conversación y, 24 h, los que no salieron. Los enviados ya son mensajes del hilo. 404 si la persona no puede ver la conversación. */
  async list(access: InboxAccess, conversationId: string): Promise<{ items: ScheduledView[] }> {
    const scope = scopeOf(access);
    const since = new Date(Date.now() - RESOLVED_VISIBLE_MS);
    const rows = await this.db.withTenant(async (tx) => {
      await loadConversation(tx, scope, conversationId);
      return tx
        .select()
        .from(scheduledMessages)
        .where(and(eq(scheduledMessages.conversationId, conversationId), or(eq(scheduledMessages.status, 'scheduled'), and(sql`${scheduledMessages.status} IN ('cancelled', 'failed')`, gt(scheduledMessages.resolvedAt, since)))))
        .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.id));
    });
    return { items: await this.views(rows, scope) };
  }

  async create(access: InboxAccess, conversationId: string, dto: CreateScheduledDto): Promise<ScheduledView> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const now = new Date();
    const sendAt = new Date(dto.send_at);
    if (sendAt.getTime() < now.getTime() + MIN_LEAD_MS) throw new ValidationError([{ path: 'send_at', code: 'too_soon', message: 'Elige una hora al menos un minuto en el futuro' }]);
    const timeZone = (await this.directory.current()).timeZone;
    const row = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, conversationId, true);
      assertCanReply(scope, c, channel.state, collab);
      assertWindowOpen(c.lastInboundAt, now);
      const limit = new Date(c.lastInboundAt!.getTime() + WINDOW_MS - WINDOW_MARGIN_MS);
      if (sendAt.getTime() > limit.getTime()) {
        const shown = new Intl.DateTimeFormat('es', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(limit);
        throw new ConflictError('SCHEDULE_OUTSIDE_WINDOW', `WhatsApp solo permite escribir libremente durante las 24 h siguientes al último mensaje del cliente: programa antes del ${shown}`);
      }
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(scheduledMessages).where(and(eq(scheduledMessages.conversationId, conversationId), eq(scheduledMessages.status, 'scheduled')));
      if (n >= MAX_PENDING_PER_CONVERSATION) throw new ConflictError('SCHEDULE_LIMIT', `Esta conversación ya tiene ${MAX_PENDING_PER_CONVERSATION} mensajes programados: cancela alguno para programar otro`);
      const [created] = await tx.insert(scheduledMessages).values({ conversationId, createdBy: scope.userId, body: dto.text, sendAt }).returning();
      await writeAudit(tx, { entityType: 'scheduled_message', entityId: created!.id, newValue: { conversation_id: conversationId, send_at: sendAt.toISOString() }, source: 'manual' });
      return created!;
    });
    return (await this.views([row], scope))[0]!;
  }

  async cancel(access: InboxAccess, conversationId: string, id: string): Promise<ScheduledView> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const row = await this.db.withTenant(async (tx) => {
      await loadConversation(tx, scope, conversationId);
      const [cur] = await tx.select().from(scheduledMessages).where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.conversationId, conversationId))).limit(1).for('update');
      if (!cur) throw new NotFoundError();
      if (cur.status !== 'scheduled') throw new ConflictError('SCHEDULE_NOT_PENDING', cur.status === 'sent' ? 'Este mensaje ya salió' : 'Este mensaje ya no está programado');
      if (cur.createdBy !== scope.userId && !scope.viewAll) throw new ForbiddenError('SCHEDULE_NOT_YOURS', 'Solo quien lo programó, o quien ve todas las conversaciones, puede cancelarlo');
      const [done] = await tx.update(scheduledMessages).set({ status: 'cancelled', reason: 'cancelled_by_user', resolvedAt: new Date() }).where(eq(scheduledMessages.id, id)).returning();
      await writeAudit(tx, { entityType: 'scheduled_message', entityId: id, field: 'status', oldValue: 'scheduled', newValue: 'cancelled', source: 'manual' });
      return done!;
    });
    return (await this.views([row], scope))[0]!;
  }

  /**
   * Una pasada de la tarea (bajo el TenantContext de la empresa): cancela los que el cliente contestó antes o cuya conversación ya se finalizó y envía los que ya llegaron a su hora.
   * Cada uno va en su `SAVEPOINT`. Los mensajes salen en nombre de quien los programó, con los mismos permisos que al responder: si ya no puede (dejó de ser parte del equipo, le
   * quitaron la conversación…), se cancela con el motivo. Devuelve cuántos resolvió.
   */
  async runDue(now: Date, dir: OrgDirectory, batch = SCHEDULED_BATCH): Promise<number> {
    const at = now.toISOString();
    const sent: string[] = [];
    // Quién sigue en el equipo y con qué rol (identidad: se lee ANTES de la transacción). Un administrador envía como quien ve todas las conversaciones, igual que al programar.
    const roles = new Map((await this.members.assignable()).map((p) => [p.id, p.role]));
    const resolved = await this.db.withTenant(async (tx) => {
      let n = 0;
      // El cliente escribió después de programarlo (por la hora en que LLEGÓ su mensaje, no la que informa WhatsApp, que va en segundos): ya no hace falta y su respuesta merece una persona, no un mensaje viejo
      n += (
        await tx
          .update(scheduledMessages)
          .set({ status: 'cancelled', reason: 'customer_replied', resolvedAt: now })
          .where(and(eq(scheduledMessages.status, 'scheduled'), sql`EXISTS (SELECT 1 FROM ${messages} m WHERE m.organization_id = ${scheduledMessages.organizationId} AND m.conversation_id = ${scheduledMessages.conversationId} AND m.direction = 'in' AND m.created_at > ${scheduledMessages.createdAt})`))
          .returning({ id: scheduledMessages.id })
      ).length;
      n += (
        await tx
          .update(scheduledMessages)
          .set({ status: 'cancelled', reason: 'conversation_closed', resolvedAt: now })
          .where(and(eq(scheduledMessages.status, 'scheduled'), sql`EXISTS (SELECT 1 FROM ${conversations} c WHERE c.organization_id = ${scheduledMessages.organizationId} AND c.id = ${scheduledMessages.conversationId} AND c.status = 'closed')`))
          .returning({ id: scheduledMessages.id })
      ).length;
      const due = await tx
        .select()
        .from(scheduledMessages)
        .where(and(eq(scheduledMessages.status, 'scheduled'), sql`${scheduledMessages.sendAt} <= ${at}::timestamptz`))
        .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.id))
        .limit(batch)
        .for('update', { skipLocked: true });
      for (const s of due) {
        await tx.execute(sql`SAVEPOINT scheduled_one`);
        try {
          const role = roles.get(s.createdBy);
          if (!role) {
            await this.resolve(tx, s.id, 'cancelled', 'not_allowed', now);
          } else {
            const scope: InboxScope = { userId: s.createdBy, canReply: true, viewAll: role === 'client_admin', canTransfer: false, canShare: false };
            const messageId = await this.outbound.enqueueText(tx, scope, s.conversationId, s.body, now, dir.timeZone);
            await tx.update(scheduledMessages).set({ status: 'sent', messageId, resolvedAt: now }).where(eq(scheduledMessages.id, s.id));
            sent.push(messageId);
          }
          await tx.execute(sql`RELEASE SAVEPOINT scheduled_one`);
          n += 1;
        } catch (e) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT scheduled_one`);
          const known = e instanceof AppError ? OUTCOME[e.code] : undefined;
          if (known) {
            await this.resolve(tx, s.id, known.status, known.reason, now);
            n += 1;
          } else if (now.getTime() - s.sendAt.getTime() > RETRY_GIVE_UP_MS) {
            await this.resolve(tx, s.id, 'failed', 'error', now);
            n += 1;
          }
          this.log.warn({ scheduled_id: s.id, code: e instanceof AppError ? e.code : 'inesperado', err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo enviar un mensaje programado');
        }
      }
      return n;
    });
    // El envío al proveedor va fuera de la transacción; si falla, la tarea de envíos lo retoma
    for (const id of sent) {
      try {
        await this.dispatcher.dispatchOne(id);
      } catch (e) {
        this.log.error({ message_id: id, err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo intentar el envío de un mensaje programado; lo retomará la tarea periódica');
      }
    }
    return resolved;
  }

  private async resolve(tx: TenantTx, id: string, status: 'cancelled' | 'failed', reason: string, now: Date): Promise<void> {
    await tx.update(scheduledMessages).set({ status, reason, resolvedAt: now }).where(eq(scheduledMessages.id, id));
  }

  private async views(rows: readonly Row[], scope: InboxScope): Promise<ScheduledView[]> {
    const authors = await this.members.labels(rows.map((r) => r.createdBy));
    return rows.map((r) => ({
      id: r.id,
      text: r.body,
      send_at: r.sendAt.toISOString(),
      status: r.status as ScheduledView['status'],
      reason: r.reason,
      created_at: r.createdAt.toISOString(),
      resolved_at: r.resolvedAt?.toISOString() ?? null,
      author: authors.get(r.createdBy) ?? { id: r.createdBy, name: 'Persona desconocida' },
      mine: r.createdBy === scope.userId,
      can_cancel: r.status === 'scheduled' && scope.canReply && (r.createdBy === scope.userId || scope.viewAll),
    }));
  }
}
