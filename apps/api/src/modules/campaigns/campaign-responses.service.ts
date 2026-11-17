import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { messages, type TenantTx } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { DomainEventBus, type DomainEvent } from '../events';
import { isOptOutText } from './campaign-optout';

/** «Respondió» (ADR-72 #9): el primer mensaje del contacto dentro de las 72 h posteriores al envío. */
export const REPLY_WINDOW_HOURS = 72;
const REPLY_WINDOW_MS = REPLY_WINDOW_HOURS * 3_600_000;
/** Tipos de mensaje del cliente que pueden traer una petición de baja escrita (o un botón con ese texto). */
const TEXT_KINDS = new Set(['text', 'button', 'interactive']);
/** El aviso que queda en la conversación cuando alguien pide la baja (fijo: sin datos del cliente). */
export const OPT_OUT_NOTE = 'El contacto pidió la baja respondiendo a una campaña. Quedó como «No contactar»: no recibirá más campañas.';

type Recent = { id: string; campaign_id: string; status: string; replied_at: string | null; opted_out_at: string | null; campaign_name: string };

/**
 * Lo que pasa cuando un contacto RESPONDE a una campaña (v17 · 17.5): se anota su respuesta en el destinatario («respondió», dentro de las 72 h) y, si lo que escribió es, entero, una petición de baja
 * («BAJA», «STOP», «no más»…), el contacto pasa a «revocado», se descartan sus envíos pendientes de cualquier campaña y queda una nota interna en la conversación.
 *
 * Escucha el hecho «llegó un mensaje del cliente» y corre DENTRO de la transacción de quien lo recibió, en su propio `SAVEPOINT`: si algo falla aquí se registra y el mensaje del cliente se guarda igual
 * (anotar una respuesta nunca puede impedir que el equipo vea lo que el cliente escribió). Para un contacto que no recibió ninguna campaña en las últimas 72 h cuesta UNA consulta por índice.
 */
@Injectable()
export class CampaignResponsesService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(DomainEventBus) private readonly bus: DomainEventBus,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((tx, event) => this.onEvent(tx, event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async onEvent(tx: TenantTx, event: DomainEvent, now: Date = new Date()): Promise<void> {
    if (event.type !== 'message_received' || !event.messageId) return;
    await tx.execute(sql`SAVEPOINT campaign_response`);
    try {
      await this.record(tx, event, event.messageId, now);
      await tx.execute(sql`RELEASE SAVEPOINT campaign_response`);
    } catch (e) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT campaign_response`);
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido', conversation_id: event.conversationId }, 'no se pudo anotar la respuesta a una campaña (el mensaje del cliente se guardó igual)');
    }
  }

  private async record(tx: TenantTx, event: Extract<DomainEvent, { type: 'message_received' }>, messageId: string, now: Date): Promise<void> {
    const since = new Date(now.getTime() - REPLY_WINDOW_MS).toISOString();
    // Los mensajes de campaña que ESTE contacto recibió por ESTA conexión dentro de la ventana (y que de verdad salieron)
    const recent = (
      await tx.execute<Recent>(sql`
        SELECT r.id, r.campaign_id, r.status, r.replied_at, r.opted_out_at, c.name AS campaign_name
          FROM campaign_recipients r
          JOIN messages m ON m.organization_id = r.organization_id AND m.id = r.message_id
          JOIN campaigns c ON c.organization_id = r.organization_id AND c.id = r.campaign_id
         WHERE r.contact_id = ${event.contactId}
           AND r.message_id IS NOT NULL
           AND r.status IN ('queued', 'sent', 'delivered', 'read', 'replied')
           AND m.channel_account_id = ${event.channelId}
           AND m.status IN ('sent', 'delivered', 'read')
           AND m.sent_at IS NOT NULL AND m.sent_at >= ${since}::timestamptz AND m.sent_at <= ${now.toISOString()}::timestamptz`)
    ).rows;
    if (recent.length === 0) return;

    const stamp = now.toISOString();
    // Respondió: cada campaña cuenta la PRIMERA respuesta de ese destinatario (una segunda no cambia nada)
    const fresh = recent.filter((r) => r.replied_at === null);
    if (fresh.length > 0) {
      await tx.execute(sql`
        UPDATE campaign_recipients r SET
          status = 'replied',
          replied_at = ${stamp}::timestamptz,
          sent_at = COALESCE(r.sent_at, m.sent_at),
          delivered_at = COALESCE(r.delivered_at, m.delivered_at),
          read_at = COALESCE(r.read_at, m.read_at),
          updated_at = ${stamp}::timestamptz
        FROM messages m
        WHERE m.organization_id = r.organization_id AND m.id = r.message_id
          AND r.id IN (${sql.join(fresh.map((r) => sql`${r.id}::uuid`), sql`, `)})
          AND r.replied_at IS NULL`);
    }

    // ¿Pidió la baja? Solo si lo que escribió es, entero, una de las frases (ver `campaign-optout.ts`)
    const [msg] = (await tx.execute<{ body: string | null; kind: string }>(sql`SELECT body, kind FROM messages WHERE id = ${messageId}::uuid`)).rows;
    if (!msg || !TEXT_KINDS.has(msg.kind) || !isOptOutText(msg.body)) return;
    await this.optOut(tx, event, recent, now);
  }

  private async optOut(tx: TenantTx, event: Extract<DomainEvent, { type: 'message_received' }>, recent: Recent[], now: Date): Promise<void> {
    const stamp = now.toISOString();
    const changed = await this.contacts.revokeConsent(tx, event.contactId, 'automation');
    // A quién respondió: queda marcado en cada destinatario (sirve para el informe y el CSV)
    await tx.execute(sql`
      UPDATE campaign_recipients SET opted_out_at = ${stamp}::timestamptz, updated_at = ${stamp}::timestamptz
       WHERE id IN (${sql.join(recent.map((r) => sql`${r.id}::uuid`), sql`, `)}) AND opted_out_at IS NULL`);
    // Lo que seguía pendiente para esta persona, en la campaña que sea, ya no sale (el envío además lo vuelve a comprobar)
    await tx.execute(sql`
      UPDATE campaign_recipients SET status = 'skipped', skip_reason = 'revoked', updated_at = ${stamp}::timestamptz
       WHERE contact_id = ${event.contactId}::uuid AND status = 'pending'`);
    for (const id of new Set(recent.filter((r) => r.opted_out_at === null).map((r) => r.campaign_id))) {
      await writeAudit(tx, { entityType: 'campaign', entityId: id, field: 'opt_out', newValue: { contact_id: event.contactId, revoked: changed }, source: 'automation' });
    }
    // Aviso interno en la conversación (una sola vez: si ya estaba revocado no hay nada nuevo que decir)
    if (changed) {
      await tx.insert(messages).values({ conversationId: event.conversationId, channelAccountId: event.channelId, direction: 'out', senderType: 'system', kind: 'note', body: OPT_OUT_NOTE, status: 'internal', sentAt: now });
    }
  }
}
