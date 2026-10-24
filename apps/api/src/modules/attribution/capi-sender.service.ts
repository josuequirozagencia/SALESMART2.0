import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { conversations, Database, metaEvents, whatsappAccounts, type TenantTx } from '../../db';
import { CAPI_PROVIDER, CapiSendError, type CapiCredentials, type CapiProvider } from './capi.ports';
import { MetaSettingsService } from './meta-settings.service';

export const CAPI_BATCH = 10;
export const CAPI_MAX_ATTEMPTS = 5;
/** Meta no acepta eventos de hace más de 7 días: pasado ese tiempo el evento caduca en vez de reintentarse. */
export const CAPI_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * Envía a Meta los eventos pendientes cuya hora ya llegó, de UNA empresa (el TenantContext lo pone quien llama: el job recorre las empresas una a una).
 * `FOR UPDATE SKIP LOCKED`: varias instancias pueden correr a la vez sin enviar dos veces. Un fallo reintentable se reprograma con espera creciente; uno
 * definitivo o el intento 5 deja el evento en `failed`. Sin proveedor (`none`) no hace nada y los eventos siguen pendientes.
 * M6.4: cada empresa envía con SUS credenciales (dataset y token cifrados). Si el adaptador las necesita y la empresa no las ha configurado (o las apagó), los eventos siguen pendientes
 * —no se pierden: se envían cuando las configure, mientras no pasen de 7 días—. Si Meta rechaza las credenciales, el evento queda `blocked` (no `failed`), se anota en la conexión
 * y se deja de intentar con los demás de esa pasada; tras corregirlas se reintenta desde el panel.
 */
@Injectable()
export class CapiSenderService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CAPI_PROVIDER) private readonly provider: CapiProvider,
    @Inject(MetaSettingsService) private readonly settings: MetaSettingsService,
  ) {}

  get enabled(): boolean {
    return this.provider.kind !== 'none';
  }

  async runDue(now = new Date(), batch = CAPI_BATCH): Promise<number> {
    if (!this.enabled) return 0;
    return this.db.withTenant(async (tx) => {
      const creds = await this.settings.credentials(tx);
      if (this.provider.requiresCredentials && !creds) return 0;
      const credentials: CapiCredentials = creds ? { datasetId: creds.datasetId, accessToken: creds.accessToken, testEventCode: creds.testEventCode ?? null } : { datasetId: 'fake', accessToken: 'fake' };
      const due = await tx
        .select()
        .from(metaEvents)
        .where(and(eq(metaEvents.status, 'pending'), lte(metaEvents.sendAfter, now)))
        .orderBy(asc(metaEvents.sendAfter), asc(metaEvents.id))
        .limit(batch)
        .for('update', { skipLocked: true });
      for (const ev of due) {
        const attempts = ev.attempts + 1;
        if (now.getTime() - ev.createdAt.getTime() > CAPI_MAX_AGE_MS) {
          await tx.update(metaEvents).set({ status: 'expired', lastError: 'El evento tiene más de 7 días: Meta ya no lo acepta', updatedAt: now }).where(eq(metaEvents.id, ev.id));
          continue;
        }
        try {
          const payload = await this.withWaba(tx, ev.contactId, ev.payload);
          await this.provider.send({ eventId: ev.eventId, type: ev.type as 'Lead' | 'Schedule' | 'Purchase' | 'SaleCanceled', eventTime: new Date(Number(ev.payload['event_time'] ?? 0) * 1000), payload }, credentials);
          await tx.update(metaEvents).set({ status: 'sent', attempts, sentAt: now, lastError: null, updatedAt: now }).where(eq(metaEvents.id, ev.id));
          if (creds) await this.settings.noteSendSuccess(tx, creds.id, now);
        } catch (e) {
          // El mensaje de un CapiSendError es seguro por contrato; cualquier otro error se reduce a un texto genérico (podría llevar datos sensibles)
          const retryable = e instanceof CapiSendError ? e.retryable : true;
          const message = e instanceof CapiSendError ? e.message.slice(0, 300) : 'Error inesperado al enviar el evento';
          if (e instanceof CapiSendError && e.credentials) {
            // Las credenciales no sirven: sin más intentos con las de esta empresa hasta que las corrija; el evento queda bloqueado (se reintenta desde el panel)
            await tx.update(metaEvents).set({ status: 'blocked', attempts, lastError: message, updatedAt: now }).where(eq(metaEvents.id, ev.id));
            if (creds) await this.settings.noteSendFailure(tx, creds.id, message, now);
            break;
          }
          if (!retryable || attempts >= CAPI_MAX_ATTEMPTS) {
            await tx.update(metaEvents).set({ status: 'failed', attempts, lastError: message, updatedAt: now }).where(eq(metaEvents.id, ev.id));
          } else {
            const wait = Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
            await tx.update(metaEvents).set({ attempts, lastError: message, sendAfter: new Date(now.getTime() + wait), updatedAt: now }).where(eq(metaEvents.id, ev.id));
          }
        }
      }
      return due.length;
    });
  }

  /**
   * Meta exige la cuenta de WhatsApp Business en los eventos de mensajería. El evento se arma al ocurrir la venta o la cita; la cuenta se agrega al ENVIAR (la del número por el que
   * habló el contacto, o la primera de la empresa) para no atar el evento a una conexión que pudo cambiar. Si no se encuentra, el evento sale como está.
   */
  private async withWaba(tx: TenantTx, contactId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userData = payload['user_data'];
    if (!userData || typeof userData !== 'object' || !('ctwa_clid' in userData) || 'whatsapp_business_account_id' in userData) return payload;
    const [byChat] = await tx
      .select({ waba: whatsappAccounts.wabaId })
      .from(conversations)
      .innerJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, conversations.organizationId), eq(whatsappAccounts.channelAccountId, conversations.channelAccountId)))
      .where(eq(conversations.contactId, contactId))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    const waba = byChat?.waba ?? (await tx.select({ waba: whatsappAccounts.wabaId }).from(whatsappAccounts).limit(1))[0]?.waba;
    return waba ? { ...payload, user_data: { ...(userData as Record<string, unknown>), whatsapp_business_account_id: waba } } : payload;
  }
}
