CREATE TABLE "agent_channels" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_channels_pk" PRIMARY KEY("organization_id","agent_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "agent_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_documents" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"agent_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_documents_pk" PRIMARY KEY("organization_id","agent_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "agent_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agents" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"photo_key" text,
	"cover" text DEFAULT 'violet' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"temperature" numeric(3, 2) DEFAULT '0.30' NOT NULL,
	"max_tokens" integer DEFAULT 500 NOT NULL,
	"max_chars" integer DEFAULT 800 NOT NULL,
	"personality" text DEFAULT '' NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"extra_info" text DEFAULT '' NOT NULL,
	"show_source" boolean DEFAULT false NOT NULL,
	"split_enabled" boolean DEFAULT false NOT NULL,
	"split_blocks" integer DEFAULT 2 NOT NULL,
	"transfer_enabled" boolean DEFAULT true NOT NULL,
	"transfer_queue_id" uuid,
	"always_on" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agents_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "agents_name_shape" CHECK (length(btrim("agents"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "agents_role_len" CHECK ("agents"."role" IS NULL OR length("agents"."role") <= 120),
	CONSTRAINT "agents_cover_valid" CHECK ("agents"."cover" IN ('violet', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'slate')),
	CONSTRAINT "agents_model_shape" CHECK ("agents"."model" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
	CONSTRAINT "agents_temperature_valid" CHECK ("agents"."temperature" >= 0 AND "agents"."temperature" <= 1.5),
	CONSTRAINT "agents_max_tokens_valid" CHECK ("agents"."max_tokens" BETWEEN 100 AND 2000),
	CONSTRAINT "agents_max_chars_valid" CHECK ("agents"."max_chars" BETWEEN 100 AND 4000),
	CONSTRAINT "agents_blocks_valid" CHECK ("agents"."split_blocks" BETWEEN 1 AND 5),
	CONSTRAINT "agents_texts_len" CHECK (length("agents"."personality") <= 4000 AND length("agents"."objective") <= 4000 AND length("agents"."extra_info") <= 8000)
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."knowledge_documents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_transfer_queue_fk" FOREIGN KEY ("organization_id","transfer_queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_channels_channel_uq" ON "agent_channels" USING btree ("organization_id","channel_id");--> statement-breakpoint
CREATE INDEX "agent_documents_document_idx" ON "agent_documents" USING btree ("organization_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_uq" ON "agents" USING btree ("organization_id",lower("name")) WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_list_idx" ON "agents" USING btree ("organization_id","created_at","id") WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE POLICY "agent_channels_tenant_isolation" ON "agent_channels" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "agent_documents_tenant_isolation" ON "agent_documents" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "agents_tenant_isolation" ON "agents" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_channels" FORCE ROW LEVEL SECURITY;
