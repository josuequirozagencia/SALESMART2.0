import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { channelAccounts, contacts, conversations, messages, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { writeAudit } from '../audit';
import { ConversationsService } from '../conversations';
import { RealtimeService } from '../realtime';
import { renderedText, TemplatesService } from '../templates';

/** Cuánto dura la ventana de atención de WhatsApp tras el último mensaje del cliente. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TemplateOutreach {
  readonly contactId: string;
  /** Teléfono en E.164. */
  readonly phone: string;
  readonly channelId: string;
  readonly templateId: string;
  /** Valores de las variables, ya resueltos (por clave: `body:1`, `body:nombre`, `button:0:1`…). */
  readonly params: Readonly<Record<string, string>>;
  /** Cola con la que nace la conversación si no existía; sin ella, la de la conexión. */
  readonly queueId: string | null;
  /** Responsable del lead: si la conversación nace aquí queda «pendiente» para esa persona; sin él, «sin asignar». */
  readonly ownerId: string | null;
  readonly now: Date;
}

export type OutreachOutcome = { sent: true; conversationId: string } | { sent: false; reason: 'revoked' | 'channel_unavailable' | 'template_unavailable' };

/**
 * Mensajes automáticos que nacen de una regla del sistema (formularios, M9.2; automatizaciones, M9.3), no de una persona: quedan en cola como `sender_type = automation` y los envía la misma tarea de
 * siempre. NO cuentan como respuesta humana (no detienen el SLA ni mueven la conversación). Corre DENTRO de la transacción de quien llama. Un motivo previsible por el que no se puede enviar
 * NO es un error: devuelve `sent: false` con la causa y quien llama decide (el formulario deja una tarea; la automatización registra el paso como omitido).
 */
@Injectable()
export class OutreachService {
  constructor(
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(ConversationsService) private readonly conversationsSvc: ConversationsService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** Deja una plantilla de WhatsApp en cola para el contacto, abriendo la conversación si no hay una. */
  async sendTemplate(tx: TenantTx, i: TemplateOutreach): Promise<OutreachOutcome> {
    const [c] = await tx.select({ consent: contacts.consent }).from(contacts).where(and(eq(contacts.id, i.contactId), isNull(contacts.deletedAt))).limit(1);
    if (!c || c.consent === 'revoked') return { sent: false, reason: 'revoked' };
    const [ch] = await tx
      .select({ id: channelAccounts.id, queueId: channelAccounts.queueId })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.id, i.channelId), isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'), eq(channelAccounts.provider, 'meta_cloud')))
      .limit(1);
    if (!ch) return { sent: false, reason: 'channel_unavailable' };
    let prepared;
    let row;
    try {
      row = await this.templates.getSendable(tx, i.channelId, i.templateId);
      prepared = this.templates.prepare(row, { ...i.params });
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof ConflictError || e instanceof ValidationError) return { sent: false, reason: 'template_unavailable' }; // plantilla borrada, ya no aprobada o con valores que Meta rechazaría
      throw e;
    }
    const conv = await this.conversationsSvc.openFor(tx, i.contactId, i.channelId, i.phone.replace(/\D/g, ''), 'api');
    if (conv.created) {
      // La conversación nace asignada al responsable del lead (pendiente de aceptar); sin responsable, sin asignar. No hay mensaje del cliente: ni cronómetro de respuesta
      await tx
        .update(conversations)
        .set({ queueId: i.queueId ?? ch.queueId, ...(i.ownerId ? { ownerId: i.ownerId, assignedAt: i.now, assignmentSource: 'distribution', status: 'pending' } : {}), updatedAt: i.now })
        .where(eq(conversations.id, conv.id));
      if (i.ownerId) await writeAudit(tx, { entityType: 'conversation', entityId: conv.id, field: 'owner_id', oldValue: null, newValue: i.ownerId, source: 'api' });
    }
    const template = { id: row.id, name: row.name, language: row.language, category: row.category, buttons: prepared.rendered.buttons, send: prepared.send };
    const m = await this.queue(tx, conv.id, i.channelId, 'template', renderedText(prepared.rendered), { template }, i.now);
    this.realtime.touchHere(conv.id, { ...(conv.created ? { created: true } : {}), message: { id: m, kind: 'created' } });
    return { sent: true, conversationId: conv.id };
  }

  /**
   * Un texto libre automático en la conversación ABIERTA más reciente del contacto, solo dentro de la ventana de 24 h de WhatsApp (en un canal sin ventana, como GoHighLevel, siempre). Nunca abre una
   * conversación: sin conversación abierta o con la ventana cerrada no hay a quién ni cómo escribirle, y devuelve el motivo.
   */
  async sendText(tx: TenantTx, i: { contactId: string; text: string; now: Date }): Promise<{ sent: true; conversationId: string } | { sent: false; reason: 'revoked' | 'no_conversation' | 'window_closed' | 'channel_unavailable' }> {
    const [c] = await tx.select({ consent: contacts.consent }).from(contacts).where(and(eq(contacts.id, i.contactId), isNull(contacts.deletedAt))).limit(1);
    if (!c || c.consent === 'revoked') return { sent: false, reason: 'revoked' };
    const [conv] = await tx
      .select({ id: conversations.id, channelId: conversations.channelAccountId, lastInboundAt: conversations.lastInboundAt, provider: channelAccounts.provider, state: channelAccounts.status })
      .from(conversations)
      .innerJoin(channelAccounts, and(eq(channelAccounts.id, conversations.channelAccountId), isNull(channelAccounts.deletedAt)))
      .where(and(eq(conversations.contactId, i.contactId), sql`${conversations.status} <> 'closed'`))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
      .limit(1)
      .for('update', { of: conversations });
    if (!conv) return { sent: false, reason: 'no_conversation' };
    if (conv.state !== 'active') return { sent: false, reason: 'channel_unavailable' };
    if (conv.provider !== 'ghl' && (!conv.lastInboundAt || i.now.getTime() - conv.lastInboundAt.getTime() >= WINDOW_MS)) return { sent: false, reason: 'window_closed' };
    const m = await this.queue(tx, conv.id, conv.channelId, 'text', i.text, {}, i.now);
    this.realtime.touchHere(conv.id, { message: { id: m, kind: 'created' } });
    return { sent: true, conversationId: conv.id };
  }

  /** El mensaje de salida automático, en cola; no cambia el estado ni el responsable de la conversación. */
  private async queue(tx: TenantTx, conversationId: string, channelId: string, kind: 'text' | 'template', body: string, meta: Record<string, unknown>, now: Date): Promise<string> {
    const [m] = await tx
      .insert(messages)
      .values({ conversationId, channelAccountId: channelId, direction: 'out', senderType: 'automation', kind, body, meta, status: 'queued', sentAt: now, attempts: 0, nextAttemptAt: now })
      .returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({ lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)`, updatedAt: now })
      .where(eq(conversations.id, conversationId));
    return m!.id;
  }
}
