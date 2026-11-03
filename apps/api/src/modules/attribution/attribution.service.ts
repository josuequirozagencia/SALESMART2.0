import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Database, metaEvents, type TenantTx } from '../../db';
import { NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { ContactsService, ContactTouchesService } from '../contacts';
import { AttributionEndpointsService, OrgDirectoryService } from '../organizations';
import { SystemTagsService } from '../tags';
import type { CtwaWebhookDto } from './attribution.dto';
import { MetaSettingsService } from './meta-settings.service';

/** Ventana de gracia del Purchase (ADR-18/45): por defecto 30 min, máximo 24 h. Su pantalla de configuración llega en M6. */
export const DEFAULT_GRACE_MS = 30 * 60_000;
export const MAX_GRACE_MS = 24 * 60 * 60_000;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
/** Huella del teléfono como la pide Meta: solo dígitos (sin «+»), SHA-256. El teléfono en claro NUNCA se guarda en el evento. */
export const phoneHash = (e164: string): string => sha256(e164.replace(/\D/g, ''));

export interface RecordResult {
  contactCreated: boolean;
  /** El mismo clic ya estaba registrado: no se cambió nada. */
  duplicate: boolean;
}

/**
 * Atribución de Meta Ads (M3.3, ADR-45): recibe el clic de Click-to-WhatsApp, lo graba en el contacto (primer toque inmutable, último toque que se sobrescribe),
 * pone la etiqueta del sistema `Lead` y deja el evento hacia Meta en la salida (outbox). El envío real llega en M6; aquí solo se encola.
 * `onSaleTagSet` / `cancelPurchase` los llamará el módulo de ventas (M6): se dejan listos y probados.
 */
@Injectable()
export class AttributionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(ContactTouchesService) private readonly touches: ContactTouchesService,
    @Inject(SystemTagsService) private readonly tags: SystemTagsService,
    @Inject(AttributionEndpointsService) private readonly endpoints: AttributionEndpointsService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(MetaSettingsService) private readonly settings: MetaSettingsService,
  ) {}

  /**
   * Entrada del webhook (sin sesión): la empresa sale del punto de entrada (id opaco + secreto), nunca del cuerpo. Un id desconocido, un secreto equivocado
   * o ausente responden igual (404). Abre el contexto de ESA empresa y registra el clic.
   */
  async ingest(endpointId: string, secret: string | undefined, input: CtwaWebhookDto): Promise<RecordResult> {
    const organizationId = secret ? await this.endpoints.resolve(endpointId, secret) : null;
    if (!organizationId) throw new NotFoundError();
    // Empresa suspendida o eliminada (ADR-59 #5): se acepta y se ignora, para que quien llama no reintente ni se entere de nada
    if (!(await this.directory.isOperating(organizationId))) return { contactCreated: false, duplicate: true };
    return TenantContext.run({ organizationId }, () => this.record(input));
  }

  /** Registra un clic dentro del TenantContext de la empresa (lo establece quien llama). Idempotente por `ctwa_cl_id`. */
  async record(input: CtwaWebhookDto, now = new Date()): Promise<RecordResult> {
    return this.db.withTenant((tx) => this.recordIn(tx, input, now));
  }

  /**
   * Registra un clic de anuncio DENTRO de la transacción de quien llama: el punto de entrada externo (`record`) o el aviso de Meta del primer mensaje (`referral`, M6.6). Graba el primer
   * y el último toque del contacto, el historial (`contact_touch_events`) y deja el Lead hacia Meta. `contactId` evita buscar de nuevo al contacto cuando ya se tiene.
   */
  async recordIn(tx: TenantTx, input: CtwaWebhookDto, now = new Date(), known?: { id: string; created: boolean }): Promise<RecordResult> {
    const at = input.occurred_at ? new Date(input.occurred_at) : now;
    {
      const { id, created } = known ?? (await this.contacts.findOrCreateByPhone(tx, input.phone, input.source));
      const touch = await this.contacts.applyTouch(tx, id, {
        ctwaClId: input.ctwa_cl_id,
        source: input.source,
        campaign: input.campaign_name ?? null,
        adset: input.adset_name ?? null,
        ad: input.ad_name ?? null,
        adId: input.ad_id ?? null,
        at,
      });
      // El historial lleva TODOS los clics (aunque uno viejo no cambie el último toque); es idempotente por el clic
      await this.touches.record(tx, id, { kind: 'ad_click', at, source: input.source, campaign: input.campaign_name, adset: input.adset_name, ad: input.ad_name, adId: input.ad_id, ctwaClid: input.ctwa_cl_id, headline: input.headline, thumbnailUrl: input.thumbnail_url, sourceUrl: input.source_url, originRef: input.ctwa_cl_id });
      if (touch.duplicate) return { contactCreated: created, duplicate: true };
      // Una fila por clic (el id incluye la huella del clic): repetir la llamada no duplica nada aunque el último toque ya sea otro
      const eventId = `lead:${id}:${sha256(input.ctwa_cl_id).slice(0, 24)}`;
      await tx
        .insert(metaEvents)
        .values({
          eventId,
          type: 'Lead',
          contactId: id,
          sendAfter: now, // el Lead se envía sin ventana de gracia
          payload: {
            event_name: 'Lead',
            event_time: Math.floor(at.getTime() / 1000),
            event_id: eventId,
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
            user_data: { ph: [phoneHash(input.phone)], ctwa_clid: input.ctwa_cl_id },
            custom_data: { campaign: input.campaign_name ?? null, adset: input.adset_name ?? null, ad: input.ad_name ?? null },
          },
        })
        .onConflictDoNothing();
      await this.tags.apply(tx, id, 'lead');
      return { contactCreated: created, duplicate: false };
    }
  }

  /**
   * Un formulario público trajo un lead (M9.1, ADR-09/54): etiqueta del sistema `Lead` y evento Lead hacia Meta como evento de **sitio web** (`action_source: website`). El `event_id` es el MISMO que el
   * Pixel de la página usa para deduplicar (lo manda el visitante; si no, uno propio). Los datos del usuario van con huella SHA-256 (teléfono, correo); `fbc`, `fbp`, la IP y el navegador van
   * como los pide Meta (sin huella) y solo si el visitante los trajo. Se envía sin ventana de gracia; sin credenciales de Meta el evento espera pendiente. Idempotente por `event_id`.
   */
  async onFormLead(tx: TenantTx, lead: { contactId: string; eventId: string; phone: string; email: string | null; fbc: string | null; fbp: string | null; ip: string | null; userAgent: string | null; sourceUrl: string | null; formName: string; utm?: Record<string, string> }, now = new Date()): Promise<void> {
    const userData: Record<string, unknown> = { ph: [phoneHash(lead.phone)] };
    if (lead.email) userData['em'] = [sha256(lead.email.trim().toLowerCase())];
    if (lead.fbc) userData['fbc'] = lead.fbc;
    if (lead.fbp) userData['fbp'] = lead.fbp;
    if (lead.ip) userData['client_ip_address'] = lead.ip;
    if (lead.userAgent) userData['client_user_agent'] = lead.userAgent;
    await tx
      .insert(metaEvents)
      .values({
        eventId: lead.eventId,
        type: 'Lead',
        contactId: lead.contactId,
        sendAfter: now,
        payload: {
          event_name: 'Lead',
          event_time: Math.floor(now.getTime() / 1000),
          event_id: lead.eventId,
          action_source: 'website',
          ...(lead.sourceUrl ? { event_source_url: lead.sourceUrl } : {}),
          user_data: userData,
          custom_data: { form: lead.formName },
        },
      })
      .onConflictDoNothing();
    await this.tags.apply(tx, lead.contactId, 'lead');
    // Historial (M6.6): el envío del formulario es un toque; sus utm dicen de qué campaña vino
    const utm = lead.utm ?? {};
    await this.touches.record(tx, lead.contactId, { kind: 'form_submit', at: now, source: 'form', campaign: utm['utm_campaign'], adset: utm['utm_content'], ad: utm['utm_term'], utm, sourceUrl: lead.sourceUrl, originRef: lead.eventId });
  }

  /**
   * El sistema pone la etiqueta `Venta` a un contacto (lo hará ventas en M6) y se encola el Purchase por el TOTAL de la venta (ADR-18) con ventana de gracia,
   * cancelable mientras esté pendiente. Si el contacto no llegó por un anuncio de Meta no hay a quién atribuir: queda `skipped` (con el motivo).
   * Dentro de la transacción del que llama (la venta). Idempotente por venta.
   */
  async onSaleTagSet(tx: TenantTx, sale: { contactId: string; saleId: string; amount: number; currency: string; graceMs?: number }, now = new Date()): Promise<{ eventId: string; status: 'pending' | 'skipped' }> {
    // La ventana de gracia la define cada empresa (Configuración › Meta); sin configurar, la de por omisión
    const grace = sale.graceMs ?? (await this.settings.graceMs(tx)) ?? DEFAULT_GRACE_MS;
    if (!Number.isFinite(grace) || grace < 0 || grace > MAX_GRACE_MS) throw new ValidationError([{ path: 'graceMs', code: 'invalid', message: 'La ventana de gracia debe estar entre 0 y 24 horas' }]);
    if (!Number.isFinite(sale.amount) || sale.amount < 0) throw new ValidationError([{ path: 'amount', code: 'invalid', message: 'El monto de la venta no es válido' }]);
    await this.tags.apply(tx, sale.contactId, 'sale');
    const who = await this.contacts.channelIdentity(tx, sale.contactId);
    const eventId = `purchase:${sale.saleId}`;
    const attributable = who !== null && who.ctwaClId !== null && who.primaryPhone !== null;
    const status = attributable ? 'pending' : 'skipped';
    await tx
      .insert(metaEvents)
      .values({
        eventId,
        type: 'Purchase',
        contactId: sale.contactId,
        status,
        sendAfter: attributable ? new Date(now.getTime() + grace) : now,
        lastError: attributable ? null : 'El contacto no llegó por un anuncio de Meta: no hay a quién atribuir la compra',
        payload: {
          event_name: 'Purchase',
          event_time: Math.floor(now.getTime() / 1000),
          event_id: eventId,
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: attributable ? { ph: [phoneHash(who.primaryPhone!)], ctwa_clid: who.ctwaClId } : {},
          custom_data: { value: sale.amount, currency: sale.currency },
        },
      })
      .onConflictDoNothing();
    return { eventId, status };
  }

  /**
   * Se agenda una cita (M6.3, ADR-18): el sistema pone la etiqueta `Cita agendada` y se encola el evento `Schedule` por la CITA (no por la etapa del pipeline), sin ventana de
   * gracia. Sin clic de anuncio no hay a quién atribuir: queda `skipped`. Dentro de la transacción de quien llama; idempotente por cita.
   */
  async onAppointmentCreated(tx: TenantTx, appt: { contactId: string; appointmentId: string; startsAt: Date }, now = new Date()): Promise<{ eventId: string; status: 'pending' | 'skipped' }> {
    await this.tags.apply(tx, appt.contactId, 'appointment');
    const who = await this.contacts.channelIdentity(tx, appt.contactId);
    const eventId = `schedule:${appt.appointmentId}`;
    const attributable = who !== null && who.ctwaClId !== null && who.primaryPhone !== null;
    const status = attributable ? 'pending' : 'skipped';
    await tx
      .insert(metaEvents)
      .values({
        eventId,
        type: 'Schedule',
        contactId: appt.contactId,
        status,
        sendAfter: now,
        lastError: attributable ? null : 'El contacto no llegó por un anuncio de Meta: no hay a quién atribuir la cita',
        payload: {
          event_name: 'Schedule',
          event_time: Math.floor(now.getTime() / 1000),
          event_id: eventId,
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: attributable ? { ph: [phoneHash(who.primaryPhone!)], ctwa_clid: who.ctwaClId } : {},
          custom_data: { appointment_time: appt.startsAt.toISOString() },
        },
      })
      .onConflictDoNothing();
    return { eventId, status };
  }

  /** Cancela el Purchase de una venta si aún está pendiente (dentro de la ventana de gracia). Devuelve true solo si lo canceló ahora. */
  async cancelPurchase(tx: TenantTx, saleId: string): Promise<boolean> {
    const rows = await tx
      .update(metaEvents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(metaEvents.eventId, `purchase:${saleId}`), eq(metaEvents.status, 'pending')))
      .returning({ contactId: metaEvents.contactId });
    const row = rows[0];
    if (!row) return false;
    await writeAudit(tx, { entityType: 'contact', entityId: row.contactId, field: 'meta_purchase', oldValue: 'pending', newValue: 'cancelled', source: 'automation' });
    return true;
  }
}
