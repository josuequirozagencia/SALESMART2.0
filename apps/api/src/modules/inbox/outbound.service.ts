import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { conversations, Database, messages } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { OrgMembersService } from '../organizations';
import { assertCanReply, assertWindowOpen, loadConversation, scopeOf, type InboxAccess } from './inbox.access';
import type { NoteDto, ReplyDto } from './inbox.dto';
import { messageView, type MessageView } from './inbox.views';
import { OutboundDispatcher } from './outbound-dispatcher.service';

/**
 * Lo que una persona escribe en una conversación (M5.4, ADR-50): respuestas al cliente y notas internas.
 *  - RESPONDER: solo quien tiene asignada la conversación, abierta, con la conexión activa y dentro de las 24 h del último mensaje del cliente (si no, 409 `WINDOW_CLOSED`;
 *    pasada la ventana solo se admiten plantillas, que llegan en M5.6). El mensaje se guarda `queued` junto con el cambio de la conversación (pasa a «esperando al cliente»;
 *    si estaba pendiente, queda aceptada) y se intenta enviar al instante; si el proveedor falla, la tarea periódica lo reintenta con espera creciente. La petición
 *    NUNCA falla por culpa del proveedor: el resultado queda en el estado del mensaje.
 *  - NOTA INTERNA: la ve quien pueda ver la conversación; nunca sale al cliente (tipo `note` con estado `internal`: ningún camino de envío la toma) y no mueve la conversación.
 *  - REINTENTAR un mensaje fallido.
 * El texto de un mensaje es dato personal: no va a logs ni a la auditoría.
 */
@Injectable()
export class OutboundService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(OutboundDispatcher) private readonly dispatcher: OutboundDispatcher,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async reply(access: InboxAccess, conversationId: string, dto: ReplyDto): Promise<MessageView> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const now = new Date();
    const messageId = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, conversationId, true);
      assertCanReply(scope, c, channel.state, collab);
      assertWindowOpen(c.lastInboundAt, now);
      const [m] = await tx
        .insert(messages)
        .values({ conversationId, channelAccountId: c.channelAccountId, direction: 'out', senderType: 'human', kind: 'text', body: dto.text, status: 'queued', sentAt: now, createdBy: scope.userId, attempts: 0, nextAttemptAt: now })
        .returning({ id: messages.id });
      const at = now.toISOString();
      await tx
        .update(conversations)
        .set({ status: 'waiting', lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${at}::timestamptz), ${at}::timestamptz)`, unreadCount: 0, updatedAt: now })
        .where(eq(conversations.id, conversationId));
      // Responder sin haber aceptado equivale a aceptar: queda en la auditoría como el cambio de estado que es
      if (c.status === 'pending') await writeAudit(tx, { entityType: 'conversation', entityId: conversationId, field: 'status', oldValue: 'pending', newValue: 'waiting' });
      return m!.id;
    });
    return this.sendNow(messageId);
  }

  async note(access: InboxAccess, conversationId: string, dto: NoteDto): Promise<MessageView> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const id = await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, conversationId); // 404 si no puede verla
      const [m] = await tx
        .insert(messages)
        .values({ conversationId, channelAccountId: c.channelAccountId, direction: 'out', senderType: 'human', kind: 'note', body: dto.text, status: 'internal', sentAt: new Date(), createdBy: scope.userId })
        .returning({ id: messages.id });
      return m!.id;
    });
    return this.view(id);
  }

  /** Vuelve a poner en cola un mensaje fallido (a mano, p. ej. tras reconectar el número o cuando el cliente volvió a escribir). Repetirlo sobre uno ya en cola no hace nada. */
  async retry(access: InboxAccess, messageId: string): Promise<MessageView> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const now = new Date();
    await this.db.withTenant(async (tx) => {
      const [probe] = await tx.select({ conversationId: messages.conversationId }).from(messages).where(and(eq(messages.id, messageId), eq(messages.direction, 'out'), sql`${messages.kind} <> 'note'`)).limit(1);
      if (!probe) throw new NotFoundError();
      // Mismo orden de bloqueos que al responder: primero la conversación (404 si no puede verla), luego el mensaje
      const { c, channel, collab } = await loadConversation(tx, scope, probe.conversationId, true);
      const [m] = await tx.select({ status: messages.status }).from(messages).where(eq(messages.id, messageId)).for('update').limit(1);
      if (!m) throw new NotFoundError();
      if (m.status === 'queued') return;
      if (m.status !== 'failed') throw new ConflictError('MESSAGE_NOT_FAILED', 'Solo se puede reintentar un mensaje que falló');
      assertCanReply(scope, c, channel.state, collab);
      assertWindowOpen(c.lastInboundAt, now);
      await tx.update(messages).set({ status: 'queued', error: null, attempts: 0, nextAttemptAt: now, meta: sql`${messages.meta} - 'error_code'` }).where(eq(messages.id, messageId));
    });
    return this.sendNow(messageId);
  }

  /** Intenta enviar de inmediato y devuelve el mensaje tal como quedó. Un fallo inesperado del envío no tumba la petición: el mensaje ya está guardado y la tarea lo retoma. */
  private async sendNow(messageId: string): Promise<MessageView> {
    try {
      await this.dispatcher.dispatchOne(messageId);
    } catch (e) {
      this.log.error({ message_id: messageId, err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo intentar el envío al instante; lo retomará la tarea periódica');
    }
    return this.view(messageId);
  }

  private async view(messageId: string): Promise<MessageView> {
    const row = await this.db.withTenant(async (tx) => (await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]);
    if (!row) throw new NotFoundError();
    const author = row.createdBy ? ((await this.members.labels([row.createdBy])).get(row.createdBy) ?? { id: row.createdBy, name: 'Persona desconocida' }) : null;
    return messageView(row, author);
  }
}
