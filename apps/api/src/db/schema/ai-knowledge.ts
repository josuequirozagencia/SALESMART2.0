import { sql } from 'drizzle-orm';
import { boolean, check, customType, foreignKey, index, integer, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { platformTable, tenantTable } from './helpers';
import { users } from './identity';

/** Columna binaria (bytea): el vector se guarda como float32 en bruto; leerlo así es ≈ 15 veces más rápido que un `real[]` (medido con 5 000 fragmentos de 512 dimensiones: 0,25 s contra 3,6 s). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Documento de la biblioteca de conocimiento de la empresa (M8.2, ADR-53). Se sube al almacenamiento privado (`storage_key`), una tarea lo parsea, lo parte en fragmentos y calcula sus embeddings. Estados:
 * `pending` (por procesar) → `processing` → `ready` | `error` (con `error_code` y un mensaje visible; «reprocesar» lo vuelve a `pending`). `active` decide si el agente puede usarlo. Borrado lógico. El mismo
 * contenido no se sube dos veces (huella SHA-256 única por empresa entre los vigentes).
 */
export const knowledgeDocuments = tenantTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentHash: text('content_hash').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').notNull().default('pending'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    active: boolean('active').notNull().default(true),
    chunkCount: integer('chunk_count').notNull().default(0),
    charCount: integer('char_count').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    processingStartedAt: ts('processing_started_at'),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('knowledge_documents_kind_valid', sql`${t['kind']!} IN ('txt', 'csv', 'pdf', 'docx')`),
    check('knowledge_documents_status_valid', sql`${t['status']!} IN ('pending', 'processing', 'ready', 'error')`),
    check('knowledge_documents_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 200`),
    check('knowledge_documents_size_valid', sql`${t['sizeBytes']!} > 0`),
    check('knowledge_documents_hash_shape', sql`${t['contentHash']!} ~ '^[0-9a-f]{64}$'`),
    check('knowledge_documents_counts_valid', sql`${t['chunkCount']!} >= 0 AND ${t['charCount']!} >= 0 AND ${t['attempts']!} >= 0`),
    check('knowledge_documents_error_len', sql`${t['errorMessage']!} IS NULL OR length(${t['errorMessage']!}) <= 300`),
    uniqueIndex('knowledge_documents_hash_uq').on(t['organizationId']!, t['contentHash']!).where(sql`${t['deletedAt']!} IS NULL`),
    index('knowledge_documents_due_idx').on(t['organizationId']!, t['nextAttemptAt']!).where(sql`${t['status']!} IN ('pending', 'processing') AND ${t['deletedAt']!} IS NULL`),
    index('knowledge_documents_list_idx').on(t['organizationId']!, t['createdAt']!, t['id']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Fragmento de un documento con su vector (M8.2). El vector se guarda como float32 en bruto (`bytea`) y ya viene NORMALIZADO (largo 1), así que la similitud coseno es el producto punto. Se reescribe entero al reprocesar el documento (por eso app_rw puede
 * borrar aquí: son datos derivados). Siempre acotado por empresa (RLS) y, al buscar, por los documentos permitidos.
 */
export const documentChunks = tenantTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    documentId: uuid('document_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    content: text('content').notNull(),
    tokens: integer('tokens').notNull().default(0),
    embedding: bytea('embedding').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'document_chunks_document_fk', columns: [t['organizationId']!, t['documentId']!], foreignColumns: [knowledgeDocuments.organizationId, knowledgeDocuments.id] }),
    check('document_chunks_content_shape', sql`length(${t['content']!}) BETWEEN 1 AND 4000`),
    check('document_chunks_ordinal_valid', sql`${t['ordinal']!} >= 0`),
    check('document_chunks_embedding_len', sql`length(${t['embedding']!}) % 4 = 0 AND length(${t['embedding']!}) BETWEEN 32 AND 12288`), // 8 a 3072 dimensiones de 4 bytes
    uniqueIndex('document_chunks_doc_ordinal_uq').on(t['organizationId']!, t['documentId']!, t['ordinal']!),
  ],
);

/**
 * Precio de los modelos de IA (M8.2, tabla de PLATAFORMA: solo `app_platform`): dólares por millón de tokens de entrada y de salida. Valores de EJEMPLO hasta que el Súper Admin cargue los reales. El costo real de una
 * llamada sale de aquí y de los tokens que informa el proveedor; el cliente jamás lo ve.
 */
export const aiModelPrices = platformTable(
  'ai_model_prices',
  {
    model: text('model').primaryKey(),
    kind: text('kind').notNull(),
    usdPer1mInput: numeric('usd_per_1m_input', { precision: 12, scale: 6 }).notNull(),
    usdPer1mOutput: numeric('usd_per_1m_output', { precision: 12, scale: 6 }).notNull().default('0'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('ai_model_prices_model_shape', sql`${t.model} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'`),
    check('ai_model_prices_kind_valid', sql`${t.kind} IN ('embedding', 'chat')`),
    check('ai_model_prices_price_valid', sql`${t.usdPer1mInput} >= 0 AND ${t.usdPer1mInput} <= 10000 AND ${t.usdPer1mOutput} >= 0 AND ${t.usdPer1mOutput} <= 10000`),
  ],
);
