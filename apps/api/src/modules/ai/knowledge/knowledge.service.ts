import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { agentDocuments, agents, Database, knowledgeDocuments, type TenantTx } from '../../../db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../../errors';
import { TenantContext } from '../../../tenant';
import { writeAudit } from '../../audit';
import { AttachmentsService, safeFilename, StorageError, StorageGateway } from '../../attachments';
import { AiPricingService } from '../../platform';
import { AiCreditsService } from '../ai-credits.service';
import { AiGateway, AiUnavailableError } from '../ai-gateway.service';
import { creditsFor } from '../credits';
import { detectKind, MAX_DOCUMENT_BYTES, type DocumentKind } from './document-parser';
import { MAX_CHUNKS_PER_ORG, VECTOR_STORE, type VectorStore } from './vector-store';

export const MAX_DOCUMENTS = 200;
/** Parecido mínimo para que un fragmento sirva de respaldo. Provisional: se calibra con la clave real de OpenAI (ADR-53, §5). */
export const MIN_SCORE = 0.3;
export const SEARCH_LIMIT_MAX = 10;

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'error';

export interface DocumentView {
  id: string;
  name: string;
  kind: DocumentKind;
  size_bytes: number;
  status: DocumentStatus;
  /** Por qué falló o por qué espera (`waiting`, `no_credits`, `empty`…). */
  error_code: string | null;
  error_message: string | null;
  active: boolean;
  chunk_count: number;
  created_at: string;
  updated_at: string;
  /** ¿Se puede reprocesar ahora? Los listos y los que fallaron. */
  can_reprocess: boolean;
}

export interface DocumentList {
  items: DocumentView[];
  next_cursor: string | null;
  limits: { max_bytes: number; max_documents: number; kinds: DocumentKind[]; chunks_used: number; chunks_max: number };
}

export interface SearchHitView {
  document: { id: string; name: string };
  content: string;
  score: number;
}

export interface SearchView {
  hits: SearchHitView[];
  /** Había más fragmentos de los que se recorren en una búsqueda: conviene acotar a un agente o a menos documentos. */
  truncated: boolean;
}

const view = (d: typeof knowledgeDocuments.$inferSelect): DocumentView => ({
  id: d.id,
  name: d.name,
  kind: d.kind as DocumentKind,
  size_bytes: d.sizeBytes,
  status: d.status as DocumentStatus,
  error_code: d.errorCode,
  error_message: d.errorMessage,
  active: d.active,
  chunk_count: d.chunkCount,
  created_at: d.createdAt.toISOString(),
  updated_at: d.updatedAt.toISOString(),
  can_reprocess: d.status === 'ready' || d.status === 'error' || (d.status === 'pending' && d.errorCode === 'waiting'),
});

/**
 * Biblioteca de conocimiento de la empresa (M8.2, ADR-53): subir, listar, activar, reprocesar, borrar y buscar. Todo bajo el TenantContext de la empresa (RLS). Un archivo se identifica por su CONTENIDO (firma),
 * se revisa con el antivirus (si hay), se guarda en `org/<empresa>/knowledge/<id>` y queda `pending`: la tarea lo procesa. Buscar vectoriza la pregunta (cuesta créditos, apenas uno) y devuelve los fragmentos
 * más parecidos con su documento; sin parecido suficiente devuelve lista vacía (la base de «no inventar»: sin respaldo no se afirma nada).
 */
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(AiGateway) private readonly ai: AiGateway,
    @Inject(AiCreditsService) private readonly credits: AiCreditsService,
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
    @Inject(VECTOR_STORE) private readonly store: VectorStore,
  ) {}

  async list(q: { limit?: number | undefined; cursor?: string | undefined } = {}): Promise<DocumentList> {
    const limit = q.limit ?? 50;
    const cur = this.decodeCursor(q.cursor);
    return this.db.withTenant(async (tx) => {
      const conds = [isNull(knowledgeDocuments.deletedAt), ...(cur ? [or(lt(knowledgeDocuments.createdAt, cur.at), and(eq(knowledgeDocuments.createdAt, cur.at), lt(knowledgeDocuments.id, cur.id)))!] : [])];
      const rows = await tx.select().from(knowledgeDocuments).where(and(...conds)).orderBy(desc(knowledgeDocuments.createdAt), desc(knowledgeDocuments.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(view),
        next_cursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
        limits: { max_bytes: MAX_DOCUMENT_BYTES, max_documents: MAX_DOCUMENTS, kinds: ['txt', 'csv', 'pdf', 'docx'], chunks_used: await this.store.count(tx), chunks_max: MAX_CHUNKS_PER_ORG },
      };
    });
  }

  /** Sube un documento. 413 si pesa de más, 415 si no es un tipo admitido, 422 si el antivirus lo bloquea, 409 si ya está subido, 503 sin almacenamiento. */
  async upload(input: { bytes: Buffer; filename: string | null }): Promise<DocumentView> {
    const { bytes } = input;
    if (bytes.length === 0) throw new AppError(400, 'DOCUMENT_EMPTY', 'El archivo está vacío');
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new AppError(413, 'DOCUMENT_TOO_LARGE', `El documento pesa demasiado: el máximo es ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`);
    const name = safeFilename(input.filename, 'documento');
    const kind = detectKind(bytes, name);
    if (!kind) throw new AppError(415, 'DOCUMENT_UNSUPPORTED', 'Ese tipo de archivo no se puede usar: sube un PDF, un Word (.docx), un texto (.txt) o una tabla (.csv)');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const organizationId = TenantContext.current().organizationId;
    const userId = TenantContext.current().userId ?? null;
    // Lo barato primero: duplicado y tope, antes de gastar antivirus y almacenamiento
    await this.db.withTenant(async (tx) => {
      const [dup] = await tx.select({ name: knowledgeDocuments.name }).from(knowledgeDocuments).where(and(eq(knowledgeDocuments.contentHash, hash), isNull(knowledgeDocuments.deletedAt))).limit(1);
      if (dup) throw new ConflictError('DOCUMENT_EXISTS', `Ese archivo ya está en la biblioteca como «${dup.name}»`);
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(knowledgeDocuments).where(isNull(knowledgeDocuments.deletedAt));
      if ((n?.n ?? 0) >= MAX_DOCUMENTS) throw new ConflictError('DOCUMENT_LIMIT', `La biblioteca llegó a su tope de ${MAX_DOCUMENTS} documentos: borra alguno para subir otro`);
    });
    if ((await this.attachments.scan(bytes)) === 'infected') throw new AppError(422, 'ATTACHMENT_INFECTED', 'El antivirus detectó un virus en el archivo: no se puede usar');
    const id = randomUUID();
    const key = `org/${organizationId}/knowledge/${id}`;
    try {
      await this.storage.put(key, bytes, 'application/octet-stream');
    } catch (e) {
      if (e instanceof StorageError) throw new AppError(503, e.code === 'not_configured' ? 'STORAGE_NOT_CONFIGURED' : 'STORAGE_UNAVAILABLE', e.message);
      throw e;
    }
    try {
      return await this.db.withTenant(async (tx) => {
        const [row] = await tx.insert(knowledgeDocuments).values({ name, kind, sizeBytes: bytes.length, contentHash: hash, storageKey: key, uploadedBy: userId, createdAt: new Date(), updatedAt: new Date(), nextAttemptAt: new Date() }).returning();
        await writeAudit(tx, { entityType: 'knowledge_document', entityId: row!.id, newValue: { name, kind, size_bytes: bytes.length }, source: 'manual' });
        return view(row!);
      });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined); // no queda un archivo sin documento
      if ((e as { code?: string; cause?: { code?: string } }).cause?.code === '23505') throw new ConflictError('DOCUMENT_EXISTS', 'Ese archivo ya está en la biblioteca');
      throw e;
    }
  }

  /** Activar o desactivar un documento y cambiar su nombre. */
  async update(id: string, patch: { active?: boolean | undefined; name?: string | undefined }): Promise<DocumentView> {
    return this.db.withTenant(async (tx) => {
      const d = await this.byId(tx, id);
      const set: Partial<typeof knowledgeDocuments.$inferInsert> = { updatedAt: new Date() };
      if (patch.active !== undefined) set.active = patch.active;
      if (patch.name !== undefined) set.name = safeFilename(patch.name, d.name);
      const [row] = await tx.update(knowledgeDocuments).set(set).where(eq(knowledgeDocuments.id, id)).returning();
      if (patch.active !== undefined && patch.active !== d.active) await writeAudit(tx, { entityType: 'knowledge_document', entityId: id, field: 'active', oldValue: d.active, newValue: patch.active, source: 'manual' });
      if (patch.name !== undefined && row!.name !== d.name) await writeAudit(tx, { entityType: 'knowledge_document', entityId: id, field: 'name', oldValue: d.name, newValue: row!.name, source: 'manual' });
      return view(row!);
    });
  }

  /** Vuelve a procesar un documento listo o fallido (por ejemplo, cuando ya hay créditos). Los fragmentos actuales se reemplazan solo cuando termina bien. */
  async reprocess(id: string): Promise<DocumentView> {
    return this.db.withTenant(async (tx) => {
      const d = await this.byId(tx, id);
      if (!view(d).can_reprocess) throw new ConflictError('DOCUMENT_BUSY', 'Este documento ya se está procesando');
      const [row] = await tx.update(knowledgeDocuments).set({ status: 'pending', errorCode: null, errorMessage: null, attempts: 0, nextAttemptAt: new Date(), processingStartedAt: null, updatedAt: new Date() }).where(eq(knowledgeDocuments.id, id)).returning();
      await writeAudit(tx, { entityType: 'knowledge_document', entityId: id, field: 'status', oldValue: d.status, newValue: 'pending', source: 'manual' });
      return view(row!);
    });
  }

  /** Borra el documento (borrado lógico), sus fragmentos y su archivo. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    const key = await this.db.withTenant(async (tx) => {
      const d = await this.byId(tx, id);
      await this.store.remove(tx, id);
      await tx.delete(agentDocuments).where(eq(agentDocuments.documentId, id)); // los agentes dejan de usarlo
      await tx.update(knowledgeDocuments).set({ deletedAt: new Date(), active: false, updatedAt: new Date() }).where(eq(knowledgeDocuments.id, id));
      await writeAudit(tx, { entityType: 'knowledge_document', entityId: id, field: 'deleted', oldValue: false, newValue: { deleted: true, name: d.name }, source: 'manual' });
      return d.storageKey;
    });
    await this.storage.delete(key).catch(() => undefined); // si el almacenamiento falla, queda un archivo huérfano pero el documento ya no existe
    return { id, deleted: true };
  }

  /**
   * Busca los fragmentos más parecidos a una pregunta. Cuesta créditos (vectorizar la pregunta, apenas uno) y por eso falla con 409 `AI_NO_CREDITS` sin saldo. `documentIds` limita la búsqueda a esos
   * documentos (los del agente, en M8.3); sin él, todos los activos y listos de la empresa. Los documentos de OTRA empresa nunca aparecen: la transacción es de la empresa del contexto.
   */
  async search(input: { query: string; limit?: number | undefined; documentIds?: readonly string[] | undefined; agentId?: string | undefined; kind?: 'use' | 'test' }): Promise<SearchView> {
    const query = input.query.trim();
    if (query.length === 0) throw new ValidationError([{ path: 'query', code: 'required', message: 'Escribe la pregunta' }]);
    const limit = Math.min(Math.max(input.limit ?? 5, 1), SEARCH_LIMIT_MAX);
    // Con un agente, solo cuentan SUS documentos (y si no existe, 404 antes de gastar nada)
    let documentIds = input.documentIds;
    if (input.agentId) {
      const agentId = input.agentId;
      documentIds = await this.db.withTenant(async (tx) => {
        const [a] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
        if (!a) throw new NotFoundError();
        return (await tx.select({ id: agentDocuments.documentId }).from(agentDocuments).where(eq(agentDocuments.agentId, agentId))).map((r) => r.id);
      });
    }
    const organizationId = TenantContext.current().organizationId;
    const [price, worstUsd] = await Promise.all([this.pricing.resolve(organizationId), this.ai.embeddingCostUsd(Math.ceil(query.length / 3))]);
    if (worstUsd === null) throw this.unavailable(new AiUnavailableError('failed', 'El precio del modelo de IA no está cargado'));
    const reserve = Math.max(1, creditsFor(worstUsd, price.marginPct, price.usdPerCredit));
    const { holdId } = await this.credits.reserve({ credits: reserve, kind: input.kind ?? 'test', ref: 'Búsqueda en la biblioteca' });
    let outcome;
    try {
      outcome = await this.ai.embed([query.slice(0, 2000)]);
    } catch (e) {
      await this.credits.release(holdId);
      throw this.unavailable(e);
    }
    await this.credits.settle(holdId, { costUsd: outcome.costUsd, ref: 'Búsqueda en la biblioteca' });
    return this.db.withTenant(async (tx) => {
      const { hits: found, truncated } = await this.store.search(tx, outcome.vectors[0]!, { documentIds, limit, minScore: MIN_SCORE });
      const names = found.length === 0 ? [] : await tx.select({ id: knowledgeDocuments.id, name: knowledgeDocuments.name }).from(knowledgeDocuments).where(inArray(knowledgeDocuments.id, [...new Set(found.map((h) => h.documentId))]));
      const byId = new Map(names.map((n) => [n.id, n.name]));
      return { hits: found.map((h): SearchHitView => ({ document: { id: h.documentId, name: byId.get(h.documentId) ?? '' }, content: h.content, score: Math.round(h.score * 1000) / 1000 })), truncated };
    });
  }

  /** Cómo contarle a la persona que la IA no está disponible. */
  private unavailable(e: unknown): unknown {
    if (!(e instanceof AiUnavailableError)) return e;
    if (e.code === 'not_configured') return new AppError(503, 'AI_NOT_CONFIGURED', 'El servicio de IA aún no está configurado. Avisa al administrador de la plataforma');
    if (e.code === 'busy') return new AppError(503, 'AI_BUSY', 'El servicio de IA está ocupado. Inténtalo en un momento');
    return new AppError(502, 'AI_UNAVAILABLE', 'El servicio de IA no está disponible por ahora');
  }

  private async byId(tx: TenantTx, id: string): Promise<typeof knowledgeDocuments.$inferSelect> {
    const [d] = await tx.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, id), isNull(knowledgeDocuments.deletedAt))).for('update').limit(1);
    if (!d) throw new NotFoundError();
    return d;
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }
}

