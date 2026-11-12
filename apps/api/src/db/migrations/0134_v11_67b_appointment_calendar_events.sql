CREATE TABLE "appointment_calendar_events" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"calendar_id" text,
	"event_id" text,
	"etag" text,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"seq" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"last_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_calendar_events_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "appointment_calendar_events_state_valid" CHECK ("appointment_calendar_events"."sync_state" IN ('pending', 'synced', 'failed', 'gone')),
	CONSTRAINT "appointment_calendar_events_error_len" CHECK ("appointment_calendar_events"."last_error" IS NULL OR length("appointment_calendar_events"."last_error") <= 300),
	CONSTRAINT "appointment_calendar_events_attempts_valid" CHECK ("appointment_calendar_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "appointment_calendar_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_calendar_events" ADD CONSTRAINT "appointment_calendar_events_appointment_fk" FOREIGN KEY ("organization_id","appointment_id") REFERENCES "public"."appointments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_calendar_events_appointment_uq" ON "appointment_calendar_events" USING btree ("organization_id","appointment_id");--> statement-breakpoint
CREATE INDEX "appointment_calendar_events_due_idx" ON "appointment_calendar_events" USING btree ("organization_id","sync_state","next_attempt_at");--> statement-breakpoint
CREATE POLICY "appointment_calendar_events_tenant_isolation" ON "appointment_calendar_events" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "appointment_calendar_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- v11 Pista G, 67b (ADR-67): tabla de NEGOCIO, solo app_rw, sin DELETE (el vínculo vive mientras viva la cita; el borrado de la empresa lo limpia la purga).
REVOKE ALL ON TABLE "appointment_calendar_events" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "appointment_calendar_events" TO "app_rw";
