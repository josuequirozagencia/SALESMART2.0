CREATE TABLE "appointment_reminders" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"offset_minutes" integer NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"via" text,
	"message_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "appointment_reminders_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "appointment_reminders_status_valid" CHECK ("appointment_reminders"."status" IN ('scheduled', 'sent', 'skipped', 'failed', 'cancelled')),
	CONSTRAINT "appointment_reminders_via_valid" CHECK ("appointment_reminders"."via" IS NULL OR "appointment_reminders"."via" IN ('text', 'template')),
	CONSTRAINT "appointment_reminders_offset_valid" CHECK ("appointment_reminders"."offset_minutes" BETWEEN 1 AND 43200),
	CONSTRAINT "appointment_reminders_reason_len" CHECK ("appointment_reminders"."reason" IS NULL OR length("appointment_reminders"."reason") <= 60),
	CONSTRAINT "appointment_reminders_resolved_consistent" CHECK (("appointment_reminders"."status" = 'scheduled') = ("appointment_reminders"."resolved_at" IS NULL)),
	CONSTRAINT "appointment_reminders_sent_complete" CHECK ("appointment_reminders"."status" <> 'sent' OR ("appointment_reminders"."message_id" IS NOT NULL AND "appointment_reminders"."via" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "appointment_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointments" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"opportunity_id" uuid,
	"owner_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"kind" text DEFAULT 'Cita' NOT NULL,
	"notes" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"reminder_offsets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminder_template_id" uuid,
	"reminder_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "appointments_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "appointments_status_valid" CHECK ("appointments"."status" IN ('scheduled', 'completed', 'cancelled')),
	CONSTRAINT "appointments_duration_valid" CHECK ("appointments"."duration_minutes" BETWEEN 5 AND 1440),
	CONSTRAINT "appointments_kind_shape" CHECK (length(btrim("appointments"."kind")) BETWEEN 1 AND 60),
	CONSTRAINT "appointments_notes_len" CHECK ("appointments"."notes" IS NULL OR length("appointments"."notes") BETWEEN 1 AND 1000),
	CONSTRAINT "appointments_key_shape" CHECK (length("appointments"."idempotency_key") BETWEEN 8 AND 100),
	CONSTRAINT "appointments_cancel_consistent" CHECK (("appointments"."status" = 'cancelled') = ("appointments"."cancelled_at" IS NOT NULL AND "appointments"."cancelled_by" IS NOT NULL AND "appointments"."cancel_reason" IS NOT NULL)),
	CONSTRAINT "appointments_cancel_reason_len" CHECK ("appointments"."cancel_reason" IS NULL OR length(btrim("appointments"."cancel_reason")) BETWEEN 1 AND 500),
	CONSTRAINT "appointments_complete_consistent" CHECK (("appointments"."status" = 'completed') = ("appointments"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointment_fk" FOREIGN KEY ("organization_id","appointment_id") REFERENCES "public"."appointments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_opportunity_fk" FOREIGN KEY ("organization_id","opportunity_id") REFERENCES "public"."opportunities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_template_fk" FOREIGN KEY ("organization_id","reminder_template_id") REFERENCES "public"."message_templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_reminders_pending_uq" ON "appointment_reminders" USING btree ("organization_id","appointment_id","offset_minutes") WHERE "appointment_reminders"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "appointment_reminders_due_idx" ON "appointment_reminders" USING btree ("organization_id","send_at") WHERE "appointment_reminders"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "appointment_reminders_appointment_idx" ON "appointment_reminders" USING btree ("organization_id","appointment_id","offset_minutes");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_org_key_uq" ON "appointments" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "appointments_owner_idx" ON "appointments" USING btree ("organization_id","owner_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_starts_idx" ON "appointments" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_contact_idx" ON "appointments" USING btree ("organization_id","contact_id","starts_at");--> statement-breakpoint
CREATE POLICY "appointment_reminders_tenant_isolation" ON "appointment_reminders" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "appointments_tenant_isolation" ON "appointments" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de las tablas la elude fuera de las migraciones.
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_reminders" FORCE ROW LEVEL SECURITY;
