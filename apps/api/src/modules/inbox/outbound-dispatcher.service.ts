import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { channelAccounts, contactPhones, conversations, Database, messageAttachments, messages, whatsappAccounts } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { ChannelVault, isRetryableError, WHATSAPP_PROVIDER, WhatsAppProviderError, type MediaKind, type TemplateSendComponent, type WhatsAppErrorCode, type WhatsAppProvider } from '../channels';
import { AttachmentsService } from '../attachments';
import { RealtimeService } from '../realtime';

/** Mientras un envío está en curso el mensaje queda «reservado» este tiempo: si el proceso muere a mitad, otra pasada lo retoma. Debe superar el tiempo máximo de espera al proveedor. */
export const SEND_LEASE_MS = 60_000;
/** Intentos de envío de un mensaje antes de darlo por fallido. */
export const SEND_MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 10 * 60_000;
/** Mensajes que una pasada de la tarea intenta enviar por empresa. */
export const SEND_BATCH = 20;

/** Espera antes del intento siguiente tras fallar el número `attempts`: 15 s, 30 s, 1 min, 2 min… hasta 10 min. */
export const backoffMs = (attempts: number): number => Math.min(15_000 * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);

/** Lo que se le muestra a la persona cuando un mensaje no salió (sin datos del cliente ni del proveedor). */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  invalid_token: 'WhatsApp rechazó la conexión: el administrador debe actualizar el token en Configuración › Conexiones',
  number_not_found: 'La conexión de WhatsApp ya no existe en Meta: el administrador debe revisarla en Configuración › Conexiones',
  unavailable: 'No pudimos entregarlo a WhatsApp tras varios intentos. Inténtalo de nuevo en unos minutos',
  rate_limited: 'WhatsApp limitó los envíos de este número tras varios intentos. Inténtalo de nuevo en unos minutos',
  window_closed: 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se puede escribirle con una plantilla aprobada',
  template_unavailable: 'La plantilla ya no está disponible en Meta (pausada, deshabilitada o borrada): sincroniza las plantillas y elige otra',
  template_params: 'Meta no aceptó los datos de la plantilla: revisa las variables e inténtalo de nuevo',
  recipient_invalid: 'WhatsApp no pudo entregar el mensaje a este número. Revisa que sea correcto y que tenga WhatsApp',
  rejected: 'WhatsApp rechazó el mensaje',
  media_rejected: 'WhatsApp no aceptó el archivo',
  media_unavailable: 'El archivo ya no está disponible',
  channel_off: 'La conexión de WhatsApp está desactivada o desconectada. Actívala y vuelve a intentar',
  credentials: 'No se pueden leer las credenciales de la conexión: el administrador debe volver a pegar el token',
  no_recipient: 'El contacto no tiene un teléfono al cual escribir',
  template_data: 'Faltan los datos de la plantilla: vuelve a elegirla y enviarla',
  attachment_data: 'Faltan los datos del archivo: súbelo de nuevo e inténtalo',
  storage_unavailable: 'No pudimos leer el archivo del almacenamiento: inténtalo de nuevo en unos minutos',
};
const CHANNEL_OFF = 'La conexión de WhatsApp está desactivada o desconectada. Actívala y vuelve a intentar';
const CREDENTIALS_UNREADABLE = 'No se pueden leer las credenciales de la conexión: el administrador debe volver a pegar el token';
const NO_RECIPIENT = 'El contacto no tiene un teléfono al cual escribir';
const TEMPLATE_DATA = 'Faltan los datos de la plantilla: vuelve a elegirla y enviarla';
const ATTACHMENT_DATA = 'Faltan los datos del archivo: súbelo de nuevo e inténtalo';
const STORAGE_UNAVAILABLE = 'No pudimos leer el archivo del almacenamiento: inténtalo de nuevo en unos minutos';

export type DispatchResult =
  /** Salió: el mensaje quedó `sent` con el identificador del proveedor. */
  | { outcome: 'sent' }
  /** Falló de forma pasajera y volverá a intentarse más tarde. */
  | { outcome: 'retry'; code: string }
  /** Falló para siempre: quedó `failed` con su explicación. */
  | { outcome: 'failed'; code: string }
  /** No estaba pendiente, no le tocaba aún, hay un mensaje anterior de la conversación sin salir, o lo tomó otra instancia. */
  | { outcome: 'skipped' };

interface SendPlan {
  messageId: string;
  channelAccountId: string;
  attempts: number;
  text: string;
  to: string;
  phoneNumberId: string;
  accessToken: string;
  /** Si es una plantilla: lo que se manda en vez del texto. */
  template: { name: string; language: string; components: readonly TemplateSendComponent[] } | null;
  /** Si es un adjunto: el archivo que se sube al proveedor y luego el mensaje que lo referencia. */
  media: { kind: MediaKind; mimeType: string; filename: string | null; bytes: Buffer; caption: string | null } | null;
}

/**
 * Envío de los mensajes en cola por el proveedor de WhatsApp (M5.4, ADR-50). Es «al menos una vez»:
 *  1. RESERVA el mensaje en una transacción (`UPDATE … WHERE status='queued' AND next_attempt_at <= ahora`, que solo gana una instancia) y le suma un intento;
 *  2. llama al proveedor FUERA de toda transacción (nunca se retiene una conexión de la base mientras se espera a la red);
 *  3. anota el resultado en otra transacción: `sent` con el id del proveedor, reintento con espera creciente (solo si el fallo fue pasajero) o `failed`.
 * Un mensaje no sale antes que otro anterior de su misma conversación que siga en cola: el cliente los lee en el orden en que se escribieron.
 * Riesgo residual documentado: si el proceso muere —o falla la base— justo después de que el proveedor aceptó el mensaje y antes de anotarlo, otra pasada lo reenvía
 * al vencer la reserva (un mensaje repetido es preferible a uno perdido). Corre dentro del TenantContext que pone quien llama (una petición o la tarea periódica).
 * Nunca registra el texto, el teléfono ni el token.
 */
@Injectable()
export class OutboundDispatcher {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ChannelVault) private readonly vault: ChannelVault,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Optional() @Inject(RealtimeService) private readonly realtime?: RealtimeService,
  ) {}

  /** Intenta enviar UN mensaje ahora (si está pendiente y le toca). No lanza por un fallo del proveedor: lo anota en el mensaje. */
  async dispatchOne(messageId: string, now: Date = new Date()): Promise<DispatchResult> {
    const result = await this.attempt(messageId, now);
    if (result.outcome === 'sent' || result.outcome === 'failed') await this.announce(messageId);
    return result;
  }

  /** Avisa en tiempo real que el mensaje salió o falló (lo que ve la persona cambia: ✓ o «no se envió»). Nunca rompe el envío. */
  private async announce(messageId: string): Promise<void> {
    if (!this.realtime) return;
    try {
      const [m] = await this.db.withTenant((tx) => tx.select({ conversationId: messages.conversationId }).from(messages).where(eq(messages.id, messageId)).limit(1));
      if (m) this.realtime.touchHere(m.conversationId, { message: { id: messageId, kind: 'updated' } });
    } catch {
      // el aviso es opcional
    }
  }

  private async attempt(messageId: string, now: Date): Promise<DispatchResult> {
    const claimed = await this.claim(messageId, now);
    if (claimed.kind === 'skipped') return { outcome: 'skipped' };
    if (claimed.kind === 'failed') return { outcome: 'failed', code: claimed.code };
    const plan = claimed.plan;

    let sentId: string | null = null;
    let code: string | null = null;
    try {
      const credentials = { accessToken: plan.accessToken };
      if (plan.media) {
        sentId = (await this.provider.sendMedia(credentials, plan.phoneNumberId, { to: plan.to, kind: plan.media.kind, bytes: plan.media.bytes, mimeType: plan.media.mimeType, filename: plan.media.filename, caption: plan.media.caption })).externalId;
      } else {
        sentId = (plan.template ? await this.provider.sendTemplate(credentials, plan.phoneNumberId, { to: plan.to, name: plan.template.name, language: plan.template.language, components: plan.template.components }) : await this.provider.sendText(credentials, plan.phoneNumberId, { to: plan.to, text: plan.text })).externalId;
      }
    } catch (e) {
      if (e instanceof WhatsAppProviderError) code = e.code;
      else code = 'unavailable';
      this.log.warn({ message_id: plan.messageId, attempts: plan.attempts, code }, 'envío de WhatsApp no salió');
    }

    const done = new Date();
    if (sentId !== null) {
      await this.db.withTenant((tx) => tx.update(messages).set({ status: 'sent', externalId: sentId, nextAttemptAt: null, error: null }).where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued'))));
      return { outcome: 'sent' };
    }
    const failure = code ?? 'unavailable';
    if (failure !== 'attachment_data' && failure !== 'storage_unavailable' && isRetryableError(failure as WhatsAppErrorCode) && plan.attempts < SEND_MAX_ATTEMPTS) {
      await this.db.withTenant((tx) => tx.update(messages).set({ nextAttemptAt: new Date(done.getTime() + backoffMs(plan.attempts)) }).where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued'))));
      return { outcome: 'retry', code: failure };
    }
    await this.db.withTenant(async (tx) => {
      await tx
        .update(messages)
        .set({ status: 'failed', nextAttemptAt: null, error: (ERROR_TEXT as Record<string, string>)[failure] ?? (ERROR_TEXT as Record<string, string>).rejected!, meta: sql`${messages.meta} || ${JSON.stringify({ error_code: failure })}::jsonb` })
        .where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued')));
      // Un token rechazado o un número que ya no existe es un problema de la CONEXIÓN: queda visible donde el administrador la revisa
      if (failure === 'invalid_token' || failure === 'number_not_found') {
        const text = failure === 'invalid_token' ? 'WhatsApp rechazó el token al enviar un mensaje: genera uno nuevo y pégalo' : 'WhatsApp no encontró este número al enviar un mensaje';
        await tx.update(whatsappAccounts).set({ lastError: text, lastCheckAt: done, updatedAt: done }).where(eq(whatsappAccounts.channelAccountId, plan.channelAccountId));
      }
    });
    return { outcome: 'failed', code: failure };
  }

  /**
   * Pasada de la tarea periódica: los mensajes de la empresa del contexto que ya les toca. Si una conexión falla de forma pasajera, el resto de sus mensajes
   * se deja para la pasada siguiente (no tiene sentido insistir con un proveedor caído). Devuelve cuántos mensajes tocó.
   */
  async runDue(now: Date, batch = SEND_BATCH): Promise<number> {
    const due = await this.db.withTenant((tx) =>
      tx
        .select({ id: messages.id, channelAccountId: messages.channelAccountId })
        .from(messages)
        .where(and(eq(messages.status, 'queued'), eq(messages.direction, 'out'), lte(messages.nextAttemptAt, now)))
        .orderBy(asc(messages.nextAttemptAt), asc(messages.id))
        .limit(batch),
    );
    const paused = new Set<string>();
    let touched = 0;
    for (const m of due) {
      if (paused.has(m.channelAccountId)) continue;
      const r = await this.dispatchOne(m.id, now);
      if (r.outcome === 'skipped') continue;
      touched += 1;
      if (r.outcome === 'retry') paused.add(m.channelAccountId);
    }
    return touched;
  }

  /** Reserva el mensaje y reúne lo necesario para enviarlo; si no se puede enviar por algo local (conexión apagada, sin teléfono…), lo deja `failed` aquí mismo. */
  private async claim(messageId: string, now: Date): Promise<{ kind: 'skipped' } | { kind: 'failed'; code: string } | { kind: 'plan'; plan: SendPlan }> {
    const result = await this.db.withTenant(async (tx) => {
      const rows = await tx
        .update(messages)
        .set({ nextAttemptAt: new Date(now.getTime() + SEND_LEASE_MS), attempts: sql`${messages.attempts} + 1` })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.status, 'queued'),
            eq(messages.direction, 'out'),
            sql`${messages.kind} <> 'note'`,
            lte(messages.nextAttemptAt, now),
            // El orden de escritura se respeta: no sale antes que otro mensaje anterior de su conversación que siga en cola
            sql`NOT EXISTS (SELECT 1 FROM messages o WHERE o.organization_id = ${messages.organizationId} AND o.conversation_id = ${messages.conversationId} AND o.direction = 'out' AND o.status = 'queued' AND (o.sent_at, o.id) < (${messages.sentAt}, ${messages.id}))`,
          ),
        )
        .returning({ id: messages.id, conversationId: messages.conversationId, channelAccountId: messages.channelAccountId, body: messages.body, attempts: messages.attempts, kind: messages.kind, meta: messages.meta });
      const m = rows[0];
      if (!m) return { kind: 'skipped' as const };

      const [ctx] = await tx
        .select({
          peerId: conversations.peerId,
          contactId: conversations.contactId,
          channelStatus: channelAccounts.status,
          channelDeletedAt: channelAccounts.deletedAt,
          sealed: channelAccounts.credentialsSealed,
          phoneNumberId: whatsappAccounts.phoneNumberId,
          numberActive: whatsappAccounts.active,
        })
        .from(conversations)
        .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId)))
        .leftJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id)))
        .where(eq(conversations.id, m.conversationId))
        .limit(1);

      const fail = async (code: 'channel_off' | 'credentials' | 'no_recipient' | 'template_data' | 'attachment_data', text: string) => {
        await tx.update(messages).set({ status: 'failed', nextAttemptAt: null, error: text, meta: sql`${messages.meta} || ${JSON.stringify({ error_code: code })}::jsonb` }).where(eq(messages.id, m.id));
        return { kind: 'failed' as const, code };
      };

      if (!ctx || ctx.channelDeletedAt !== null || ctx.channelStatus !== 'active' || !ctx.numberActive || ctx.phoneNumberId === null) return fail('channel_off', CHANNEL_OFF);
      const secrets = ctx.sealed ? this.vault.open(m.channelAccountId, ctx.sealed) : null;
      const accessToken = secrets?.['access_token'];
      if (!accessToken) return fail('credentials', CREDENTIALS_UNREADABLE);

      let to: string | null = ctx.peerId;
      if (!to) {
        const [p] = await tx.select({ e164: contactPhones.e164 }).from(contactPhones).where(and(eq(contactPhones.contactId, ctx.contactId), isNull(contactPhones.deletedAt), eq(contactPhones.isPrimary, true))).limit(1);
        to = p ? p.e164.replace(/^\+/, '') : null;
      }
      const isMedia = m.kind === 'image' || m.kind === 'video' || m.kind === 'audio' || m.kind === 'document' || m.kind === 'sticker';
      if (!to || (!isMedia && m.body === null)) return fail('no_recipient', NO_RECIPIENT);
      let template: SendPlan['template'] = null;
      if (m.kind === 'template') {
        const t = m.meta['template'] as { name?: unknown; language?: unknown; send?: unknown } | undefined;
        if (!t || typeof t.name !== 'string' || typeof t.language !== 'string' || !Array.isArray(t.send)) return fail('template_data', TEMPLATE_DATA);
        template = { name: t.name, language: t.language, components: t.send as TemplateSendComponent[] };
      }
      // Adjunto: resolver su archivo (la lectura del storage va FUERA de la transacción, abajo)
      let attInfo: { storageKey: string; mimeType: string; filename: string | null; kind: MediaKind } | null = null;
      if (isMedia) {
        const [att] = await tx.select({ storageKey: messageAttachments.storageKey, mimeType: messageAttachments.mimeType, filename: messageAttachments.filename, kind: messageAttachments.kind, state: messageAttachments.state, scanStatus: messageAttachments.scanStatus }).from(messageAttachments).where(and(eq(messageAttachments.messageId, m.id), eq(messageAttachments.direction, 'out'))).limit(1);
        if (!att || att.state !== 'ready' || !att.storageKey) return fail('attachment_data', ATTACHMENT_DATA);
        attInfo = { storageKey: att.storageKey, mimeType: att.mimeType, filename: att.filename, kind: att.kind as MediaKind };
      }
      return { kind: 'plan' as const, plan: { messageId: m.id, channelAccountId: m.channelAccountId, attempts: m.attempts, text: m.body ?? '', to, phoneNumberId: ctx.phoneNumberId, accessToken, template, attInfo } as unknown as SendPlan & { attInfo: typeof attInfo } };
    });
    if (result.kind !== 'plan') return result;
    const plan = result.plan;
    if (plan.attInfo) {
      let mediaBytes: Buffer;
      const mediaInfo = { kind: plan.attInfo.kind, mimeType: plan.attInfo.mimeType, filename: plan.attInfo.filename, caption: plan.text || null };
      try {
        mediaBytes = await this.files.read(plan.attInfo.storageKey);
      } catch {
        await this.db.withTenant((tx) => tx.update(messages).set({ status: 'failed', nextAttemptAt: null, error: STORAGE_UNAVAILABLE, meta: sql`${messages.meta} || ${JSON.stringify({ error_code: 'storage_unavailable' })}::jsonb` }).where(eq(messages.id, plan.messageId)));
        return { kind: 'failed', code: 'storage_unavailable' as const };
      }
      // caption solo para imagen/video/documento; audio/sticker no llevan
      const captionable = mediaInfo.kind === 'image' || mediaInfo.kind === 'video' || mediaInfo.kind === 'document';
      return { kind: 'plan' as const, plan: { messageId: plan.messageId, channelAccountId: plan.channelAccountId, attempts: plan.attempts, text: plan.text, to: plan.to, phoneNumberId: plan.phoneNumberId, accessToken: plan.accessToken, template: null, media: { kind: mediaInfo.kind, mimeType: mediaInfo.mimeType, filename: mediaInfo.filename, bytes: mediaBytes, caption: captionable ? mediaInfo.caption : null } } };
    }
    return { kind: 'plan' as const, plan: { messageId: plan.messageId, channelAccountId: plan.channelAccountId, attempts: plan.attempts, text: plan.text, to: plan.to, phoneNumberId: plan.phoneNumberId, accessToken: plan.accessToken, template: plan.template, media: null } };
  }
}
