import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, exists, gt, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { contacts, conversations, Database, messageMentions, messages, notifications, sales, tasks, type TenantTx } from '../../db';
import { NotFoundError } from '../../errors';
import { decodeTimeCursor, encodeTimeCursor } from '../../http';
import { TenantContext } from '../../tenant';
import { conversationVisibleTo } from '../conversations';
import { OrgMembersService } from '../organizations';
import type { ListNotificationsQuery } from './notifications.dto';

/** Cuánto atrás muestra la lista (los avisos se conservan; la limpieza física queda para cuando haya volumen, ADR-57 #10). */
export const VISIBLE_DAYS = 90;
const EXCERPT_CHARS = 140;

/** Quién consulta: la persona sale de TenantContext; `viewAll` (`inbox.view_all`) decide qué conversaciones puede abrir. */
export interface NotificationsAccess {
  readonly viewAll: boolean;
}

export type NotificationType = 'mention' | 'task_assigned' | 'task_due' | 'calendar_reconnect' | 'sale_created';

export interface NotificationView {
  id: string;
  type: NotificationType;
  created_at: string;
  read_at: string | null;
  /** Quien lo provocó (null en un aviso de vencimiento o de una tarea que creó el sistema). */
  actor: { id: string; name: string } | null;
  /** Solo en las menciones. */
  conversation: { id: string; contact: { id: string; name: string } } | null;
  message_id: string | null;
  /** Primeras palabras de la nota (se lee del mensaje al pedir la lista: el aviso no guarda el texto). */
  excerpt: string | null;
  /** Solo en los avisos de tareas (F2, ADR-58): el título y el vencimiento se leen de la tarea al pedir la lista. */
  task: { id: string; title: string; due_at: string | null; status: 'open' | 'done'; contact_id: string | null } | null;
  /** Solo en los avisos de una venta nueva (v13 S4.2): se lee de la venta al pedir la lista. */
  sale: { id: string; product: string; amount: string; currency: string; seller: { id: string; name: string } | null; contact: { id: string; name: string } } | null;
}

export interface NotificationPage {
  items: NotificationView[];
  next_cursor: string | null;
  /** Solo en la primera página: cuántos avisos sin leer tiene la persona (de conversaciones que todavía puede abrir). */
  unread: number | null;
}

export interface CreatedNotice {
  userId: string;
  notificationId: string;
}

const KEY = sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Centro de avisos (F1, ADR-57). Un aviso es de UNA persona: solo su destinatario lo ve y lo marca (ni el administrador). Los de una conversación que la persona ya no puede abrir no se muestran
 * (misma visibilidad que la bandeja), ni cuentan en el contador. El texto de la nota no se copia al aviso.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  /**
   * Guarda las menciones de una nota y crea UN aviso por persona mencionada (menos quien la escribió), dentro de la transacción de la nota. El llamador ya validó que cada persona
   * es de la empresa y puede ver la conversación. Devuelve a quién se avisó (para el aviso en vivo, que sale después de confirmar).
   */
  async recordMentions(tx: TenantTx, input: { messageId: string; conversationId: string; actorId: string; mentioned: readonly string[] }): Promise<CreatedNotice[]> {
    const ids = [...new Set(input.mentioned)];
    if (ids.length === 0) return [];
    await tx.insert(messageMentions).values(ids.map((userId) => ({ messageId: input.messageId, userId })));
    const targets = ids.filter((u) => u !== input.actorId);
    if (targets.length === 0) return [];
    const rows = await tx
      .insert(notifications)
      .values(targets.map((userId) => ({ userId, type: 'mention', actorId: input.actorId, conversationId: input.conversationId, messageId: input.messageId })))
      .returning({ id: notifications.id, userId: notifications.userId });
    return rows.map((r) => ({ userId: r.userId, notificationId: r.id }));
  }

  /**
   * «Nueva venta» (v13 S4.2): un aviso por persona de `recipients` (menos quien la registró), en su propia transacción —se llama DESPUÉS de confirmar la venta, nunca dentro—. Es idempotente:
   * una persona tiene a lo sumo UN aviso por venta (índice único), así que repetir la llamada no duplica. Devuelve solo a quienes se les creó ahora (para el aviso en vivo).
   */
  async recordSaleCreated(input: { saleId: string; actorId: string; recipients: readonly string[] }): Promise<CreatedNotice[]> {
    const ids = [...new Set(input.recipients)].filter((u) => u !== input.actorId);
    if (ids.length === 0) return [];
    const rows = await this.db.withTenant((tx) =>
      tx
        .insert(notifications)
        .values(ids.map((userId) => ({ userId, type: 'sale_created', actorId: input.actorId, saleId: input.saleId })))
        .onConflictDoNothing()
        .returning({ id: notifications.id, userId: notifications.userId }),
    );
    return rows.map((r) => ({ userId: r.userId, notificationId: r.id }));
  }

  /** Las personas mencionadas en cada nota (por id de mensaje), con su nombre actual. Lectura para armar la vista del hilo. */
  async mentionsOf(messageIds: readonly string[]): Promise<Map<string, Array<{ user_id: string; name: string }>>> {
    const out = new Map<string, Array<{ user_id: string; name: string }>>();
    if (messageIds.length === 0) return out;
    const rows = await this.db.withTenant((tx) => tx.select({ messageId: messageMentions.messageId, userId: messageMentions.userId }).from(messageMentions).where(inArray(messageMentions.messageId, [...messageIds])));
    const names = await this.members.labels([...new Set(rows.map((r) => r.userId))]);
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      list.push({ user_id: r.userId, name: names.get(r.userId)?.name ?? 'Persona desconocida' });
      out.set(r.messageId, list);
    }
    return out;
  }

  /**
   * Condiciones comunes de «mis avisos visibles»: míos y de los últimos 90 días, y además: una mención solo si la conversación todavía se puede abrir y su contacto sigue vigente; un aviso de tarea solo
   * mientras la tarea existe, no está borrada y sigue siendo mía (y el de vencimiento, mientras siga pendiente). Con subconsultas `EXISTS` (la unión por la izquierda tipa mal en este Drizzle).
   */
  private mine(me: string, viewAll: boolean, tx: TenantTx, since: Date, extra?: SQL): (SQL | undefined)[] {
    const mention = and(
      eq(notifications.type, 'mention'),
      exists(
        tx
          .select({ one: sql`1` })
          .from(conversations)
          .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
          .where(and(eq(conversations.organizationId, notifications.organizationId), eq(conversations.id, notifications.conversationId), isNull(contacts.deletedAt), conversationVisibleTo(me, viewAll))),
      ),
    );
    const task = and(
      inArray(notifications.type, ['task_assigned', 'task_due']),
      exists(
        tx
          .select({ one: sql`1` })
          .from(tasks)
          .where(and(eq(tasks.organizationId, notifications.organizationId), eq(tasks.id, notifications.taskId), isNull(tasks.deletedAt), eq(tasks.assigneeId, me), or(ne(notifications.type, 'task_due'), eq(tasks.status, 'open')))),
      ),
    );
    // Alerta de sistema (v11 67c): no depende de ninguna conversación ni tarea; es de quien la recibe
    const system = eq(notifications.type, 'calendar_reconnect');
    // Venta nueva (v13 S4.2): solo la ve quien ve toda la empresa (la administración) y mientras la venta exista; un asesor nunca ve avisos de ventas ajenas
    const sale = and(eq(notifications.type, 'sale_created'), viewAll ? exists(tx.select({ one: sql`1` }).from(sales).where(and(eq(sales.organizationId, notifications.organizationId), eq(sales.id, notifications.saleId)))) : sql`false`);
    return [eq(notifications.userId, me), gt(notifications.createdAt, since), or(mention, task, system, sale), extra];
  }

  async list(access: NotificationsAccess, q: ListNotificationsQuery): Promise<NotificationPage> {
    const me = TenantContext.current().userId;
    if (!me) throw new NotFoundError();
    const since = new Date(Date.now() - VISIBLE_DAYS * 24 * 60 * 60 * 1000);
    const cursor = q.cursor ? decodeTimeCursor(q.cursor) : null;
    const data = await this.db.withTenant(async (tx) => {
      const where: (SQL | undefined)[] = this.mine(me, access.viewAll, tx, since, q.unread ? isNull(notifications.readAt) : undefined);
      if (cursor) where.push(or(lt(notifications.createdAt, sql`${cursor.k}::timestamptz`), and(eq(notifications.createdAt, sql`${cursor.k}::timestamptz`), lt(notifications.id, cursor.id))));
      const rows = await tx
        .select({ n: notifications, key: KEY })
        .from(notifications)
        .where(and(...where))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(q.limit + 1);
      let unread = null as number | null;
      if (!cursor) {
        const [r] = await tx
          .select({ n: count() })
          .from(notifications)
          .where(and(...this.mine(me, access.viewAll, tx, since, isNull(notifications.readAt))));
        unread = r?.n ?? 0;
      }
      const page = rows.slice(0, q.limit);
      // El extracto sale del mensaje (el aviso no guarda el texto); el contacto y la tarea, de sus tablas
      const messageIds = page.map((r) => r.n.messageId).filter((x): x is string => x !== null);
      const bodies = new Map<string, string | null>(messageIds.length === 0 ? [] : (await tx.select({ id: messages.id, body: messages.body }).from(messages).where(inArray(messages.id, messageIds))).map((m) => [m.id, m.body]));
      const conversationIds = page.map((r) => r.n.conversationId).filter((x): x is string => x !== null);
      const contactsByConversation = new Map<string, { id: string; name: string }>(
        conversationIds.length === 0
          ? []
          : (await tx.select({ conversationId: conversations.id, contactId: contacts.id, name: contacts.name }).from(conversations).innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId))).where(inArray(conversations.id, conversationIds))).map(
              (c) => [c.conversationId, { id: c.contactId, name: c.name }],
            ),
      );
      const taskIds = page.map((r) => r.n.taskId).filter((x): x is string => x !== null);
      const tasksById = new Map<string, { id: string; title: string; dueAt: Date | null; status: string; contactId: string | null }>(
        taskIds.length === 0 ? [] : (await tx.select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, status: tasks.status, contactId: tasks.contactId }).from(tasks).where(inArray(tasks.id, taskIds))).map((t) => [t.id, t]),
      );
      const saleIds = page.map((r) => r.n.saleId).filter((x): x is string => x !== null);
      const salesById = new Map<string, { id: string; product: string; amount: string; currency: string; sellerId: string; contactId: string; contactName: string }>(
        saleIds.length === 0
          ? []
          : (await tx.select({ id: sales.id, product: sales.productName, amount: sales.amount, currency: sales.currency, sellerId: sales.sellerId, contactId: contacts.id, contactName: contacts.name }).from(sales).innerJoin(contacts, and(eq(contacts.organizationId, sales.organizationId), eq(contacts.id, sales.contactId))).where(inArray(sales.id, saleIds))).map((s) => [s.id, s]),
      );
      return { rows, page, unread, bodies, contactsByConversation, tasksById, salesById };
    });
    const names = await this.members.labels([...new Set([...data.page.map((r) => r.n.actorId), ...[...data.salesById.values()].map((s) => s.sellerId)].filter((x): x is string => x !== null))]);
    const last = data.page[data.page.length - 1];
    return {
      items: data.page.map((r) => {
        const contact = r.n.conversationId ? data.contactsByConversation.get(r.n.conversationId) : undefined;
        const task = r.n.taskId ? data.tasksById.get(r.n.taskId) : undefined;
        const sale = r.n.saleId ? data.salesById.get(r.n.saleId) : undefined;
        return {
          id: r.n.id,
          type: r.n.type as NotificationType,
          created_at: r.n.createdAt.toISOString(),
          read_at: r.n.readAt?.toISOString() ?? null,
          actor: r.n.actorId ? (names.get(r.n.actorId) ?? { id: r.n.actorId, name: 'Persona desconocida' }) : null,
          conversation: r.n.conversationId && contact ? { id: r.n.conversationId, contact: { id: contact.id, name: contact.name } } : null,
          message_id: r.n.messageId,
          excerpt: r.n.messageId && data.bodies.get(r.n.messageId) ? excerpt(data.bodies.get(r.n.messageId)!) : null,
          task: task ? { id: task.id, title: task.title, due_at: task.dueAt ? task.dueAt.toISOString() : null, status: task.status as 'open' | 'done', contact_id: task.contactId } : null,
          sale: sale ? { id: sale.id, product: sale.product, amount: sale.amount, currency: sale.currency, seller: names.get(sale.sellerId) ?? { id: sale.sellerId, name: 'Persona desconocida' }, contact: { id: sale.contactId, name: sale.contactName } } : null,
        };
      }),
      next_cursor: data.rows.length > q.limit && last ? encodeTimeCursor({ k: last.key, id: last.n.id }) : null,
      unread: data.unread,
    };
  }

  /** Marca un aviso PROPIO como leído (repetirlo no hace nada). Un aviso ajeno o inexistente responde 404 igual. */
  async markRead(id: string): Promise<{ id: string; read_at: string }> {
    const me = TenantContext.current().userId;
    if (!me) throw new NotFoundError();
    const now = new Date();
    const row = await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select({ id: notifications.id, readAt: notifications.readAt }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, me))).limit(1);
      if (!cur) throw new NotFoundError();
      if (cur.readAt) return cur.readAt;
      await tx.update(notifications).set({ readAt: now }).where(and(eq(notifications.id, id), eq(notifications.userId, me), isNull(notifications.readAt)));
      return now;
    });
    return { id, read_at: row.toISOString() };
  }

  /** Marca como leídos todos los avisos propios que siguen sin leer. Devuelve cuántos cambió. */
  async markAllRead(): Promise<{ updated: number }> {
    const me = TenantContext.current().userId;
    if (!me) throw new NotFoundError();
    const rows = await this.db.withTenant((tx) => tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, me), isNull(notifications.readAt))).returning({ id: notifications.id }));
    return { updated: rows.length };
  }
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}
