import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ghlContactLinks, messages, type TenantTx } from '../../db';
import { GhlChannelService } from './ghl-channel.service';
import { GhlConnectionService } from './ghl-connection.service';
import { GHL_PROVIDER, GhlError, type GhlCredentials, type GhlProvider, type GhlReplyType } from './ghl.ports';

const REPLY_TYPES: ReadonlySet<string> = new Set(['SMS', 'WhatsApp', 'IG', 'FB', 'Live_Chat']);

/** Por qué no se pudo preparar un envío por GHL (códigos que el despachador del Inbox traduce a un texto para la persona). */
export type GhlPrepareFailure = 'ghl_credentials' | 'ghl_no_contact' | 'ghl_type_unknown';

export interface GhlSendPlan {
  credentials: GhlCredentials;
  ghlContactId: string;
  type: GhlReplyType;
}

/**
 * Lo que el despachador del Inbox necesita para escribir por GoHighLevel (M7.4, ADR-52). Va aparte del módulo de GHL para que el Inbox solo conozca esta frontera: `prepare` junta, DENTRO de la
 * transacción del despachador, el token, el contacto de GHL y el canal por el que se responde; `send` llama a GHL FUERA de toda transacción. El canal se elige así: el del ÚLTIMO mensaje del cliente
 * (se responde por donde escribió) o, si el aviso no lo decía, el canal por omisión que configuró el administrador.
 */
@Injectable()
export class GhlOutboundService {
  constructor(
    @Inject(GHL_PROVIDER) private readonly provider: GhlProvider,
    @Inject(GhlConnectionService) private readonly connection: GhlConnectionService,
    @Inject(GhlChannelService) private readonly channel: GhlChannelService,
  ) {}

  async prepare(tx: TenantTx, conversation: { id: string; contactId: string }): Promise<{ ok: true; plan: GhlSendPlan } | { ok: false; code: GhlPrepareFailure }> {
    const credentials = await this.connection.credentials(tx);
    if (!credentials) return { ok: false, code: 'ghl_credentials' };
    const [link] = await tx.select({ ghlContactId: ghlContactLinks.ghlContactId }).from(ghlContactLinks).where(eq(ghlContactLinks.contactId, conversation.contactId)).limit(1);
    if (!link) return { ok: false, code: 'ghl_no_contact' };
    const [last] = await tx
      .select({ type: sql<string | null>`${messages.meta}->>'ghl_type'` })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'in'), sql`${messages.meta} ? 'ghl_type'`))
      .orderBy(desc(messages.sentAt), desc(messages.id))
      .limit(1);
    const fallback = (await this.channel.current(tx))?.defaultType ?? null;
    const type = last?.type && REPLY_TYPES.has(last.type) ? (last.type as GhlReplyType) : last?.type ? null : fallback;
    if (!type) return { ok: false, code: 'ghl_type_unknown' };
    return { ok: true, plan: { credentials: { locationId: credentials.locationId, accessToken: credentials.accessToken }, ghlContactId: link.ghlContactId, type } };
  }

  /** Escribe por GHL. Lanza `GhlError`; el despachador decide si reintenta (pasajero) o marca fallido (definitivo). */
  async send(plan: GhlSendPlan, text: string): Promise<{ id: string }> {
    return this.provider.sendMessage(plan.credentials, { ghlContactId: plan.ghlContactId, type: plan.type, text });
  }

  /** GHL rechazó el token al enviar: la conexión pide reconexión (y el canal se desactiva) para que se vea donde el administrador la revisa. */
  async tokenRejected(error: GhlError): Promise<void> {
    await this.connection.rejectedByProvider(error.message);
  }

  /** ¿Es un fallo de las credenciales (hay que reconectar) y no un problema pasajero o del mensaje? */
  static isCredentialsFailure(e: unknown): e is GhlError {
    return e instanceof GhlError && e.credentials;
  }

}
