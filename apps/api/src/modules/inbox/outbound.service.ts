import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { conversations, Database, messages, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { OrgDirectoryService, OrgMembersService } from '../organizations';
import { SlaService } from '../sla';
import { renderedText, TemplatesService, type TemplateList } from '../templates';
import { assertCanReply, assertWindowOpen, loadConversation, scopeOf, type ConversationRow, type InboxAccess, type InboxScope } from './inbox.access';
import type { NoteDto, ReplyDto, SendTemplateDto } from './inbox.dto';
import { messageView, type MessageView } from './inbox.views';
import { OutboundDispatcher } from './outbound-dispatcher.service';

/** Lo que un envío humano pone en el mensaje: texto o plantilla ya armada. */
interface Outgoing {
  kind: 'text' | 'template';
  body: string;
  meta: Record<string, unknown>;
  /** ¿Solo se puede enviar dentro de las 24 h del último mensaje del cliente? (el texto sí; una plantilla, no). */
  needsWindow: boolean;
}

/**
 * Lo que una persona escribe en una conversación (M5.4, ADR-50): respuestas al cliente y notas internas.
 *  - RESPONDER: solo quien tiene asignada la conversación, abierta, con la conexión activa y dentro de las 24 h del último mensaje del cliente (si no, 409 `WINDOW_CLOSED`;
 *    pasada la ventana solo se admiten plantillas: ver más abajo). El mensaje se guarda `queued` junto con el cambio de la conversación (pasa a «esperando al cliente»;
 *    si estaba pendiente, queda aceptada) y se intenta enviar al instante; si el proveedor falla, la tarea periódica lo reintenta con espera creciente. La petición
 *    NUNCA falla por culpa del proveedor: el resultado queda en el estado del mensaje.
 *  - PLANTILLA (M5.6a): una plantilla aprobada de la conexión de la conversación, con sus variables ya resueltas. Mismas reglas de quién puede responder, pero DENTRO O
 *    FUERA de las 24 h (fuera es lo único permitido). Es un mensaje humano: detiene el SLA y deja la conversación «esperando al cliente», igual que responder.
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
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async reply(access: InboxAccess, conversationId: string, dto: ReplyDto): Promise<MessageView> {
    return this.send(scopeOf(access), conversationId, () => Promise.resolve({ kind: 'text', body: dto.text, meta: {}, needsWindow: true }));
  }

  /** Las plantillas que esta persona puede enviar en esta conversación (las de SU conexión). Mismas reglas de acceso que responder. */
  async listTemplates(access: InboxAccess, conversationId: string): Promise<TemplateList> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const channelId = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, conversationId);
      assertCanReply(scope, c, channel.state, collab);
      return c.channelAccountId;
    });
    return this.templates.forChannel(channelId);
  }

  /** Envía una plantilla aprobada de la conexión de la conversación. 404 si no es de esa conexión, 409 si ya no se puede enviar, 400 con el campo si una variable no vale. */
  async sendTemplate(access: InboxAccess, conversationId: string, dto: SendTemplateDto): Promise<MessageView> {
    return this.send(scopeOf(access), conversationId, async (tx, c) => {
      const row = await this.templates.getSendable(tx, c.channelAccountId, dto.template_id);
      const p = this.templates.prepare(row, dto.params);
      const template = { id: row.id, name: row.name, language: row.language, category: row.category, buttons: p.rendered.buttons, send: p.send };
      return { kind: 'template', body: renderedText(p.rendered), meta: { template }, needsWindow: false };
    });
  }

  /** Lo común de escribirle al cliente: permisos, ventana, guardar el mensaje en cola, mover la conversación, detener el SLA e intentar el envío al instante. */
  private async send(scope: InboxScope, conversationId: string, make: (tx: TenantTx, c: ConversationRow) => Promise<Outgoing>): Promise<MessageView> {
    if (!scope.canReply) throw new ForbiddenError();
    const now = new Date();
    const timeZone = (await this.directory.current()).timeZone;
    const messageId = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, conversationId, true);
      assertCanReply(scope, c, channel.state, collab);
      const out = await make(tx, c);
      if (out.needsWindow) assertWindowOpen(c.lastInboundAt, now);
      const [m] = await tx
        .insert(messages)
        .values({ conversationId, channelAccountId: c.channelAccountId, direction: 'out', senderType: 'human', kind: out.kind, body: out.body, meta: out.meta, status: 'queued', sentAt: now, createdBy: scope.userId, attempts: 0, nextAttemptAt: now })
        .returning({ id: messages.id });
      const at = now.toISOString();
      await tx
        .update(conversations)
        .set({ status: 'waiting', lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${at}::timestamptz), ${at}::timestamptz)`, unreadCount: 0, updatedAt: now })
        .where(eq(conversations.id, conversationId));
      // El primer mensaje HUMANO detiene el cronómetro de respuesta (no una nota ni un mensaje automático) y guarda cuánto tardó
      await this.sla.stopOnReply(tx, conversationId, m!.id, { now, timeZone });
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
      const [probe] = await tx.select({ conversationId: messages.conversationId, kind: messages.kind }).from(messages).where(and(eq(messages.id, messageId), eq(messages.direction, 'out'), sql`${messages.kind} <> 'note'`)).limit(1);
      if (!probe) throw new NotFoundError();
      // Mismo orden de bloqueos que al responder: primero la conversación (404 si no puede verla), luego el mensaje
      const { c, channel, collab } = await loadConversation(tx, scope, probe.conversationId, true);
      const [m] = await tx.select({ status: messages.status }).from(messages).where(eq(messages.id, messageId)).for('update').limit(1);
      if (!m) throw new NotFoundError();
      if (m.status === 'queued') return;
      if (m.status !== 'failed') throw new ConflictError('MESSAGE_NOT_FAILED', 'Solo se puede reintentar un mensaje que falló');
      assertCanReply(scope, c, channel.state, collab);
      // Una plantilla se puede reenviar fuera de las 24 h: es justo para lo que sirve
      if (probe.kind !== 'template') assertWindowOpen(c.lastInboundAt, now);
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
