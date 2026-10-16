import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lte } from 'drizzle-orm';
import { Database, metaEvents } from '../../db';
import { CAPI_PROVIDER, CapiSendError, type CapiProvider } from './capi.ports';

export const CAPI_BATCH = 10;
export const CAPI_MAX_ATTEMPTS = 5;
/** Meta no acepta eventos de hace más de 7 días: pasado ese tiempo el evento caduca en vez de reintentarse. */
export const CAPI_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * Envía a Meta los eventos pendientes cuya hora ya llegó, de UNA empresa (el TenantContext lo pone quien llama: el job recorre las empresas una a una).
 * `FOR UPDATE SKIP LOCKED`: varias instancias pueden correr a la vez sin enviar dos veces. Un fallo reintentable se reprograma con espera creciente; uno
 * definitivo o el intento 5 deja el evento en `failed`. Sin proveedor (`none`) no hace nada y los eventos siguen pendientes.
 */
@Injectable()
export class CapiSenderService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CAPI_PROVIDER) private readonly provider: CapiProvider,
  ) {}

  get enabled(): boolean {
    return this.provider.kind !== 'none';
  }

  async runDue(now = new Date(), batch = CAPI_BATCH): Promise<number> {
    if (!this.enabled) return 0;
    return this.db.withTenant(async (tx) => {
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
          await this.provider.send({ eventId: ev.eventId, type: ev.type as 'Lead' | 'Schedule' | 'Purchase' | 'SaleCanceled', eventTime: new Date(Number(ev.payload['event_time'] ?? 0) * 1000), payload: ev.payload });
          await tx.update(metaEvents).set({ status: 'sent', attempts, sentAt: now, lastError: null, updatedAt: now }).where(eq(metaEvents.id, ev.id));
        } catch (e) {
          // El mensaje de un CapiSendError es seguro por contrato; cualquier otro error se reduce a un texto genérico (podría llevar datos sensibles)
          const retryable = e instanceof CapiSendError ? e.retryable : true;
          const message = e instanceof CapiSendError ? e.message.slice(0, 300) : 'Error inesperado al enviar el evento';
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
}
