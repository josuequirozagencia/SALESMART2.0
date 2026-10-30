import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { channelAccounts, contactPhones, Database, messages, whatsappAccounts } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { ChannelVault, isRetryableError, WHATSAPP_PROVIDER, WhatsAppProviderError, type WhatsAppProvider } from '../channels';
import { RealtimeService } from '../realtime';
import { assertCanReply, assertWindowOpen, hasWindow, loadConversation, scopeOf, type InboxAccess } from './inbox.access';
import type { ReactionDto } from './inbox.dto';

/** Lo que se le muestra a la persona cuando la reacción no salió (sin datos del cliente ni del proveedor). */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  invalid_token: 'WhatsApp rechazó la conexión: el administrador debe actualizar el token en Configuración › Conexiones',
  number_not_found: 'La conexión de WhatsApp ya no existe en Meta: el administrador debe revisarla en Configuración › Conexiones',
  unavailable: 'No pudimos entregarlo a WhatsApp. Inténtalo de nuevo en unos minutos',
  rate_limited: 'WhatsApp limitó los envíos de este número. Inténtalo de nuevo en unos minutos',
  recipient_invalid: 'WhatsApp no pudo entregar la reacción a este número',
  rejected: 'WhatsApp no aceptó la reacción (el mensaje puede tener más de 30 días, haber sido borrado o ser otra reacción)',
};

/**
 * Reaccionar con un emoji a un mensaje del cliente (M5.8). Reglas:
 *  - Solo en WhatsApp oficial, solo a mensajes que el CLIENTE mandó (con el identificador que le dio el proveedor) y solo quien puede responder la conversación, dentro de la
 *    ventana de 24 h (igual que escribir).
 *  - Una reacción NO es un mensaje: no crea ninguno, no mueve la conversación, no cambia el estado de «sin leer» y NO detiene el cronómetro de respuesta (el SLA mide la
 *    primera respuesta escrita; si más adelante se decide que un gesto también cuenta, es un cambio explícito). Se guarda sobre el mensaje reaccionado (`meta.my_reaction`).
 *  - Se llama al proveedor FUERA de toda transacción y la petición SÍ falla si el proveedor falla (no hay cola ni reintentos: es un gesto inmediato; la persona reintenta).
 *  - Un emoji vacío quita la reacción. Quitarla en Meta es lo que menos se ha validado: **sin validar contra Meta real**.
 */
@Injectable()
export class ReactionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ChannelVault) private readonly vault: ChannelVault,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Optional() @Inject(RealtimeService) private readonly realtime?: RealtimeService,
  ) {}

  async react(access: InboxAccess, conversationId: string, messageId: string, dto: ReactionDto): Promise<{ id: string; my_reaction: string | null }> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const emoji = dto.emoji ?? '';
    const now = new Date();

    const plan = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, conversationId);
      assertCanReply(scope, c, channel.state, collab, channel.provider);
      if (!hasWindow(channel.provider)) throw new ConflictError('REACTION_UNSUPPORTED', 'Por este canal no se puede reaccionar a los mensajes');
      assertWindowOpen(c.lastInboundAt, now);
      // 404 uniforme: un mensaje de otra conversación, propio, una nota o sin identificador del proveedor no se distingue de uno que no existe
      const [m] = await tx
        .select({ id: messages.id, externalId: messages.externalId })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.direction, 'in')))
        .limit(1);
      if (!m || !m.externalId) throw new NotFoundError();
      const [ctx] = await tx
        .select({ sealed: channelAccounts.credentialsSealed, phoneNumberId: whatsappAccounts.phoneNumberId, numberActive: whatsappAccounts.active })
        .from(channelAccounts)
        .leftJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id)))
        .where(eq(channelAccounts.id, c.channelAccountId))
        .limit(1);
      if (!ctx || !ctx.numberActive || ctx.phoneNumberId === null) throw new ConflictError('CHANNEL_DISABLED', 'La conexión de WhatsApp está desactivada o desconectada');
      const accessToken = ctx.sealed ? this.vault.open(c.channelAccountId, ctx.sealed)?.['access_token'] : undefined;
      if (!accessToken) throw new ConflictError('CHANNEL_CREDENTIALS', 'No se pueden leer las credenciales de la conexión: el administrador debe volver a pegar el token');
      let to: string | null = c.peerId;
      if (!to) {
        const [p] = await tx.select({ e164: contactPhones.e164 }).from(contactPhones).where(and(eq(contactPhones.contactId, c.contactId), isNull(contactPhones.deletedAt), eq(contactPhones.isPrimary, true))).limit(1);
        to = p ? p.e164.replace(/^\+/, '') : null;
      }
      if (!to) throw new ConflictError('NO_RECIPIENT', 'El contacto no tiene un teléfono al cual escribir');
      return { externalId: m.externalId, phoneNumberId: ctx.phoneNumberId, accessToken, to };
    });

    try {
      await this.provider.sendReaction({ accessToken: plan.accessToken }, plan.phoneNumberId, { to: plan.to, targetExternalId: plan.externalId, emoji });
    } catch (e) {
      const code = e instanceof WhatsAppProviderError ? e.code : 'unavailable';
      this.log.warn({ message_id: messageId, code }, 'reacción de WhatsApp no salió');
      const text = ERROR_TEXT[code] ?? ERROR_TEXT['rejected']!;
      // Siempre 409 con su explicación: el código distingue el fallo pasajero (se puede reintentar) del definitivo
      throw new ConflictError(isRetryableError(code) ? 'REACTION_UNAVAILABLE' : 'REACTION_REJECTED', text);
    }

    const patch = JSON.stringify(emoji ? { my_reaction: emoji, my_reaction_at: now.toISOString() } : { my_reaction_at: now.toISOString() });
    await this.db.withTenant((tx) =>
      tx
        .update(messages)
        .set({ meta: emoji ? sql`${messages.meta} || ${patch}::jsonb` : sql`(${messages.meta} - 'my_reaction') || ${patch}::jsonb` })
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId))),
    );
    this.realtime?.touchHere(conversationId, { message: { id: messageId, kind: 'updated' } });
    return { id: messageId, my_reaction: emoji || null };
  }
}
