import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { Database, knowledgeDocuments } from '../../../db';
import type { AppLogger } from '../../../logger';
import { TenantContext } from '../../../tenant';
import { APP_LOGGER } from '../../../tokens';
import { writeAudit } from '../../audit';
import { StorageError, StorageGateway } from '../../attachments';
import { AiModelPricesService, AiPricingService } from '../../platform';
import { AiCreditsService } from '../ai-credits.service';
import { AiGateway, AiUnavailableError, EMBEDDING_MODEL } from '../ai-gateway.service';
import { creditsFor } from '../credits';
import { estimateTokens } from './chunker';
import { parseDocument, ParseError, type DocumentKind } from './document-parser';
import { MAX_CHUNKS_PER_AGENT, MAX_CHUNKS_PER_ORG, VECTOR_STORE, type VectorStore } from './vector-store';

export const KNOWLEDGE_BATCH = 3;
export const KNOWLEDGE_MAX_ATTEMPTS = 5;
/** Un documento «procesando» más de este tiempo se da por colgado (el proceso murió) y se retoma. */
export const KNOWLEDGE_LEASE_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const WAIT_FOR_AI_MS = 60_000;

type DocRow = typeof knowledgeDocuments.$inferSelect;

/**
 * Procesa los documentos de la biblioteca (M8.2, ADR-53): lee el archivo del almacenamiento, lo parte en fragmentos, vectoriza y guarda. Corre en el TenantContext de la empresa (la tarea recorre las empresas).
 * Paso a paso, y cada paso fuera de una transacción larga: tomar el documento (`SKIP LOCKED`, con arrendamiento de 10 min) → leer y parsear → comprobar el tope de fragmentos → RESERVAR créditos (el peor caso)
 * → vectorizar → guardar fragmentos y marcar «listo» en UNA transacción → LIQUIDAR lo realmente gastado. Cualquier fallo libera la reserva. Los errores definitivos (archivo ilegible, sin créditos, tope) dejan el
 * documento en `error` con su motivo (la persona lo ve y puede «reprocesar»); los pasajeros reintentan con espera creciente; sin clave de IA en la plataforma el documento ESPERA sin gastar intentos.
 */
@Injectable()
export class KnowledgeProcessorService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(AiGateway) private readonly ai: AiGateway,
    @Inject(AiCreditsService) private readonly credits: AiCreditsService,
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
    @Inject(AiModelPricesService) private readonly prices: AiModelPricesService,
    @Inject(VECTOR_STORE) private readonly store: VectorStore,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Procesa los documentos pendientes de la empresa del contexto. Devuelve cuántos tocó. */
  async runDue(now: Date, batch = KNOWLEDGE_BATCH): Promise<number> {
    let touched = 0;
    for (let i = 0; i < batch; i++) {
      const doc = await this.claim(now);
      if (!doc) break;
      touched += 1;
      await this.process(doc, now);
    }
    return touched;
  }

  /** Toma el siguiente documento: pendiente cuya hora llegó, o «procesando» con el arrendamiento vencido. */
  private claim(now: Date): Promise<DocRow | null> {
    return this.db.withTenant(async (tx) => {
      const [d] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(isNull(knowledgeDocuments.deletedAt), or(and(eq(knowledgeDocuments.status, 'pending'), lte(knowledgeDocuments.nextAttemptAt, now)), and(eq(knowledgeDocuments.status, 'processing'), lt(knowledgeDocuments.processingStartedAt, new Date(now.getTime() - KNOWLEDGE_LEASE_MS))))))
        .orderBy(asc(knowledgeDocuments.createdAt), asc(knowledgeDocuments.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!d) return null;
      const [taken] = await tx
        .update(knowledgeDocuments)
        .set({ status: 'processing', processingStartedAt: now, attempts: sql`${knowledgeDocuments.attempts} + 1`, updatedAt: now })
        .where(eq(knowledgeDocuments.id, d.id))
        .returning();
      return taken ?? null;
    });
  }

  private async process(doc: DocRow, now: Date): Promise<void> {
    let holdId: string | null = null;
    try {
      // 1) El archivo y su texto (fuera de toda transacción)
      const bytes = await this.storage.get(doc.storageKey);
      const parsed = await parseDocument(doc.kind as DocumentKind, bytes);
      // 2) Los topes de fragmentos: un documento no puede pasar del tope de un agente (si no, ningún agente podría usarlo entero) y la biblioteca tiene un tope total
      if (parsed.chunks.length > MAX_CHUNKS_PER_AGENT) throw new LimitError(`El documento es demasiado largo (${parsed.chunks.length.toLocaleString('es-EC')} fragmentos; el máximo es ${MAX_CHUNKS_PER_AGENT.toLocaleString('es-EC')}): divídelo en varios`);
      const others = await this.db.withTenant((tx) => this.store.count(tx, doc.id));
      if (others + parsed.chunks.length > MAX_CHUNKS_PER_ORG) throw new LimitError(`La biblioteca llegó a su tope de ${MAX_CHUNKS_PER_ORG.toLocaleString('es-EC')} fragmentos: borra documentos que ya no uses`);
      // 3) Reservar créditos (el peor caso) ANTES de gastar
      const reserve = await this.worstCaseCredits(parsed.chars);
      holdId = (await this.credits.reserve({ credits: reserve, kind: 'use', ref: `Documento: ${doc.name}` })).holdId;
      // 4) Vectorizar
      const embedded = await this.ai.embed(parsed.chunks);
      // 5) Guardar los fragmentos y marcar «listo» (una transacción)
      const done = new Date();
      await this.db.withTenant(async (tx) => {
        await this.store.replace(tx, doc.id, parsed.chunks.map((content, i) => ({ ordinal: i, content, tokens: estimateTokens(content.length), embedding: embedded.vectors[i]! })));
        await tx
          .update(knowledgeDocuments)
          .set({ status: 'ready', errorCode: null, errorMessage: null, chunkCount: parsed.chunks.length, charCount: parsed.chars, processingStartedAt: null, updatedAt: done })
          .where(eq(knowledgeDocuments.id, doc.id));
        await writeAudit(tx, { entityType: 'knowledge_document', entityId: doc.id, field: 'status', oldValue: doc.status, newValue: 'ready', source: 'automation' });
      });
      // 6) Cobrar lo realmente gastado (si esto fallara, la reserva vence sola y no se cobra)
      await this.credits.settle(holdId, { costUsd: embedded.costUsd, ref: `Documento: ${doc.name}` }).catch((e: unknown) => this.log.error({ err: e, document_id: doc.id }, 'no se pudo cobrar el procesamiento de un documento'));
      holdId = null;
    } catch (e) {
      if (holdId) await this.credits.release(holdId).catch(() => undefined);
      await this.fail(doc, e, now);
    }
  }

  /** Créditos del peor caso para vectorizar `chars` caracteres (se estima por exceso: 1 token ≈ 3 caracteres). */
  private async worstCaseCredits(chars: number): Promise<number> {
    const organizationId = TenantContext.current().organizationId;
    const [price, model] = await Promise.all([this.pricing.resolve(organizationId), this.prices.price(EMBEDDING_MODEL)]);
    if (!model) throw new AiUnavailableError('failed', 'El precio del modelo de IA no está cargado');
    const usd = (estimateTokens(chars) * model.usdPer1mInput) / 1_000_000;
    return Math.max(1, creditsFor(usd, price.marginPct, price.usdPerCredit));
  }

  /** Lo que pasa cuando algo falla: error definitivo con su motivo, espera, o reintento con espera creciente. */
  private async fail(doc: DocRow, e: unknown, now: Date): Promise<void> {
    const attempts = doc.attempts; // `claim` ya sumó este intento y `doc` es la fila devuelta por esa actualización
    const settle = (patch: Partial<typeof knowledgeDocuments.$inferInsert>) =>
      this.db.withTenant(async (tx) => {
        await tx.update(knowledgeDocuments).set({ processingStartedAt: null, updatedAt: new Date(), ...patch }).where(eq(knowledgeDocuments.id, doc.id));
        if (patch.status === 'error') await writeAudit(tx, { entityType: 'knowledge_document', entityId: doc.id, field: 'status', oldValue: doc.status, newValue: 'error', source: 'automation' });
      });
    const definitive = (code: string, message: string) => settle({ status: 'error', errorCode: code, errorMessage: message.slice(0, 300) });
    const retry = (code: string, message: string) => {
      if (attempts >= KNOWLEDGE_MAX_ATTEMPTS) return definitive(code, message);
      return settle({ status: 'pending', errorCode: null, errorMessage: null, nextAttemptAt: new Date(now.getTime() + Math.min(2 ** attempts * 15_000, MAX_BACKOFF_MS)) });
    };
    if (e instanceof ParseError) return definitive(e.code, e.message);
    if (e instanceof LimitError) return definitive('limit', e.message);
    if (e instanceof StorageError) {
      if (e.code === 'not_found') return definitive('storage_missing', 'El archivo ya no está guardado: súbelo de nuevo');
      return retry('storage', 'El almacenamiento de archivos no respondió');
    }
    if (e instanceof AiUnavailableError) {
      if (e.code === 'not_configured') return settle({ status: 'pending', attempts: Math.max(doc.attempts - 1, 0), errorCode: 'waiting', errorMessage: 'Esperando a que el servicio de IA esté configurado', nextAttemptAt: new Date(now.getTime() + WAIT_FOR_AI_MS) });
      if (e.code === 'rejected') return definitive('ai_unavailable', 'El servicio de IA no está disponible por ahora. Inténtalo más tarde con «Reprocesar»');
      if (e.code === 'busy') return retry('ai_busy', 'El servicio de IA está ocupado');
      return definitive('ai_failed', 'El servicio de IA no pudo procesar el documento');
    }
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'AI_NO_CREDITS') return definitive('no_credits', 'No hay créditos suficientes para procesar este documento. Cuando haya saldo, usa «Reprocesar»');
    // Un fallo que no esperábamos: se registra SIN el contenido y se reintenta unas veces antes de rendirse
    this.log.error({ err: e, document_id: doc.id }, 'fallo inesperado al procesar un documento');
    return retry('internal', 'No se pudo procesar el documento por un fallo interno');
  }
}

class LimitError extends Error {}
