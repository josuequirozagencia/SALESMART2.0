import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { documentChunks, knowledgeDocuments, type TenantTx } from '../../../db';

/** Un fragmento encontrado por la búsqueda, con su parecido (coseno, de 0 a 1) con la pregunta. */
export interface VectorHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly content: string;
  readonly score: number;
}

export interface ChunkToStore {
  readonly ordinal: number;
  readonly content: string;
  readonly tokens: number;
  /** Vector tal como lo da el proveedor: el almacén lo normaliza. */
  readonly embedding: readonly number[];
}

export interface SearchOptions {
  /** Solo estos documentos (los del agente); sin esto, todos los activos de la empresa. */
  readonly documentIds?: readonly string[] | undefined;
  readonly limit: number;
  /** Parecido mínimo: por debajo, el fragmento no sirve de respaldo. */
  readonly minScore: number;
}

/**
 * Puerto de la base vectorial (M8, ADR-53, CLAUDE.md: `VectorStore`). Todo corre dentro de la transacción de la empresa (RLS), así que NUNCA se ve un fragmento de otra empresa. La implementación de hoy no
 * necesita ninguna extensión de PostgreSQL; cuando se verifique pgvector en CI y en Railway se cambia por otra que cumpla el mismo contrato (y el mismo contract test).
 */
export interface VectorStore {
  readonly kind: 'pg-array' | 'pgvector';
  /** Reemplaza TODOS los fragmentos de un documento (reprocesar). */
  replace(tx: TenantTx, documentId: string, chunks: readonly ChunkToStore[]): Promise<void>;
  /** Borra los fragmentos de un documento. */
  remove(tx: TenantTx, documentId: string): Promise<void>;
  /** Los fragmentos más parecidos a la pregunta, de mayor a menor. Solo cuenta documentos vigentes, activos y listos. `truncated`: había más fragmentos de los que se recorren (hay que acotar a menos documentos). */
  search(tx: TenantTx, query: readonly number[], options: SearchOptions): Promise<{ hits: VectorHit[]; truncated: boolean }>;
  /** Cuántos fragmentos tiene la empresa (para el tope). */
  count(tx: TenantTx, exceptDocumentId?: string): Promise<number>;
}

export const VECTOR_STORE = Symbol('VECTOR_STORE');

/** Tope de fragmentos que se recorren en UNA búsqueda y que puede tener un agente entre todos sus documentos (ADR-53: unos 5 000). Pasado esto, la búsqueda por fuerza bruta deja de ser razonable y hay que pasar a pgvector. */
export const MAX_CHUNKS_PER_AGENT = 5000;
/** Tope de fragmentos de TODA la biblioteca de una empresa (M8.3: el tope por agente pasó a ser el de arriba; este solo acota el almacenamiento). */
export const MAX_CHUNKS_PER_ORG = 50_000;
const INSERT_BATCH = 100;

/** El vector como float32 en bruto (lo que se guarda en la base). */
export function toBytes(v: readonly number[]): Buffer {
  const f = Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/** El vector guardado, como float32 (sin copiar cuando el búfer está alineado a 4 bytes; si no, se copia). */
export function fromBytes(b: Buffer): Float32Array {
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** Normaliza a largo 1 (así el coseno es el producto punto). Un vector de ceros se deja tal cual (su parecido con todo es 0). */
export function normalize(v: readonly number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm === 0 ? [...v] : v.map((x) => x / norm);
}

/**
 * Base vectorial SIN extensión (ADR-53, decisión 2): el vector vive en una columna `real[]` y la similitud se calcula en el servidor sobre los fragmentos de los documentos permitidos de ESA empresa. Pensada
 * para bibliotecas de hasta `MAX_CHUNKS_PER_ORG` fragmentos.
 */
export class PgArrayVectorStore implements VectorStore {
  readonly kind = 'pg-array' as const;

  async replace(tx: TenantTx, documentId: string, chunks: readonly ChunkToStore[]): Promise<void> {
    await this.remove(tx, documentId);
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      await tx.insert(documentChunks).values(chunks.slice(i, i + INSERT_BATCH).map((c) => ({ documentId, ordinal: c.ordinal, content: c.content, tokens: c.tokens, embedding: toBytes(normalize(c.embedding)) })));
    }
  }

  async remove(tx: TenantTx, documentId: string): Promise<void> {
    await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  }

  async search(tx: TenantTx, query: readonly number[], options: SearchOptions): Promise<{ hits: VectorHit[]; truncated: boolean }> {
    if (options.documentIds && options.documentIds.length === 0) return { hits: [], truncated: false };
    const q = Float32Array.from(normalize(query));
    const rows = await tx
      .select({ id: documentChunks.id, documentId: documentChunks.documentId, ordinal: documentChunks.ordinal, content: documentChunks.content, embedding: documentChunks.embedding })
      .from(documentChunks)
      .innerJoin(knowledgeDocuments, and(eq(knowledgeDocuments.id, documentChunks.documentId), eq(knowledgeDocuments.organizationId, documentChunks.organizationId)))
      .where(and(isNull(knowledgeDocuments.deletedAt), eq(knowledgeDocuments.active, true), eq(knowledgeDocuments.status, 'ready'), options.documentIds ? inArray(knowledgeDocuments.id, [...options.documentIds]) : undefined))
      .limit(MAX_CHUNKS_PER_AGENT + 1);
    const truncated = rows.length > MAX_CHUNKS_PER_AGENT;
    const hits: VectorHit[] = [];
    for (const r of rows.slice(0, MAX_CHUNKS_PER_AGENT)) {
      const e = fromBytes(r.embedding);
      if (e.length !== q.length) continue; // un vector de otra dimensión (modelo anterior) no se compara
      let dot = 0;
      for (let i = 0; i < e.length; i++) dot += e[i]! * q[i]!;
      if (dot >= options.minScore) hits.push({ chunkId: r.id, documentId: r.documentId, ordinal: r.ordinal, content: r.content, score: dot });
    }
    hits.sort((a, b) => b.score - a.score || a.ordinal - b.ordinal);
    return { hits: hits.slice(0, options.limit), truncated };
  }

  async count(tx: TenantTx, exceptDocumentId?: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(documentChunks).where(exceptDocumentId ? ne(documentChunks.documentId, exceptDocumentId) : undefined);
    return r?.n ?? 0;
  }
}
