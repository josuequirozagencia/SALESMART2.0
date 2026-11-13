import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { contacts, conversationParticipants, conversations, Database, messages, pushSubscriptions, queueMembers } from '../../db';
import { ForbiddenError, TooManyAttemptsError, ValidationError } from '../../errors';
import { WindowLimiter } from '../../http';
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
export interface PushTestView {
  /** Navegadores a los que el servicio de push aceptó el aviso. */
  sent: number;
  /** Navegadores que ya no existen (se dieron de baja). */
  gone: number;
  /** Rechazos o errores del servicio de push. */
  failed: number;
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

  /** Una prueba cada 10 s por persona: sirve para verificar la cadena, no para llenar el navegador. */
  private readonly testLimiter = new WindowLimiter(1, 10_000);

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

  /**
   * «Enviar notificación de prueba»: manda un aviso a TODOS los navegadores vigentes de esta persona en esta empresa, sin depender de conversaciones. Lleva `force` para que el service worker la
   * muestre aunque la aplicación esté a la vista. Solo a quien la pide (nunca a otra persona).
   */
  async sendTest(): Promise<PushTestView> {
    if (!this.cfg.push.enabled) throw new ValidationError([{ path: 'push', code: 'push_disabled', message: 'Las notificaciones push no están activadas en este servidor' }]);
    const userId = this.me();
    const taken = this.testLimiter.take(`${TenantContext.current().organizationId}:${userId}`);
    if (!taken.ok) throw new TooManyAttemptsError(taken.retryAfterSeconds);
    const subs = await this.db.withTenant((tx) => tx.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt))));
    const payload = JSON.stringify({ title: 'Notificación de prueba', body: 'Si ves esto, las notificaciones de Sales Smart funcionan en este navegador.', url: '/settings/notifications', tag: 'push-test', force: true });
    const out: PushTestView = { sent: 0, gone: 0, failed: 0 };
    const goneIds: string[] = [];
    for (const s of subs) {
      const r = await this.sender.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
      if (r === 'sent') out.sent += 1;
      else if (r === 'gone') {
        out.gone += 1;
        goneIds.push(s.id);
      } else out.failed += 1;
    }
    if (goneIds.length > 0) await this.db.withTenant((tx) => tx.update(pushSubscriptions).set({ revokedAt: new Date() }).where(inArray(pushSubscriptions.id, goneIds)));
    return out;
  }

  /**
   * Aviso de una venta nueva (v13 S4.2) a las personas dadas (la administración de la empresa). Sin el permiso de mostrar el texto, no lleva ni vendedor, ni monto, ni cliente. Corre dentro del
   * contexto de la empresa de quien registró la venta. Mejor esfuerzo: nunca lanza.
   */
  async notifySale(recipients: readonly string[], n: { saleId: string; seller: string; amount: string; contact: string }): Promise<void> {
    if (!this.cfg.push.enabled || recipients.length === 0) return;
    try {
      const subs = await this.db.withTenant((tx) => tx.select().from(pushSubscriptions).where(and(inArray(pushSubscriptions.userId, [...recipients]), isNull(pushSubscriptions.revokedAt))));
      const gone: string[] = [];
      for (const s of subs) {
        const payload = JSON.stringify({ title: 'Nueva venta', body: s.showText ? `${n.seller} · ${n.amount} · ${n.contact}` : 'Se registró una venta nueva', url: '/sales', tag: `sale-${n.saleId}` });
        if ((await this.sender.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload)) === 'gone') gone.push(s.id);
      }
      if (gone.length > 0) await this.db.withTenant((tx) => tx.update(pushSubscriptions).set({ revokedAt: new Date() }).where(inArray(pushSubscriptions.id, gone)));
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.name : 'Error' }, 'push: no se pudo avisar de una venta nueva');
    }
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
   * Avisa de un mensaje entrante (v13 S4.1: UNA notificación por mensaje). Lo llama el tiempo real (fuera de cualquier petición) con las personas que pueden ver la conversación (`candidates`:
   * dueño, colaboradores vigentes y quien ve todo, siempre con permiso de leer el Inbox) y con las que la están MIRANDO en este instante (`watching`: a ellas no). Aquí se decide a quién:
   *  - con responsable: él y los colaboradores con acceso vigente;
   *  - sin responsable: los miembros activos del departamento de la conversación que puedan verla (y, si ninguno puede o no tiene departamento, todas las personas que la ven). Nunca a quien no
   *    puede abrirla: el aviso lleva el nombre del cliente.
   * Solo cuentan los mensajes del cliente: lo propio, lo automático, lo del agente de IA y las notas son de salida. Cada aviso lleva su propia etiqueta (no se reemplazan entre sí). Mejor esfuerzo:
   * nunca lanza (el mensaje ya está en la bandeja).
   */
  async notifyInbound(organizationId: string, conversationId: string, messageId: string, candidates: ReadonlySet<string>, watching: ReadonlySet<string> = new Set()): Promise<void> {
    if (!this.cfg.push.enabled || candidates.size === 0) return;
    try {
      await TenantContext.run({ organizationId }, async () => {
        const [row] = await this.db.withTenant((tx) =>
          tx
            .select({ ownerId: conversations.ownerId, queueId: conversations.queueId, contact: contacts.name, kind: messages.kind, body: messages.body, direction: messages.direction })
            .from(messages)
            .innerJoin(conversations, and(eq(conversations.organizationId, messages.organizationId), eq(conversations.id, messages.conversationId)))
            .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
            .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
            .limit(1),
        );
        if (!row || row.direction !== 'in') return;
        let who: string[];
        if (row.ownerId) {
          const collaborators = await this.db.withTenant((tx) => tx.select({ userId: conversationParticipants.userId }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, conversationId), isNull(conversationParticipants.revokedAt))));
          who = [row.ownerId, ...collaborators.map((c) => c.userId)].filter((u) => candidates.has(u));
        } else {
          const dept = row.queueId ? await this.db.withTenant((tx) => tx.select({ userId: queueMembers.userId }).from(queueMembers).where(and(eq(queueMembers.queueId, row.queueId!), eq(queueMembers.active, true)))) : [];
          const inDept = dept.map((d) => d.userId).filter((u) => candidates.has(u));
          who = inDept.length > 0 ? inDept : [...candidates];
        }
        const recipients = [...new Set(who)].filter((u) => !watching.has(u));
        if (recipients.length === 0) return;
        const subs = await this.db.withTenant((tx) => tx.select().from(pushSubscriptions).where(and(inArray(pushSubscriptions.userId, recipients), isNull(pushSubscriptions.revokedAt))));
        const gone: string[] = [];
        const sentIds: string[] = [];
        for (const s of subs) {
          const text = (row.body ?? '').replace(/\s+/g, ' ').trim();
          const shown = row.kind === 'text' && text !== '' ? (text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS - 1)}…` : text) : (KIND_TEXT[row.kind] ?? 'Mensaje nuevo');
          const payload = JSON.stringify({ title: row.contact, body: s.showText ? shown : 'Mensaje nuevo', conversation_id: conversationId, message_id: messageId, url: `/inbox/${conversationId}`, tag: `msg-${messageId}` });
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
