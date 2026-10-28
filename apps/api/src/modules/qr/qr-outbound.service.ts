import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { channelAccounts, contactPhones, conversations, Database, messageAttachments, messages, qrAccounts } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { AttachmentsService } from '../attachments';
import type { MediaKind } from '../channels';
import { QrConnectionsService } from './qr-connections.service';
import { sendGate } from './qr-limits';
import { isRetryableQr, QR_SESSION, QrSessionError, type QrCredentials, type QrSessionProvider } from './qr-session.port';

/** Mientras un envío está en curso el mensaje queda reservado este tiempo (igual que en el envío oficial). */
const LEASE_MS = 60_000;
/** Intentos que SÍ cuentan (fallos del servidor de WhatsApp por QR); esperar una sesión caída o un límite no cuenta. */
const MAX_ATTEMPTS = 5;
/** Un mensaje que espera una sesión caída o un límite más de esto se da por fallido (no se queda para siempre ni sale días después). */
const MAX_WAIT_MS = 24 * 60 * 60_000;
const SESSION_RETRY_MS = 60_000;
const backoff = (attempts: number): number => Math.min(15_000 * 2 ** Math.max(attempts - 1, 0), 10 * 60_000);

const ERROR_TEXT: Readonly<Record<string, string>> = {
  channel_off: 'La conexión de WhatsApp por QR está desactivada o borrada. Actívala y vuelve a intentar',
  no_recipient: 'El contacto no tiene un teléfono al cual escribir',
  qr_unsupported: 'Por WhatsApp por QR no se pueden enviar plantillas ni stickers',
  attachment_data: 'Faltan los datos del archivo: súbelo de nuevo e inténtalo',
  storage_unavailable: 'No pudimos leer el archivo del almacenamiento: inténtalo de nuevo en unos minutos',
  qr_session_down: 'La sesión de WhatsApp por QR estuvo caída más de 24 horas: vuelve a escanear el QR y envía el mensaje otra vez',
  qr_limit: 'No se pudo enviar dentro del límite diario de la conexión por QR (se está calentando el número): inténtalo mañana',
  qr_not_configured: 'WhatsApp por QR no está configurado en la plataforma',
  unavailable: 'No pudimos entregarlo a WhatsApp tras varios intentos. Inténtalo de nuevo en unos minutos',
  rate_limited: 'WhatsApp limitó los envíos de este número tras varios intentos. Inténtalo de nuevo en unos minutos',
  recipient_invalid: 'WhatsApp no pudo entregar el mensaje a este número. Revisa que sea correcto y que tenga WhatsApp',
  rejected: 'WhatsApp rechazó el mensaje',
  not_found: 'La sesión de WhatsApp por QR ya no existe: vuelve a crear la conexión',
  not_configured: 'El servidor de WhatsApp por QR rechazó la clave de la plataforma: avisa al administrador de la plataforma',
};

export type QrDispatch = { outcome: 'sent' } | { outcome: 'retry'; code: string } | { outcome: 'failed'; code: string } | { outcome: 'skipped' };

interface Plan {
  messageId: string;
  attempts: number;
  instance: string;
  to: string;
  text: string;
  sentAt: Date;
  attachment: { storageKey: string; mimeType: string; filename: string | null; kind: MediaKind } | null;
}

/**
 * Envío de los mensajes en cola por una sesión de WhatsApp por QR (M9.6, ADR-54/ADR-31). Mismo contrato que el envío oficial —«al menos una vez», un mensaje no sale antes que otro anterior de su
 * conversación, el proveedor se llama FUERA de toda transacción, nunca se registra el texto, el teléfono ni la clave— con tres diferencias propias del canal no oficial:
 *  1. **Sesión caída**: el mensaje NO falla ni gasta intentos; espera (cada minuto) a que se vuelva a escanear el QR, y solo pasadas 24 h se da por fallido. Nunca se reenvía por otra vía.
 *  2. **Calentamiento y pausa mínima** entre mensajes ({@link sendGate}): lo que excede el límite del día espera.
 *  3. Sin plantillas ni stickers; los archivos salen en base64 por Evolution.
 */
@Injectable()
export class QrOutboundService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QR_SESSION) private readonly provider: QrSessionProvider,
    @Inject(QrConnectionsService) private readonly connections: QrConnectionsService,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async attempt(messageId: string, now: Date): Promise<QrDispatch> {
    const claimed = await this.claim(messageId, now);
    if (claimed.kind !== 'plan') return claimed.kind === 'skipped' ? { outcome: 'skipped' } : claimed.kind === 'wait' ? { outcome: 'retry', code: claimed.code } : { outcome: 'failed', code: claimed.code };
    const plan = claimed.plan;

    const creds = await this.connections.credentials();
    if (!creds) return this.defer(plan, now, 'qr_not_configured', SESSION_RETRY_MS);
    let bytes: Buffer | null = null;
    if (plan.attachment) {
      try {
        bytes = await this.files.read(plan.attachment.storageKey);
      } catch {
        return this.fail(plan.messageId, 'storage_unavailable');
      }
    }
    try {
      const sent = plan.attachment && bytes ? await this.provider.sendMedia(creds, plan.instance, { to: plan.to, kind: plan.attachment.kind, bytes, mimeType: plan.attachment.mimeType, filename: plan.attachment.filename, caption: plan.text || null }) : await this.provider.sendText(creds, plan.instance, { to: plan.to, text: plan.text });
      await this.db.withTenant((tx) => tx.update(messages).set({ status: 'sent', externalId: sent.externalId, nextAttemptAt: null, error: null }).where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued'))));
      return { outcome: 'sent' };
    } catch (e) {
      return this.onError(e, plan, creds, now);
    }
  }

  private async onError(e: unknown, plan: Plan, creds: QrCredentials, now: Date): Promise<QrDispatch> {
    const code = e instanceof QrSessionError ? e.code : 'unavailable';
    this.log.warn({ message_id: plan.messageId, attempts: plan.attempts, code }, 'envío por WhatsApp por QR no salió');
    if (code === 'session_down') {
      // Evolution dice que la sesión no está abierta: se anota ya (sin esperar al latido) y el mensaje espera
      await this.markDown(plan.instance, creds).catch(() => undefined);
      return this.defer(plan, now, 'session_down', SESSION_RETRY_MS);
    }
    if (e instanceof QrSessionError && isRetryableQr(e.code) && plan.attempts < MAX_ATTEMPTS) {
      await this.db.withTenant((tx) => tx.update(messages).set({ nextAttemptAt: new Date(now.getTime() + backoff(plan.attempts)) }).where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued'))));
      return { outcome: 'retry', code };
    }
    return this.fail(plan.messageId, ERROR_TEXT[code] ? code : 'rejected');
  }

  /** La sesión no está abierta: se anota en la conexión para que se vea en la pantalla sin esperar al latido. */
  private async markDown(instance: string, _creds: QrCredentials): Promise<void> {
    await this.db.withTenant(async (tx) => {
      const [q] = await tx.select({ channelAccountId: qrAccounts.channelAccountId }).from(qrAccounts).where(eq(qrAccounts.instanceName, instance)).limit(1);
      if (q) await this.connections.applyState(tx, q.channelAccountId, { state: 'closed', reason: null, phone: null, profileName: null });
    });
  }

  /** El mensaje espera (sesión caída, límite del día, plataforma sin configurar): NO gasta intentos; solo pasadas 24 h se da por fallido. */
  private async defer(plan: Plan, now: Date, code: string, afterMs: number): Promise<QrDispatch> {
    if (now.getTime() - plan.sentAt.getTime() > MAX_WAIT_MS) return this.fail(plan.messageId, code === 'session_down' ? 'qr_session_down' : code === 'qr_not_configured' ? 'qr_not_configured' : 'qr_limit');
    await this.db.withTenant((tx) =>
      tx
        .update(messages)
        .set({ attempts: sql`GREATEST(${messages.attempts} - 1, 0)`, nextAttemptAt: new Date(now.getTime() + afterMs) })
        .where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued'))),
    );
    return { outcome: 'retry', code };
  }

  private async fail(messageId: string, code: string): Promise<QrDispatch> {
    await this.db.withTenant((tx) =>
      tx
        .update(messages)
        .set({ status: 'failed', nextAttemptAt: null, error: ERROR_TEXT[code] ?? ERROR_TEXT['rejected']!, meta: sql`${messages.meta} || ${JSON.stringify({ error_code: code })}::jsonb` })
        .where(and(eq(messages.id, messageId), eq(messages.status, 'queued'))),
    );
    return { outcome: 'failed', code };
  }

  /** Reserva el mensaje y reúne lo necesario; decide aquí lo local (conexión apagada, sin teléfono, sesión caída, límite del día). */
  private async claim(messageId: string, now: Date): Promise<{ kind: 'skipped' } | { kind: 'failed'; code: string } | { kind: 'wait'; code: string } | { kind: 'plan'; plan: Plan }> {
    return this.db.withTenant(async (tx) => {
      const rows = await tx
        .update(messages)
        .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS), attempts: sql`${messages.attempts} + 1` })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.status, 'queued'),
            eq(messages.direction, 'out'),
            sql`${messages.kind} <> 'note'`,
            sql`${messages.nextAttemptAt} <= ${now.toISOString()}::timestamptz`,
            // El orden de escritura se respeta: no sale antes que otro mensaje anterior de su conversación que siga en cola
            sql`NOT EXISTS (SELECT 1 FROM messages o WHERE o.organization_id = ${messages.organizationId} AND o.conversation_id = ${messages.conversationId} AND o.direction = 'out' AND o.status = 'queued' AND (o.sent_at, o.id) < (${messages.sentAt}, ${messages.id}) AND o.kind <> 'note')`,
          ),
        )
        .returning({ id: messages.id, conversationId: messages.conversationId, channelAccountId: messages.channelAccountId, body: messages.body, attempts: messages.attempts, kind: messages.kind, sentAt: messages.sentAt });
      const m = rows[0];
      if (!m) return { kind: 'skipped' as const };

      const [ctx] = await tx
        .select({
          peerId: conversations.peerId,
          contactId: conversations.contactId,
          status: channelAccounts.status,
          deletedAt: channelAccounts.deletedAt,
          instance: qrAccounts.instanceName,
          state: qrAccounts.state,
          firstConnectedAt: qrAccounts.firstConnectedAt,
        })
        .from(conversations)
        .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId)))
        .leftJoin(qrAccounts, and(eq(qrAccounts.organizationId, channelAccounts.organizationId), eq(qrAccounts.channelAccountId, channelAccounts.id)))
        .where(eq(conversations.id, m.conversationId))
        .limit(1);

      const failLocal = async (code: string) => {
        await tx.update(messages).set({ status: 'failed', nextAttemptAt: null, error: ERROR_TEXT[code] ?? ERROR_TEXT['rejected']!, meta: sql`${messages.meta} || ${JSON.stringify({ error_code: code })}::jsonb` }).where(eq(messages.id, m.id));
        return { kind: 'failed' as const, code };
      };
      const waitLocal = async (code: string, afterMs: number) => {
        if (now.getTime() - m.sentAt.getTime() > MAX_WAIT_MS) return failLocal(code === 'session_down' ? 'qr_session_down' : 'qr_limit');
        await tx.update(messages).set({ attempts: sql`GREATEST(${messages.attempts} - 1, 0)`, nextAttemptAt: new Date(now.getTime() + afterMs) }).where(eq(messages.id, m.id));
        return { kind: 'wait' as const, code };
      };

      if (!ctx || ctx.deletedAt !== null || ctx.status !== 'active' || !ctx.instance) return failLocal('channel_off');
      if (m.kind === 'template' || m.kind === 'sticker') return failLocal('qr_unsupported');
      let to = String(ctx.peerId ?? '').replace(/@.*$/, '').replace(/:\d+$/, '').replace(/\D/g, '');
      if (to === '') {
        const [p] = await tx.select({ e164: contactPhones.e164 }).from(contactPhones).where(and(eq(contactPhones.contactId, ctx.contactId), isNull(contactPhones.deletedAt), eq(contactPhones.isPrimary, true))).limit(1);
        to = p ? p.e164.replace(/^\+/, '') : '';
      }
      const isMedia = m.kind === 'image' || m.kind === 'video' || m.kind === 'audio' || m.kind === 'document';
      if (to === '' || (!isMedia && m.body === null)) return failLocal('no_recipient');
      let attachment: Plan['attachment'] = null;
      if (isMedia) {
        const [att] = await tx.select({ storageKey: messageAttachments.storageKey, mimeType: messageAttachments.mimeType, filename: messageAttachments.filename, kind: messageAttachments.kind, state: messageAttachments.state }).from(messageAttachments).where(eq(messageAttachments.messageId, m.id)).limit(1);
        if (!att || att.state !== 'ready' || !att.storageKey) return failLocal('attachment_data');
        attachment = { storageKey: att.storageKey, mimeType: att.mimeType, filename: att.filename, kind: att.kind as MediaKind };
      }
      // La sesión debe estar abierta; si no, el mensaje ESPERA (no falla, no gasta intentos)
      if (ctx.state !== 'open') return waitLocal('session_down', SESSION_RETRY_MS);
      // Calentamiento y pausa mínima: cuántos mensajes salieron ya por esta sesión en las últimas 24 h y cuándo fue el último
      const since = new Date(now.getTime() - 24 * 60 * 60_000);
      const [stat] = await tx
        .select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${messages.sentAt})` })
        .from(messages)
        .where(and(eq(messages.channelAccountId, m.channelAccountId), eq(messages.direction, 'out'), inArray(messages.status, ['sent', 'delivered', 'read']), gt(messages.sentAt, since), sql`${messages.id} <> ${m.id}`));
      const gate = sendGate({ sentLast24h: stat?.n ?? 0, lastSentAt: stat?.last ? new Date(stat.last) : null, firstConnectedAt: ctx.firstConnectedAt, now });
      if (!gate.ok) return waitLocal(gate.reason === 'daily' ? 'rate_limited' : 'rate_limited', Math.max(gate.retryAt.getTime() - now.getTime(), 1_000));
      return { kind: 'plan' as const, plan: { messageId: m.id, attempts: m.attempts, instance: ctx.instance, to, text: m.body ?? '', sentAt: m.sentAt, attachment } };
    });
  }
}
