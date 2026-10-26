CREATE TABLE "ai_model_prices" (
	"model" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"usd_per_1m_input" numeric(12, 6) NOT NULL,
	"usd_per_1m_output" numeric(12, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "ai_model_prices_model_shape" CHECK ("ai_model_prices"."model" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
	CONSTRAINT "ai_model_prices_kind_valid" CHECK ("ai_model_prices"."kind" IN ('embedding', 'chat')),
	CONSTRAINT "ai_model_prices_price_valid" CHECK ("ai_model_prices"."usd_per_1m_input" >= 0 AND "ai_model_prices"."usd_per_1m_input" <= 10000 AND "ai_model_prices"."usd_per_1m_output" >= 0 AND "ai_model_prices"."usd_per_1m_output" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"embedding" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunks_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "document_chunks_content_shape" CHECK (length("document_chunks"."content") BETWEEN 1 AND 4000),
	CONSTRAINT "document_chunks_ordinal_valid" CHECK ("document_chunks"."ordinal" >= 0),
	CONSTRAINT "document_chunks_embedding_len" CHECK (length("document_chunks"."embedding") % 4 = 0 AND length("document_chunks"."embedding") BETWEEN 32 AND 12288)
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_message" text,
	"active" boolean DEFAULT true NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "knowledge_documents_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "knowledge_documents_kind_valid" CHECK ("knowledge_documents"."kind" IN ('txt', 'csv', 'pdf', 'docx')),
	CONSTRAINT "knowledge_documents_status_valid" CHECK ("knowledge_documents"."status" IN ('pending', 'processing', 'ready', 'error')),
	CONSTRAINT "knowledge_documents_name_shape" CHECK (length(btrim("knowledge_documents"."name")) BETWEEN 1 AND 200),
	CONSTRAINT "knowledge_documents_size_valid" CHECK ("knowledge_documents"."size_bytes" > 0),
	CONSTRAINT "knowledge_documents_hash_shape" CHECK ("knowledge_documents"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_documents_counts_valid" CHECK ("knowledge_documents"."chunk_count" >= 0 AND "knowledge_documents"."char_count" >= 0 AND "knowledge_documents"."attempts" >= 0),
	CONSTRAINT "knowledge_documents_error_len" CHECK ("knowledge_documents"."error_message" IS NULL OR length("knowledge_documents"."error_message") <= 300)
);
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."knowledge_documents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_doc_ordinal_uq" ON "document_chunks" USING btree ("organization_id","document_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_hash_uq" ON "knowledge_documents" USING btree ("organization_id","content_hash") WHERE "knowledge_documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "knowledge_documents_due_idx" ON "knowledge_documents" USING btree ("organization_id","next_attempt_at") WHERE "knowledge_documents"."status" IN ('pending', 'processing') AND "knowledge_documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "knowledge_documents_list_idx" ON "knowledge_documents" USING btree ("organization_id","created_at","id") WHERE "knowledge_documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE POLICY "document_chunks_tenant_isolation" ON "document_chunks" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "knowledge_documents_tenant_isolation" ON "knowledge_documents" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "knowledge_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Precios de EJEMPLO de los modelos (dólares por millón de tokens); el Súper Admin carga los reales desde Créditos IA.
INSERT INTO "ai_model_prices" ("model", "kind", "usd_per_1m_input", "usd_per_1m_output") VALUES
  ('text-embedding-3-small', 'embedding', 0.02, 0),
  ('gpt-4o-mini', 'chat', 0.15, 0.60);
