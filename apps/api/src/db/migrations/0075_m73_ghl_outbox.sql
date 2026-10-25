CREATE TABLE "ghl_outbox" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid,
	"op" text NOT NULL,
	"tag_name" text NOT NULL,
	"tag_kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "ghl_outbox_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ghl_outbox_op_valid" CHECK ("ghl_outbox"."op" IN ('tag_add', 'tag_remove', 'tag_delete')),
	CONSTRAINT "ghl_outbox_contact_by_op" CHECK (("ghl_outbox"."op" = 'tag_delete' AND "ghl_outbox"."contact_id" IS NULL) OR ("ghl_outbox"."op" <> 'tag_delete' AND "ghl_outbox"."contact_id" IS NOT NULL)),
	CONSTRAINT "ghl_outbox_kind_valid" CHECK ("ghl_outbox"."tag_kind" IN ('system', 'custom')),
	CONSTRAINT "ghl_outbox_status_valid" CHECK ("ghl_outbox"."status" IN ('pending', 'done', 'skipped', 'failed')),
	CONSTRAINT "ghl_outbox_tag_shape" CHECK (length(btrim("ghl_outbox"."tag_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ghl_outbox_attempts_valid" CHECK ("ghl_outbox"."attempts" >= 0),
	CONSTRAINT "ghl_outbox_note_len" CHECK ("ghl_outbox"."note" IS NULL OR length("ghl_outbox"."note") <= 200),
	CONSTRAINT "ghl_outbox_error_len" CHECK ("ghl_outbox"."last_error" IS NULL OR length("ghl_outbox"."last_error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "ghl_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ghl_contact_links" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "ghl_contact_links" ADD COLUMN "tags_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ghl_outbox" ADD CONSTRAINT "ghl_outbox_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ghl_outbox_due_idx" ON "ghl_outbox" USING btree ("organization_id","next_attempt_at") WHERE "ghl_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ghl_outbox_contact_idx" ON "ghl_outbox" USING btree ("organization_id","contact_id","created_at","id") WHERE "ghl_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ghl_outbox_recent_idx" ON "ghl_outbox" USING btree ("organization_id","created_at","id");--> statement-breakpoint
ALTER TABLE "ghl_contact_links" ADD CONSTRAINT "ghl_contact_links_tags_array" CHECK ("ghl_contact_links"."tags" IS NULL OR jsonb_typeof("ghl_contact_links"."tags") = 'array');--> statement-breakpoint
CREATE POLICY "ghl_outbox_tenant_isolation" ON "ghl_outbox" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ghl_outbox" FORCE ROW LEVEL SECURITY;
