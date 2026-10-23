import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Database, metaEvents, type TenantTx } from '../../db';
import { NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { AttributionEndpointsService } from '../organizations';
import { SystemTagsService } from '../tags';
import type { CtwaWebhookDto } from './attribution.dto';

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
    @Inject(SystemTagsService) private readonly tags: SystemTagsService,
    @Inject(AttributionEndpointsService) private readonly endpoints: AttributionEndpointsService,
  ) {}

  /**
   * Entrada del webhook (sin sesión): la empresa sale del punto de entrada (id opaco + secreto), nunca del cuerpo. Un id desconocido, un secreto equivocado
   * o ausente responden igual (404). Abre el contexto de ESA empresa y registra el clic.
   */
  async ingest(endpointId: string, secret: string | undefined, input: CtwaWebhookDto): Promise<RecordResult> {
    const organizationId = secret ? await this.endpoints.resolve(endpointId, secret) : null;
    if (!organizationId) throw new NotFoundError();
    return TenantContext.run({ organizationId }, () => this.record(input));
  }

  /** Registra un clic dentro del TenantContext de la empresa (lo establece quien llama). Idempotente por `ctwa_cl_id`. */
  async record(input: CtwaWebhookDto, now = new Date()): Promise<RecordResult> {
    const at = input.occurred_at ? new Date(input.occurred_at) : now;
    return this.db.withTenant(async (tx) => {
      const { id, created } = await this.contacts.findOrCreateByPhone(tx, input.phone, input.source);
      const touch = await this.contacts.applyTouch(tx, id, {
        ctwaClId: input.ctwa_cl_id,
        source: input.source,
        campaign: input.campaign_name ?? null,
        adset: input.adset_name ?? null,
        ad: input.ad_name ?? null,
        at,
      });
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
    });
  }

  /**
   * El sistema pone la etiqueta `Venta` a un contacto (lo hará ventas en M6) y se encola el Purchase por el TOTAL de la venta (ADR-18) con ventana de gracia,
   * cancelable mientras esté pendiente. Si el contacto no llegó por un anuncio de Meta no hay a quién atribuir: queda `skipped` (con el motivo).
   * Dentro de la transacción del que llama (la venta). Idempotente por venta.
   */
  async onSaleTagSet(tx: TenantTx, sale: { contactId: string; saleId: string; amount: number; currency: string; graceMs?: number }, now = new Date()): Promise<{ eventId: string; status: 'pending' | 'skipped' }> {
    const grace = sale.graceMs ?? DEFAULT_GRACE_MS;
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
