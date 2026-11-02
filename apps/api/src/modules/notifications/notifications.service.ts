import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { contacts, conversations, Database, messageMentions, messages, notifications, type TenantTx } from '../../db';
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

export interface NotificationView {
  id: string;
  type: 'mention';
  created_at: string;
  read_at: string | null;
  actor: { id: string; name: string } | null;
  conversation: { id: string; contact: { id: string; name: string } };
  message_id: string | null;
  /** Primeras palabras de la nota (se lee del mensaje al pedir la lista: el aviso no guarda el texto). */
  excerpt: string | null;
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

  /** Condiciones comunes de «mis avisos visibles»: míos, de los últimos 90 días y de una conversación que puedo abrir con su contacto vigente. */
  private mine(me: string, viewAll: boolean, since: Date, extra?: SQL): (SQL | undefined)[] {
    return [eq(notifications.userId, me), gt(notifications.createdAt, since), isNull(contacts.deletedAt), conversationVisibleTo(me, viewAll), extra];
  }

  async list(access: NotificationsAccess, q: ListNotificationsQuery): Promise<NotificationPage> {
    const me = TenantContext.current().userId;
    if (!me) throw new NotFoundError();
    const since = new Date(Date.now() - VISIBLE_DAYS * 24 * 60 * 60 * 1000);
    const cursor = q.cursor ? decodeTimeCursor(q.cursor) : null;
    const data = await this.db.withTenant(async (tx) => {
      const where: (SQL | undefined)[] = this.mine(me, access.viewAll, since, q.unread ? isNull(notifications.readAt) : undefined);
      if (cursor) where.push(or(lt(notifications.createdAt, sql`${cursor.k}::timestamptz`), and(eq(notifications.createdAt, sql`${cursor.k}::timestamptz`), lt(notifications.id, cursor.id))));
      const rows = await tx
        .select({ n: notifications, key: KEY, contactId: contacts.id, contactName: contacts.name })
        .from(notifications)
        .innerJoin(conversations, and(eq(conversations.organizationId, notifications.organizationId), eq(conversations.id, notifications.conversationId)))
        .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
        .where(and(...where))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(q.limit + 1);
      let unread = null as number | null;
      if (!cursor) {
        const [r] = await tx
          .select({ n: count() })
          .from(notifications)
          .innerJoin(conversations, and(eq(conversations.organizationId, notifications.organizationId), eq(conversations.id, notifications.conversationId)))
          .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
          .where(and(...this.mine(me, access.viewAll, since, isNull(notifications.readAt))));
        unread = r?.n ?? 0;
      }
      // El extracto sale del mensaje (el aviso no guarda el texto)
      const ids = rows.map((r) => r.n.messageId).filter((x): x is string => x !== null);
      const bodies = new Map<string, string | null>(ids.length === 0 ? [] : (await tx.select({ id: messages.id, body: messages.body }).from(messages).where(inArray(messages.id, ids))).map((m) => [m.id, m.body]));
      return { rows, unread, bodies };
    });
    const page = data.rows.slice(0, q.limit);
    const names = await this.members.labels([...new Set(page.map((r) => r.n.actorId).filter((x): x is string => x !== null))]);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.n.id,
        type: 'mention' as const,
        created_at: r.n.createdAt.toISOString(),
        read_at: r.n.readAt?.toISOString() ?? null,
        actor: r.n.actorId ? (names.get(r.n.actorId) ?? { id: r.n.actorId, name: 'Persona desconocida' }) : null,
        conversation: { id: r.n.conversationId!, contact: { id: r.contactId, name: r.contactName } },
        message_id: r.n.messageId,
        excerpt: r.n.messageId && data.bodies.get(r.n.messageId) ? excerpt(data.bodies.get(r.n.messageId)!) : null,
      })),
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
