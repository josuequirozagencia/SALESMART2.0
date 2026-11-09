import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { contacts, conversations, Database, messages, pushSubscriptions } from '../../db';
import { ForbiddenError, ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER, APP_CONFIG } from '../../tokens';
import { isAllowedPushEndpoint } from './push-endpoint';
import { PUSH_SENDER, type PushSender } from './push.port';
import type { EndpointInput, SubscribeInput } from './push.dto';

const BODY_CHARS = 90;
const KIND_TEXT: Readonly<Record<string, string>> = { image: '📷 Foto', audio: '🎤 Audio', video: '🎥 Video', document: '📄 Documento', sticker: 'Sticker', location: '📍 Ubicación', contacts: 'Contacto' };

export interface PushConfigView {
  /** ¿El servidor puede mandar notificaciones push? (adaptador y claves VAPID listos) */
  enabled: boolean;
  /** Clave pública VAPID (no es secreta) para que el navegador se suscriba. */
  public_key: string | null;
}
export interface PushStatusView {
  subscribed: boolean;
  show_text: boolean;
}

/**
 * Notificaciones push del navegador (v6 fase E, ADR-64). Tenant: la persona y la empresa salen del contexto verificado. Cada navegador (`endpoint`) está suscrito una vez por empresa. Las
 * direcciones de suscripción NUNCA se devuelven y solo se aceptan las de los servicios de push de los navegadores (anti-SSRF). El aviso de un mensaje entrante va al responsable de la
 * conversación (o, sin responsable, a quienes la pueden ver), nunca a quien no la puede abrir; el texto del mensaje solo viaja si esa persona lo eligió.
 */
@Injectable()
export class PushService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  config(): PushConfigView {
    return { enabled: this.cfg.push.enabled, public_key: this.cfg.push.enabled ? (this.cfg.push.vapidPublicKey ?? null) : null };
  }

  private me(): string {
    const id = TenantContext.current().userId;
    if (!id) throw new ForbiddenError();
    return id;
  }

  async status(input: EndpointInput): Promise<PushStatusView> {
    const userId = this.me();
    const [row] = await this.db.withTenant((tx) =>
      tx.select({ showText: pushSubscriptions.showText }).from(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, input.endpoint), eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt))).limit(1),
    );
    return { subscribed: row !== undefined, show_text: row?.showText ?? false };
  }

  /** Suscribe (o actualiza) este navegador para la persona. Si el navegador era de otra persona de la misma empresa, pasa a esta (el mismo equipo compartido). */
  async subscribe(input: SubscribeInput, userAgent: string | undefined): Promise<PushStatusView> {
    if (!this.cfg.push.enabled) throw new ValidationError([{ path: 'push', code: 'push_disabled', message: 'Las notificaciones push no están activadas en este servidor' }]);
    if (!isAllowedPushEndpoint(input.endpoint)) throw new ValidationError([{ path: 'endpoint', code: 'endpoint_not_allowed', message: 'Esa dirección de suscripción no es de un servicio de notificaciones push conocido' }]);
    const userId = this.me();
    const ua = userAgent?.slice(0, 200) ?? null;
    await this.db.withTenant((tx) =>
      tx
        .insert(pushSubscriptions)
        .values({ userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, showText: input.show_text, userAgent: ua })
        .onConflictDoUpdate({ target: [pushSubscriptions.organizationId, pushSubscriptions.endpoint], set: { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, showText: input.show_text, userAgent: ua, revokedAt: null } }),
    );
    return { subscribed: true, show_text: input.show_text };
  }

  /** Da de baja este navegador para la persona (solo el suyo: el de otra persona no se toca). */
  async unsubscribe(input: EndpointInput): Promise<PushStatusView> {
    const userId = this.me();
    await this.db.withTenant((tx) =>
      tx.update(pushSubscriptions).set({ revokedAt: new Date() }).where(and(eq(pushSubscriptions.endpoint, input.endpoint), eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt))),
    );
    return { subscribed: false, show_text: false };
  }

  /**
   * Avisa de un mensaje entrante. Lo llama el tiempo real (fuera de cualquier petición) con las personas que pueden ver la conversación; aquí se decide a quién: su responsable, o todas ellas si
   * aún no tiene. Mejor esfuerzo: nunca lanza (el mensaje ya está en la bandeja).
   */
  async notifyInbound(organizationId: string, conversationId: string, messageId: string, candidates: ReadonlySet<string>): Promise<void> {
    if (!this.cfg.push.enabled || candidates.size === 0) return;
    try {
      await TenantContext.run({ organizationId }, async () => {
        const [row] = await this.db.withTenant((tx) =>
          tx
            .select({ ownerId: conversations.ownerId, contact: contacts.name, kind: messages.kind, body: messages.body, direction: messages.direction })
            .from(messages)
            .innerJoin(conversations, and(eq(conversations.organizationId, messages.organizationId), eq(conversations.id, messages.conversationId)))
            .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
            .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
            .limit(1),
        );
        if (!row || row.direction !== 'in') return;
        const recipients = row.ownerId ? (candidates.has(row.ownerId) ? [row.ownerId] : []) : [...candidates];
        if (recipients.length === 0) return;
        const subs = await this.db.withTenant((tx) => tx.select().from(pushSubscriptions).where(and(inArray(pushSubscriptions.userId, recipients), isNull(pushSubscriptions.revokedAt))));
        const gone: string[] = [];
        const sentIds: string[] = [];
        for (const s of subs) {
          const text = (row.body ?? '').replace(/\s+/g, ' ').trim();
          const shown = row.kind === 'text' && text !== '' ? (text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS - 1)}…` : text) : (KIND_TEXT[row.kind] ?? 'Mensaje nuevo');
          const payload = JSON.stringify({ title: row.contact, body: s.showText ? shown : 'Mensaje nuevo', conversation_id: conversationId, url: `/inbox/${conversationId}`, tag: `conv-${conversationId}` });
          const r = await this.sender.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
          if (r === 'gone') gone.push(s.id);
          else if (r === 'sent') sentIds.push(s.id);
        }
        if (gone.length > 0) await this.db.withTenant((tx) => tx.update(pushSubscriptions).set({ revokedAt: new Date() }).where(inArray(pushSubscriptions.id, gone)));
        if (sentIds.length > 0) await this.db.withTenant((tx) => tx.update(pushSubscriptions).set({ lastSentAt: new Date() }).where(inArray(pushSubscriptions.id, sentIds)));
      });
    } catch (e) {
      this.log.warn({ organization_id: organizationId, err: e instanceof Error ? e.name : 'Error' }, 'push: no se pudo avisar de un mensaje entrante');
    }
  }
}
