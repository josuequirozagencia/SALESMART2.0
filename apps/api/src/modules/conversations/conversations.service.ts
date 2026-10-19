import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { conversations, messages, type TenantTx } from '../../db';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { AssignmentService, type AssignmentContext } from '../queues';
import { SystemTagsService } from '../tags';
import type { NormalizedMessage, NormalizedStatus } from './normalized';

export interface IngestResult {
  /** El mensaje ya estaba registrado (mismo canal y mismo identificador): no se cambió nada. */
  duplicate: boolean;
  conversationId: string | null;
  contactCreated: boolean;
  conversationCreated: boolean;
}

export type StatusResult = 'updated' | 'unchanged' | 'unknown';

/** Orden de los estados de un mensaje enviado: nunca se retrocede (los avisos pueden llegar desordenados). */
const RANK: Readonly<Record<string, number>> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Conversaciones y mensajes (M5.2, ADR-50). Todo va DENTRO de la transacción y del TenantContext de quien llama (la tarea que procesa los avisos de un canal):
 * la empresa nunca sale del mensaje. Contactos: por teléfono (el existente o uno nuevo sin consentimiento). Una sola conversación ABIERTA por contacto y canal.
 * El texto de un mensaje es dato personal: no se registra en logs ni en la auditoría.
 */
@Injectable()
export class ConversationsService {
  constructor(
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(AssignmentService) private readonly assignment: AssignmentService,
    @Inject(SystemTagsService) private readonly tags: SystemTagsService,
  ) {}

  /**
   * Registra un mensaje que ENTRA. Idempotente por `(canal, externalId)`: repetirlo no crea nada. Crea el contacto y la conversación si hacen falta, y
   * actualiza la conversación (último mensaje, no leídos; si esperaba al cliente, vuelve a «trabajando») y, si sigue «sin asignar», la reparte según la cola de su
   * conexión (M5.3). `assign` trae lo de identidad que el reparto necesita (zona horaria y quién puede recibir trabajo): se resuelve antes de abrir la transacción.
   */
  async ingestInbound(tx: TenantTx, channelAccountId: string, m: NormalizedMessage, assign: AssignmentContext): Promise<IngestResult> {
    const [seen] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.channelAccountId, channelAccountId), eq(messages.externalId, m.externalId))).limit(1);
    if (seen) return { duplicate: true, conversationId: null, contactCreated: false, conversationCreated: false };

    const contact = await this.contacts.findOrCreateByPhone(tx, m.from, 'whatsapp', m.profileName);
    // Alguien nuevo que escribe es un lead (ADR-08): lo pone el sistema. No se manda evento a Meta: sin un clic de anuncio no hay a quién atribuirlo
    if (contact.created) await this.tags.apply(tx, contact.id, 'lead');
    const conv = await this.openConversation(tx, contact.id, channelAccountId);
    const inserted = await tx
      .insert(messages)
      .values({
        conversationId: conv.id,
        channelAccountId,
        externalId: m.externalId,
        direction: 'in',
        senderType: 'contact',
        kind: m.kind,
        body: m.text,
        media: m.media ? { id: m.media.id, mime_type: m.media.mimeType, filename: m.media.filename } : null,
        meta: { wa_id: m.fromRaw, ...m.extra },
        status: 'received',
        sentAt: m.sentAt,
      })
      // El predicado del índice parcial va SIN nombre de tabla: PostgreSQL no admite calificar la columna en el objetivo de ON CONFLICT
      .onConflictDoNothing({ target: [messages.organizationId, messages.channelAccountId, messages.externalId], where: sql`external_id IS NOT NULL` })
      .returning({ id: messages.id });
    // Dos entregas del mismo mensaje a la vez: gana una y la otra no toca la conversación
    if (inserted.length === 0) return { duplicate: true, conversationId: conv.id, contactCreated: contact.created, conversationCreated: conv.created };

    const at = m.sentAt.toISOString();
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${at}::timestamptz), ${at}::timestamptz)`,
        lastInboundAt: sql`GREATEST(COALESCE(${conversations.lastInboundAt}, ${at}::timestamptz), ${at}::timestamptz)`,
        unreadCount: sql`${conversations.unreadCount} + 1`,
        status: sql`CASE WHEN ${conversations.status} = 'waiting' THEN 'working' ELSE ${conversations.status} END`,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conv.id));
    // Una conversación sin dueño (nueva, o que antes no tenía a quién) se reparte ahora; si ya tiene dueño no se toca
    await this.assignment.assignConversation(tx, conv.id, assign);
    return { duplicate: false, conversationId: conv.id, contactCreated: contact.created, conversationCreated: conv.created };
  }

  /**
   * Aplica el estado que informa el proveedor a un mensaje NUESTRO (enviado). Nunca retrocede: `read` no vuelve a `delivered`, y un fallo no pisa algo ya
   * entregado. Un aviso de un mensaje que no conocemos (enviado desde otro lugar, o anterior a este sistema) se ignora y se cuenta como `unknown`.
   */
  async applyStatus(tx: TenantTx, channelAccountId: string, s: NormalizedStatus): Promise<StatusResult> {
    const [row] = await tx
      .select({ id: messages.id, status: messages.status, deliveredAt: messages.deliveredAt, readAt: messages.readAt })
      .from(messages)
      .where(and(eq(messages.channelAccountId, channelAccountId), eq(messages.externalId, s.externalId), eq(messages.direction, 'out')))
      .for('update')
      .limit(1);
    if (!row) return 'unknown';

    const cur = RANK[row.status];
    const set: Partial<typeof messages.$inferInsert> = {};
    if (s.state === 'failed') {
      if (cur !== undefined && cur <= RANK['sent']!) {
        set.status = 'failed';
        set.error = s.error ? `${s.error.code}: ${s.error.title}`.slice(0, 300) : 'El proveedor no pudo entregar el mensaje';
      }
    } else {
      // Los avisos de entregado y leído quedan con su hora aunque lleguen desordenados; el estado solo avanza
      if (s.state === 'delivered' && row.deliveredAt === null) set.deliveredAt = s.at;
      if (s.state === 'read' && row.readAt === null) set.readAt = s.at;
      if (cur !== undefined && RANK[s.state]! > cur) set.status = s.state;
    }
    if (Object.keys(set).length === 0) return 'unchanged';
    await tx.update(messages).set(set).where(eq(messages.id, row.id));
    return 'updated';
  }

  /** La conversación abierta del contacto en el canal, o una nueva. Serializa por (contacto, canal): dos mensajes simultáneos no abren dos. */
  private async openConversation(tx: TenantTx, contactId: string, channelAccountId: string): Promise<{ id: string; created: boolean }> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended((${`conversation:${contactId}:${channelAccountId}`}::text || ':' || app_org()::text), 0))`);
    const [open] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.contactId, contactId), eq(conversations.channelAccountId, channelAccountId), ne(conversations.status, 'closed')))
      .limit(1);
    if (open) return { id: open.id, created: false };
    const [c] = await tx.insert(conversations).values({ contactId, channelAccountId }).returning({ id: conversations.id });
    await writeAudit(tx, { entityType: 'conversation', entityId: c!.id, newValue: { contact_id: contactId, channel_account_id: channelAccountId, status: 'unassigned' }, source: 'meta' });
    return { id: c!.id, created: true };
  }
}
