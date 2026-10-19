import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { Database, webhookEvents, whatsappAccounts, type TenantTx } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { ConversationsService } from '../conversations';
import { deepStripNul } from './meta-webhook';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from './whatsapp.port';

export const EVENT_BATCH = 20;
export const EVENT_MAX_ATTEMPTS = 5;
/** Cuántos días se conserva el contenido de un aviso ya procesado (provisional, ADR-50 #4). Después queda solo el registro del evento. */
export const PAYLOAD_RETENTION_DAYS = 30;
const REDACT_BATCH = 500;
const MAX_BACKOFF_MS = 10 * 60_000;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

type EventRow = typeof webhookEvents.$inferSelect;

/** Etiqueta del error SIN su mensaje (podría llevar el texto de un cliente o un teléfono): solo la clase y el código de la base de datos. */
export function errorLabel(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : typeof (e as { code?: unknown } | null)?.code === 'string' ? ((e as { code: string }).code) : null;
  const name = e instanceof Error ? e.name : 'Error';
  return (code ? `${name}:${code}` : name).slice(0, 100);
}

/**
 * Avisos del webhook de una empresa (M5.2, ADR-50 #4). El webhook solo VALIDA y GUARDA el aviso (ya con su empresa) y responde 200; esta tarea lo convierte en
 * contacto, conversación y mensajes. Todo corre dentro del TenantContext de la empresa que pone quien llama.
 *  - `store`: idempotente por huella del contenido (Meta reintenta la misma entrega).
 *  - `runDue`: `FOR UPDATE SKIP LOCKED` (varias instancias no pisan el mismo aviso). Cada aviso corre en su SAVEPOINT: si falla se revierte solo él, se reintenta
 *    con espera creciente (15 s, 30 s, 1 min… hasta 10 min) y tras 5 intentos queda `failed`. Los avisos son idempotentes, así que reprocesar es seguro.
 *  - A los 30 días el contenido de los avisos ya procesados se vacía.
 */
@Injectable()
export class WebhookEventsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Guarda el aviso de un número. true = es nuevo; false = ya lo teníamos (reintento de Meta). También anota la hora del último aviso del número. */
  async store(channelAccountId: string, phoneNumberId: string, raw: Record<string, unknown>, now = new Date()): Promise<boolean> {
    // El aviso se guarda sin NUL (jsonb no los admite); la huella es de lo que se guarda
    const clean = deepStripNul(raw);
    const hash = sha256(JSON.stringify(clean));
    return this.db.withTenant(async (tx) => {
      const inserted = await tx
        .insert(webhookEvents)
        .values({ channelAccountId, phoneNumberId, payload: clean, payloadHash: hash, receivedAt: now, nextAttemptAt: now })
        .onConflictDoNothing({ target: [webhookEvents.organizationId, webhookEvents.payloadHash] })
        .returning({ id: webhookEvents.id });
      await tx.update(whatsappAccounts).set({ lastEventAt: now }).where(eq(whatsappAccounts.channelAccountId, channelAccountId));
      return inserted.length > 0;
    });
  }

  /** Procesa los avisos pendientes cuya hora ya llegó. Devuelve cuántos tomó (hechos o reprogramados). */
  async runDue(now = new Date(), batch = EVENT_BATCH): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const due = await tx
        .select()
        .from(webhookEvents)
        .where(and(eq(webhookEvents.status, 'pending'), lte(webhookEvents.nextAttemptAt, now)))
        .orderBy(asc(webhookEvents.receivedAt), asc(webhookEvents.id))
        .limit(batch)
        .for('update', { skipLocked: true });
      for (const ev of due) await this.processOne(tx, ev, now);
      if (due.length < batch) await this.redactOld(tx, now);
      return due.length;
    });
  }

  private async processOne(tx: TenantTx, ev: EventRow, now: Date): Promise<void> {
    const attempts = ev.attempts + 1;
    // SAVEPOINT en la misma transacción: si este aviso falla se revierte solo lo suyo y la transacción (y los demás avisos del lote) siguen sanos
    await tx.execute(sql`SAVEPOINT webhook_event`);
    let failure: unknown = null;
    try {
      // Un aviso sin contenido (ya vaciado) no tiene nada que procesar
      if (ev.payload) {
        for (const { event } of this.provider.parseStored(ev.payload, ev.receivedAt).events) {
          for (const m of event.messages) await this.conversations.ingestInbound(tx, ev.channelAccountId, m);
          for (const s of event.statuses) await this.conversations.applyStatus(tx, ev.channelAccountId, s);
        }
      }
      await tx.execute(sql`RELEASE SAVEPOINT webhook_event`);
    } catch (e) {
      failure = e;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT webhook_event`);
    }
    if (failure === null) {
      await tx.update(webhookEvents).set({ status: 'done', attempts, processedAt: now, lastError: null }).where(eq(webhookEvents.id, ev.id));
      return;
    }
    const label = errorLabel(failure);
    this.log.warn({ event_id: ev.id, attempts, err: label }, 'aviso de webhook no se pudo procesar');
    if (attempts >= EVENT_MAX_ATTEMPTS) {
      await tx.update(webhookEvents).set({ status: 'failed', attempts, processedAt: now, lastError: label }).where(eq(webhookEvents.id, ev.id));
    } else {
      const wait = Math.min(2 ** attempts * 7_500, MAX_BACKOFF_MS);
      await tx.update(webhookEvents).set({ attempts, lastError: label, nextAttemptAt: new Date(now.getTime() + wait) }).where(eq(webhookEvents.id, ev.id));
    }
  }

  /** Vacía el contenido de los avisos ya terminados con más de 30 días (minimización de datos personales): la fila queda como registro. */
  private async redactOld(tx: TenantTx, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - PAYLOAD_RETENTION_DAYS * 86_400_000);
    const old = await tx
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(and(isNotNull(webhookEvents.payload), ne(webhookEvents.status, 'pending'), lte(webhookEvents.processedAt, cutoff)))
      .limit(REDACT_BATCH);
    if (old.length === 0) return;
    await tx
      .update(webhookEvents)
      .set({ payload: null, redactedAt: now })
      .where(inArray(webhookEvents.id, old.map((r) => r.id)));
  }
}
