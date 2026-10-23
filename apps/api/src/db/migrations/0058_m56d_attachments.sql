CREATE TABLE "message_attachments" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"filename" text,
	"size_bytes" integer,
	"storage_key" text,
	"checksum" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"source_media_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "message_attachments_direction_valid" CHECK ("message_attachments"."direction" IN ('in', 'out')),
	CONSTRAINT "message_attachments_kind_valid" CHECK ("message_attachments"."kind" IN ('image', 'video', 'audio', 'document', 'sticker')),
	CONSTRAINT "message_attachments_state_valid" CHECK ("message_attachments"."state" IN ('pending', 'ready', 'infected', 'failed', 'expired')),
	CONSTRAINT "message_attachments_scan_valid" CHECK ("message_attachments"."scan_status" IN ('pending', 'clean', 'skipped', 'infected', 'error')),
	CONSTRAINT "message_attachments_size_valid" CHECK ("message_attachments"."size_bytes" IS NULL OR "message_attachments"."size_bytes" BETWEEN 0 AND 104857600),
	CONSTRAINT "message_attachments_mime_shape" CHECK (length("message_attachments"."mime_type") BETWEEN 3 AND 127),
	CONSTRAINT "message_attachments_filename_len" CHECK ("message_attachments"."filename" IS NULL OR length("message_attachments"."filename") BETWEEN 1 AND 200),
	CONSTRAINT "message_attachments_error_len" CHECK ("message_attachments"."error" IS NULL OR length("message_attachments"."error") <= 300),
	CONSTRAINT "message_attachments_attempts_valid" CHECK ("message_attachments"."attempts" >= 0),
	CONSTRAINT "message_attachments_ready_complete" CHECK ("message_attachments"."state" <> 'ready' OR ("message_attachments"."storage_key" IS NOT NULL AND "message_attachments"."size_bytes" IS NOT NULL AND "message_attachments"."scan_status" IN ('clean', 'skipped'))),
	CONSTRAINT "message_attachments_infected_consistent" CHECK (("message_attachments"."state" = 'infected') = ("message_attachments"."scan_status" = 'infected'))
);
--> statement-breakpoint
ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_message_uq" ON "message_attachments" USING btree ("organization_id","message_id") WHERE "message_attachments"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_attachments_conversation_idx" ON "message_attachments" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "message_attachments_pending_in_idx" ON "message_attachments" USING btree ("organization_id","next_attempt_at") WHERE "message_attachments"."direction" = 'in' AND "message_attachments"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "message_attachments_orphan_out_idx" ON "message_attachments" USING btree ("organization_id","created_at") WHERE "message_attachments"."direction" = 'out' AND "message_attachments"."message_id" IS NULL AND "message_attachments"."state" = 'ready';--> statement-breakpoint
CREATE POLICY "message_attachments_tenant_isolation" ON "message_attachments" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "message_attachments" FORCE ROW LEVEL SECURITY;
