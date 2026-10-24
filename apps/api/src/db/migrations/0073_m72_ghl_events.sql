CREATE TABLE "ghl_contact_links" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ghl_contact_links_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ghl_contact_links_ghl_id_shape" CHECK (length("ghl_contact_links"."ghl_contact_id") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "ghl_contact_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ghl_events" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_type" text NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"note" text,
	"contact_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "ghl_events_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ghl_events_type_valid" CHECK ("ghl_events"."event_type" IN ('contact', 'message_in')),
	CONSTRAINT "ghl_events_status_valid" CHECK ("ghl_events"."status" IN ('pending', 'done', 'skipped', 'failed')),
	CONSTRAINT "ghl_events_outcome_valid" CHECK ("ghl_events"."outcome" IS NULL OR "ghl_events"."outcome" IN ('contact_created', 'contact_linked', 'contact_updated', 'contact_unchanged')),
	CONSTRAINT "ghl_events_ghl_contact_shape" CHECK (length("ghl_events"."ghl_contact_id") BETWEEN 1 AND 100),
	CONSTRAINT "ghl_events_dedupe_shape" CHECK (length("ghl_events"."dedupe_key") BETWEEN 1 AND 200),
	CONSTRAINT "ghl_events_attempts_valid" CHECK ("ghl_events"."attempts" >= 0),
	CONSTRAINT "ghl_events_note_len" CHECK ("ghl_events"."note" IS NULL OR length("ghl_events"."note") <= 200),
	CONSTRAINT "ghl_events_error_len" CHECK ("ghl_events"."last_error" IS NULL OR length("ghl_events"."last_error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "ghl_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ghl_contact_links" ADD CONSTRAINT "ghl_contact_links_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ghl_events" ADD CONSTRAINT "ghl_events_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ghl_contact_links_ghl_uq" ON "ghl_contact_links" USING btree ("organization_id","ghl_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ghl_contact_links_contact_uq" ON "ghl_contact_links" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ghl_events_org_dedupe_uq" ON "ghl_events" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "ghl_events_due_idx" ON "ghl_events" USING btree ("organization_id","next_attempt_at") WHERE "ghl_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ghl_events_recent_idx" ON "ghl_events" USING btree ("organization_id","received_at","id");--> statement-breakpoint
CREATE INDEX "ghl_events_redact_idx" ON "ghl_events" USING btree ("organization_id","processed_at") WHERE "ghl_events"."payload" IS NOT NULL AND "ghl_events"."status" <> 'pending';--> statement-breakpoint
CREATE POLICY "ghl_contact_links_tenant_isolation" ON "ghl_contact_links" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "ghl_events_tenant_isolation" ON "ghl_events" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ghl_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ghl_contact_links" FORCE ROW LEVEL SECURITY;
