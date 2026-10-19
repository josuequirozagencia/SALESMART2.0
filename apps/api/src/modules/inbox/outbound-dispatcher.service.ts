import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { channelAccounts, contactPhones, conversations, Database, messages, whatsappAccounts } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { ChannelVault, isRetryableError, WHATSAPP_PROVIDER, WhatsAppProviderError, type WhatsAppErrorCode, type WhatsAppProvider } from '../channels';

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
const ERROR_TEXT: Readonly<Record<WhatsAppErrorCode, string>> = {
  invalid_token: 'WhatsApp rechazó la conexión: el administrador debe actualizar el token en Configuración › Conexiones',
  number_not_found: 'La conexión de WhatsApp ya no existe en Meta: el administrador debe revisarla en Configuración › Conexiones',
  unavailable: 'No pudimos entregarlo a WhatsApp tras varios intentos. Inténtalo de nuevo en unos minutos',
  rate_limited: 'WhatsApp limitó los envíos de este número tras varios intentos. Inténtalo de nuevo en unos minutos',
  window_closed: 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se puede escribirle con una plantilla aprobada',
  recipient_invalid: 'WhatsApp no pudo entregar el mensaje a este número. Revisa que sea correcto y que tenga WhatsApp',
  rejected: 'WhatsApp rechazó el mensaje',
};
const CHANNEL_OFF = 'La conexión de WhatsApp está desactivada o desconectada. Actívala y vuelve a intentar';
const CREDENTIALS_UNREADABLE = 'No se pueden leer las credenciales de la conexión: el administrador debe volver a pegar el token';
const NO_RECIPIENT = 'El contacto no tiene un teléfono al cual escribir';

export type DispatchResult =
  /** Salió: el mensaje quedó `sent` con el identificador del proveedor. */
  | { outcome: 'sent' }
  /** Falló de forma pasajera y volverá a intentarse más tarde. */
  | { outcome: 'retry'; code: WhatsAppErrorCode }
  /** Falló para siempre: quedó `failed` con su explicación. */
  | { outcome: 'failed'; code: WhatsAppErrorCode | 'channel_off' | 'credentials' | 'no_recipient' }
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
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Intenta enviar UN mensaje ahora (si está pendiente y le toca). No lanza por un fallo del proveedor: lo anota en el mensaje. */
  async dispatchOne(messageId: string, now: Date = new Date()): Promise<DispatchResult> {
    const claimed = await this.claim(messageId, now);
    if (claimed.kind === 'skipped') return { outcome: 'skipped' };
    if (claimed.kind === 'failed') return { outcome: 'failed', code: claimed.code };
    const plan = claimed.plan;

    let sentId: string | null = null;
    let code: WhatsAppErrorCode | null = null;
    try {
      sentId = (await this.provider.sendText({ accessToken: plan.accessToken }, plan.phoneNumberId, { to: plan.to, text: plan.text })).externalId;
    } catch (e) {
      code = e instanceof WhatsAppProviderError ? e.code : 'unavailable';
      this.log.warn({ message_id: plan.messageId, attempts: plan.attempts, code }, 'envío de WhatsApp no salió');
    }

    const done = new Date();
    if (sentId !== null) {
      await this.db.withTenant((tx) => tx.update(messages).set({ status: 'sent', externalId: sentId, nextAttemptAt: null, error: null }).where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued'))));
      return { outcome: 'sent' };
    }
    const failure = code ?? 'unavailable';
    if (isRetryableError(failure) && plan.attempts < SEND_MAX_ATTEMPTS) {
      await this.db.withTenant((tx) => tx.update(messages).set({ nextAttemptAt: new Date(done.getTime() + backoffMs(plan.attempts)) }).where(and(eq(messages.id, plan.messageId), eq(messages.status, 'queued'))));
      return { outcome: 'retry', code: failure };
    }
    await this.db.withTenant(async (tx) => {
      await tx
        .update(messages)
        .set({ status: 'failed', nextAttemptAt: null, error: ERROR_TEXT[failure], meta: sql`${messages.meta} || ${JSON.stringify({ error_code: failure })}::jsonb` })
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
  private async claim(messageId: string, now: Date): Promise<{ kind: 'skipped' } | { kind: 'failed'; code: 'channel_off' | 'credentials' | 'no_recipient' } | { kind: 'plan'; plan: SendPlan }> {
    return this.db.withTenant(async (tx) => {
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
        .returning({ id: messages.id, conversationId: messages.conversationId, channelAccountId: messages.channelAccountId, body: messages.body, attempts: messages.attempts });
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

      const fail = async (code: 'channel_off' | 'credentials' | 'no_recipient', text: string) => {
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
      if (!to || m.body === null) return fail('no_recipient', NO_RECIPIENT);
      return { kind: 'plan' as const, plan: { messageId: m.id, channelAccountId: m.channelAccountId, attempts: m.attempts, text: m.body, to, phoneNumberId: ctx.phoneNumberId, accessToken } };
    });
  }
}
