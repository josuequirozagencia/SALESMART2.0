import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { conversations, messageAttachments, messages, type TenantTx } from '../../db';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { AssignmentService, type AssignmentContext } from '../queues';
import { SlaService } from '../sla';
import { SystemTagsService } from '../tags';
import { AutoMessagesService } from './auto-messages.service';
import type { NormalizedMessage, NormalizedReaction, NormalizedStatus } from './normalized';

/** Tipos de mensaje entrante que traen un archivo para descargar (M5.6d). Vive aquí y no en `attachments`: ese módulo depende de `channels`, que depende de este (sería un ciclo). */
const FILE_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** Texto del cliente listo para guardarse en una columna acotada: sin caracteres de control y con el largo máximo; null si queda vacío. */
function clean(raw: string | null | undefined, max: number): string | null {
  const t = (raw ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, max);
  return t === '' ? null : t;
}

export interface IngestResult {
  /** El mensaje ya estaba registrado (mismo canal y mismo identificador): no se cambió nada. */
  duplicate: boolean;
  conversationId: string | null;
  contactCreated: boolean;
  conversationCreated: boolean;
}

export type StatusResult = 'updated' | 'unchanged' | 'unknown';
export type ReactionResult = 'updated' | 'unchanged' | 'unknown';

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
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(AutoMessagesService) private readonly autoMessages: AutoMessagesService,
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
    const conv = await this.openConversation(tx, contact.id, channelAccountId, m.fromRaw);
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

    // Adjunto entrante (M5.6d): el mensaje queda, y aparte el archivo en `message_attachments` para que la tarea `attachments` lo descargue y lo revise (no bloquea la ingesta)
    if (m.media && FILE_KINDS.has(m.kind)) {
      await tx.insert(messageAttachments).values({
        conversationId: conv.id,
        messageId: inserted[0]!.id,
        direction: 'in',
        kind: m.kind,
        // Lo que manda el cliente se acota ANTES de guardarlo: una restricción de la base que falle aquí tumbaría la ingesta de todo el mensaje
        mimeType: clean((m.media.mimeType ?? '').split(';')[0], 127)?.toLowerCase() ?? 'application/octet-stream',
        filename: clean(m.media.filename, 200),
        sourceMediaId: clean(m.media.id, 200),
        state: 'pending',
        scanStatus: 'pending',
        nextAttemptAt: new Date(),
      });
    }

    const at = m.sentAt.toISOString();
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${at}::timestamptz), ${at}::timestamptz)`,
        lastInboundAt: sql`GREATEST(COALESCE(${conversations.lastInboundAt}, ${at}::timestamptz), ${at}::timestamptz)`,
        unreadCount: sql`${conversations.unreadCount} + 1`,
        // A quien escribió se le responde por el identificador que informó el proveedor (puede cambiar, p. ej. si cambia de número)
        peerId: m.fromRaw,
        status: sql`CASE WHEN ${conversations.status} = 'waiting' THEN 'working' ELSE ${conversations.status} END`,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conv.id));
    // Una conversación sin dueño (nueva, o que antes no tenía a quién) se reparte ahora; si ya tiene dueño no se toca
    const a = await this.assignment.assignConversation(tx, conv.id, assign);
    // Si ya tenía dueño, el cliente espera una respuesta POSTERIOR (el cronómetro corre desde su mensaje, no desde que lo procesamos); si acaba de asignarse, ya corre el de primera respuesta
    if (!a.assigned && a.ownerId) await this.sla.startFollowup(tx, { id: conv.id, ownerId: a.ownerId, queueId: a.queueId }, { now: m.sentAt.getTime() <= assign.now.getTime() ? m.sentAt : assign.now, timeZone: assign.timeZone });
    // Saludo o aviso de fuera de horario de la cola (M5.5c): salen al cliente como mensaje automático, que no es una respuesta humana
    await this.autoMessages.afterInbound(tx, { conversationId: conv.id, channelAccountId, queueId: a.queueId, created: conv.created, receivedAt: m.sentAt.getTime() <= assign.now.getTime() ? m.sentAt : assign.now, inboundAt: m.sentAt, now: assign.now, timeZone: assign.timeZone });
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

  /**
   * Aplica la reacción del cliente al mensaje al que reacciona (de ese canal y de esa empresa: la RLS y el filtro por canal impiden tocar otro). Se guarda en el propio
   * mensaje (`meta.reaction`, con su hora): la última reacción reemplaza a la anterior y una sin emoji la quita; un aviso más antiguo que lo guardado no la pisa. NO es un
   * mensaje nuevo: no suma no leídos, no mueve la conversación ni cambia su estado ni abre la ventana de 24 h. Reaccionar a un mensaje que no conocemos (aún no anotado
   * o de otro lugar) es `unknown`: quien llama decide si vuelve a mirar.
   */
  async applyReaction(tx: TenantTx, channelAccountId: string, r: NormalizedReaction): Promise<ReactionResult> {
    const [row] = await tx
      .select({ id: messages.id, meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.channelAccountId, channelAccountId), eq(messages.externalId, r.targetExternalId)))
      .for('update')
      .limit(1);
    if (!row) return 'unknown';
    const prev = typeof row.meta['reaction_at'] === 'string' ? Date.parse(row.meta['reaction_at']) : Number.NaN;
    if (!Number.isNaN(prev) && prev > r.at.getTime()) return 'unchanged';
    const current = typeof row.meta['reaction'] === 'string' ? row.meta['reaction'] : null;
    if (!Number.isNaN(prev) && prev === r.at.getTime() && current === r.emoji) return 'unchanged';
    const patch = JSON.stringify(r.emoji ? { reaction: r.emoji, reaction_at: r.at.toISOString() } : { reaction_at: r.at.toISOString() });
    await tx
      .update(messages)
      .set({ meta: r.emoji ? sql`${messages.meta} || ${patch}::jsonb` : sql`(${messages.meta} - 'reaction') || ${patch}::jsonb` })
      .where(eq(messages.id, row.id));
    return 'updated';
  }

  /** La conversación abierta del contacto en el canal, o una nueva. Serializa por (contacto, canal): dos mensajes simultáneos no abren dos. */
  private async openConversation(tx: TenantTx, contactId: string, channelAccountId: string, peerId: string): Promise<{ id: string; created: boolean }> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended((${`conversation:${contactId}:${channelAccountId}`}::text || ':' || app_org()::text), 0))`);
    const [open] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.contactId, contactId), eq(conversations.channelAccountId, channelAccountId), ne(conversations.status, 'closed')))
      .limit(1);
    if (open) return { id: open.id, created: false };
    const [c] = await tx.insert(conversations).values({ contactId, channelAccountId, peerId }).returning({ id: conversations.id });
    await writeAudit(tx, { entityType: 'conversation', entityId: c!.id, newValue: { contact_id: contactId, channel_account_id: channelAccountId, status: 'unassigned' }, source: 'meta' });
    return { id: c!.id, created: true };
  }
}
