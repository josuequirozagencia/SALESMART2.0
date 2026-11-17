import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { campaignAdvisorLimits, campaignRecipients, campaignSettings, campaigns, channelAccounts, contacts, Database, whatsappAccounts, type TenantTx } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import { writeAudit } from '../audit';
import { CustomValuesService, type CustomValues } from '../custom-fields';
import { OutreachService } from '../outreach';
import { customKeysIn, resolveQuickReply, type ResolveContext } from '../quick-replies';
import { TemplatesService } from '../templates';
import { OFFICIAL_DAILY_CAP } from './campaigns.dto';

type Campaign = typeof campaigns.$inferSelect;

/** Cuántos mensajes de una campaña pueden estar «en camino» (en cola del despachador) a la vez: si WhatsApp está lento o rechazando, no se apilan más. */
export const MAX_IN_FLIGHT = 2;
/** Cuántos destinatarios se descartan (baja, sin dato…) en una sola pasada antes de seguir con el siguiente mensaje real. */
const MAX_SKIPS_PER_PASS = 25;
const DAY_MS = 86_400_000;
/** Si se alcanzó un tope diario, la campaña espera este tiempo antes de volver a mirar. */
const CAP_RECHECK_MS = 10 * 60_000;

/** Fallos de un mensaje que son de la CONEXIÓN o de la plantilla, no del contacto: pausan la campaña entera, con el motivo, para que una persona lo arregle y la reanude. */
export const PAUSING_ERRORS: Readonly<Record<string, string>> = {
  rate_limited: 'WhatsApp limitó los envíos de este número. La campaña quedó pausada: reanúdala más tarde.',
  invalid_token: 'WhatsApp rechazó la conexión: el administrador debe actualizar el token. La campaña quedó pausada.',
  number_not_found: 'La conexión de WhatsApp ya no existe en Meta: revísala en Configuración › Conexiones. La campaña quedó pausada.',
  channel_off: 'La conexión de WhatsApp está desactivada. Actívala y reanuda la campaña.',
  credentials: 'No se pueden leer las credenciales de la conexión: el administrador debe volver a pegar el token. La campaña quedó pausada.',
  template_unavailable: 'La plantilla ya no está disponible en Meta. Sincroniza las plantillas y crea la campaña de nuevo. La campaña quedó pausada.',
};
const CONNECTION_DOWN = 'La conexión de WhatsApp no está disponible o está desactivada. Actívala y reanuda la campaña.';
const TEMPLATE_GONE = 'La plantilla ya no está aprobada o disponible. Sincroniza las plantillas y crea la campaña de nuevo.';

/**
 * El envío de las campañas por WhatsApp OFICIAL (v17 · 17.3, ADR-72): la tarea `campaign-sender` (cada 5 s, por empresa) hace tres cosas, en este orden.
 *  1. Pasa a «en curso» las campañas programadas cuya hora llegó.
 *  2. Pone al día el estado de cada destinatario (en cola → enviado → entregado → leído, o fallido) con lo que ya dicen los mensajes, y PAUSA la campaña si un mensaje falló por algo de la
 *     conexión o de la plantilla (límite de WhatsApp, token rechazado, plantilla pausada…).
 *  3. Saca UN mensaje por campaña y pasada, respetando la pausa entre mensajes, los topes diarios (campaña, asesor y empresa) y un máximo de mensajes en camino.
 * Cada campaña se trabaja en su propia transacción con su fila bloqueada (`SKIP LOCKED`: dos instancias no se pisan) y el mensaje se deja en la cola de salida habitual
 * (`sender_type = 'campaign'`), que lo envía con sus reintentos. El destinatario pasa a «en cola» y recibe su mensaje EN LA MISMA transacción: un reintento nunca duplica el mensaje a un
 * contacto. Antes de cada envío se vuelve a comprobar que el contacto no pidió la baja (`revoked` jamás recibe) y que la conexión y la plantilla siguen disponibles.
 */
@Injectable()
export class CampaignSenderService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OutreachService) private readonly outreach: OutreachService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
  ) {}

  /** Una pasada para la empresa del contexto. Devuelve cuántas cosas hizo (solo para el registro). */
  async runDue(now: Date): Promise<number> {
    let touched = 0;
    // 1 y 2: una transacción corta para lo que es de toda la empresa
    const due = await this.db.withTenant(async (tx) => {
      const promoted = await tx.update(campaigns).set({ status: 'running', nextSendAt: now, updatedAt: now }).where(and(eq(campaigns.status, 'scheduled'), lte(campaigns.scheduledAt, now), isNull(campaigns.deletedAt))).returning({ id: campaigns.id });
      touched += promoted.length;
      touched += await this.syncRecipients(tx, now);
      const rows = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.status, 'running'), isNull(campaigns.deletedAt), sql`(${campaigns.nextSendAt} IS NULL OR ${campaigns.nextSendAt} <= ${now.toISOString()}::timestamptz)`))
        .orderBy(asc(campaigns.id))
        .limit(50);
      return rows.map((r) => r.id);
    });
    // 3: cada campaña en SU transacción (una que falla no frena a las demás)
    for (const id of due) {
      try {
        touched += await this.db.withTenant((tx) => this.step(tx, id, now));
      } catch {
        // mejor esfuerzo: se vuelve a intentar en la siguiente pasada; el detalle ya queda en el registro del servidor por la excepción de la transacción
      }
    }
    return touched;
  }

  /**
   * Pone el estado de los destinatarios al día con el de sus mensajes (nunca retrocede: en cola → enviado → entregado → leído) y pausa las campañas cuyo mensaje falló por la conexión
   * o la plantilla. Un destinatario que ya respondió no se toca (solo avanzan los que están en cola, enviados o entregados).
   */
  private async syncRecipients(tx: TenantTx, now: Date): Promise<number> {
    const iso = now.toISOString();
    const res = await tx.execute(sql`
      UPDATE campaign_recipients r SET
        status = CASE m.status WHEN 'failed' THEN 'failed' WHEN 'read' THEN 'read' WHEN 'delivered' THEN 'delivered' ELSE 'sent' END,
        sent_at = COALESCE(r.sent_at, m.sent_at),
        delivered_at = COALESCE(r.delivered_at, m.delivered_at),
        read_at = COALESCE(r.read_at, m.read_at),
        failed_at = CASE WHEN m.status = 'failed' THEN COALESCE(r.failed_at, ${iso}::timestamptz) ELSE r.failed_at END,
        error = CASE WHEN m.status = 'failed' THEN left(COALESCE(m.error, 'No se pudo enviar'), 200) ELSE r.error END,
        updated_at = ${iso}::timestamptz
      FROM messages m
      WHERE m.id = r.message_id
        AND r.status IN ('queued', 'sent', 'delivered')
        AND m.status IN ('sent', 'delivered', 'read', 'failed')
        AND (CASE m.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 4 END) > (CASE r.status WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
      RETURNING r.campaign_id AS campaign_id, r.status AS status, m.meta ->> 'error_code' AS error_code`);
    const rows = res.rows as Array<{ campaign_id: string; status: string; error_code: string | null }>;
    for (const r of rows) {
      const reason = r.status === 'failed' && r.error_code ? PAUSING_ERRORS[r.error_code] : undefined;
      if (reason) await this.pause(tx, r.campaign_id, reason, now);
    }
    return rows.length;
  }

  /** Pausa una campaña EN CURSO con su motivo (si ya estaba pausada, cancelada o terminada no cambia nada). */
  private async pause(tx: TenantTx, id: string, reason: string, now: Date): Promise<void> {
    const done = await tx.update(campaigns).set({ status: 'paused', statusReason: reason, updatedAt: now }).where(and(eq(campaigns.id, id), eq(campaigns.status, 'running'))).returning({ id: campaigns.id });
    if (done.length > 0) await writeAudit(tx, { entityType: 'campaign', entityId: id, field: 'paused', oldValue: 'running', newValue: { status: 'paused', by: 'system', reason }, source: 'automation' });
  }

  /** Tope diario de la empresa por WhatsApp oficial (el que fijó el administrador o, sin él, el provisional). */
  private async officialCap(tx: TenantTx): Promise<number> {
    const [s] = await tx.select({ cap: campaignSettings.officialDailyCap }).from(campaignSettings).limit(1);
    return s?.cap ?? OFFICIAL_DAILY_CAP;
  }

  /** Saca el siguiente mensaje de UNA campaña (o la pausa, la termina o la deja esperar). Devuelve cuántas cosas hizo. */
  private async step(tx: TenantTx, id: string, now: Date): Promise<number> {
    const [c] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.status, 'running'), isNull(campaigns.deletedAt))).for('update', { skipLocked: true }).limit(1);
    if (!c || !c.templateId) return 0; // otra instancia la tiene, o ya no está en curso
    if (c.nextSendAt && c.nextSendAt.getTime() > now.getTime()) return 0;

    // La conexión y la plantilla, una vez por pasada: si no están, se pausa con el motivo (no se descartan destinatarios por un problema que no es suyo)
    const [ch] = await tx
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .innerJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id)))
      .where(and(eq(channelAccounts.id, c.channelAccountId), isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'), eq(whatsappAccounts.active, true)))
      .limit(1);
    if (!ch) return this.pauseNow(tx, c, CONNECTION_DOWN, now);
    try {
      await this.templates.getSendable(tx, c.channelAccountId, c.templateId);
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof ConflictError) return this.pauseNow(tx, c, TEMPLATE_GONE, now);
      throw e;
    }

    // Mensajes en camino y topes diarios (campaña, asesor y empresa); si se alcanzó alguno, espera
    const since = new Date(now.getTime() - DAY_MS);
    const [flight] = await tx.select({ n: count() }).from(campaignRecipients).where(and(eq(campaignRecipients.campaignId, c.id), eq(campaignRecipients.status, 'queued')));
    if ((flight?.n ?? 0) >= MAX_IN_FLIGHT) return 0;
    const sent24 = async (where: SQL): Promise<number> => {
      const [r] = await tx.select({ n: count() }).from(campaignRecipients).innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId)).where(and(where, gte(campaignRecipients.queuedAt, since)));
      return r?.n ?? 0;
    };
    const [advisor] = await tx.select({ cap: campaignAdvisorLimits.dailyCap }).from(campaignAdvisorLimits).where(eq(campaignAdvisorLimits.userId, c.createdBy)).limit(1);
    const capped =
      (await sent24(eq(campaigns.id, c.id))) >= c.dailyCap ||
      (advisor !== undefined && (await sent24(eq(campaigns.createdBy, c.createdBy))) >= advisor.cap) ||
      (await sent24(eq(campaigns.channelAccountId, c.channelAccountId))) >= (await this.officialCap(tx));
    if (capped) {
      await tx.update(campaigns).set({ nextSendAt: new Date(now.getTime() + CAP_RECHECK_MS), updatedAt: now }).where(eq(campaigns.id, c.id));
      return 0;
    }

    let touched = 0;
    for (let i = 0; i < MAX_SKIPS_PER_PASS; i += 1) {
      const [r] = await tx.select().from(campaignRecipients).where(and(eq(campaignRecipients.campaignId, c.id), eq(campaignRecipients.status, 'pending'))).orderBy(asc(campaignRecipients.id)).for('update', { skipLocked: true }).limit(1);
      if (!r) {
        // No queda nadie por atender: la campaña terminó (lo que está en camino sigue su curso y se refleja en los resultados)
        await tx.update(campaigns).set({ status: 'completed', finishedAt: now, nextSendAt: null, updatedAt: now }).where(eq(campaigns.id, c.id));
        await writeAudit(tx, { entityType: 'campaign', entityId: c.id, field: 'completed', oldValue: 'running', newValue: { status: 'completed' }, source: 'automation' });
        return touched + 1;
      }
      const outcome = await this.sendOne(tx, c, r, now);
      touched += 1;
      if (outcome === 'queued') {
        await tx.update(campaigns).set({ nextSendAt: new Date(now.getTime() + c.gapSeconds * 1000), updatedAt: now }).where(eq(campaigns.id, c.id));
        return touched;
      }
      if (outcome === 'paused') return touched;
      // 'skipped': se sigue con el siguiente en esta misma pasada
    }
    return touched;
  }

  private async pauseNow(tx: TenantTx, c: Campaign, reason: string, now: Date): Promise<number> {
    await this.pause(tx, c.id, reason, now);
    return 1;
  }

  /** Atiende a UN destinatario: lo descarta con su motivo o deja su mensaje en la cola de salida. */
  private async sendOne(tx: TenantTx, c: Campaign, r: typeof campaignRecipients.$inferSelect, now: Date): Promise<'queued' | 'skipped' | 'paused'> {
    const skip = async (reason: 'revoked' | 'missing_variable' | 'no_phone' | 'out_of_scope', error: string | null = null): Promise<'skipped'> => {
      await tx.update(campaignRecipients).set({ status: 'skipped', skipReason: reason, error, updatedAt: now }).where(eq(campaignRecipients.id, r.id));
      return 'skipped';
    };
    const [contact] = await tx.select({ id: contacts.id, name: contacts.name, ownerId: contacts.ownerId, consent: contacts.consent, deletedAt: contacts.deletedAt }).from(contacts).where(eq(contacts.id, r.contactId)).limit(1);
    if (!contact || contact.deletedAt) return skip('out_of_scope');
    if (contact.consent === 'revoked') return skip('revoked'); // la baja manda sobre todo lo demás: jamás se le escribe
    if (!r.phone) return skip('no_phone');

    // Las variables de la plantilla con los datos de ESTE contacto; sin el dato, no se manda la llave cruda: se descarta con su motivo
    const texts = Object.values(c.templateParams);
    const wanted = new Set(texts.flatMap((t) => customKeysIn(t)));
    const values: CustomValues = wanted.size === 0 ? {} : ((await this.custom.valuesFor(tx, 'contact', [contact.id])).get(contact.id) ?? {});
    const ctx: ResolveContext = { contactName: contact.name, contactPhone: r.phone, agentName: '', orgName: '', custom: Object.fromEntries(Object.entries(values).filter(([k]) => wanted.has(k))) };
    const params: Record<string, string> = {};
    for (const [key, text] of Object.entries(c.templateParams)) {
      const out = resolveQuickReply(text, ctx);
      if (out.missing.length > 0) return skip('missing_variable', `Falta el dato ${out.missing.map((m) => `{{${m}}}`).join(', ')}`.slice(0, 200));
      params[key] = out.text.trim();
    }

    const sent = await this.outreach.sendTemplate(tx, { contactId: contact.id, phone: r.phone, channelId: c.channelAccountId, templateId: c.templateId!, params, queueId: null, ownerId: contact.ownerId ?? c.createdBy, now, senderType: 'campaign' });
    if (sent.sent) {
      await tx.update(campaignRecipients).set({ status: 'queued', messageId: sent.messageId, conversationId: sent.conversationId, queuedAt: now, updatedAt: now }).where(eq(campaignRecipients.id, r.id));
      return 'queued';
    }
    if (sent.reason === 'revoked') return skip('revoked');
    if (sent.reason === 'channel_unavailable') {
      await this.pause(tx, c.id, CONNECTION_DOWN, now);
      return 'paused';
    }
    // `template_unavailable` aquí significa que los datos de ESTE contacto no valen para la plantilla (la plantilla ya se comprobó antes): se descarta solo a él
    return skip('missing_variable', 'Un dato no sirve para la plantilla');
  }
}
