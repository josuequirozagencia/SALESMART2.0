CREATE TABLE "scheduled_messages" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"body" text NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"reason" text,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "scheduled_messages_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "scheduled_messages_status_valid" CHECK ("scheduled_messages"."status" IN ('scheduled', 'sent', 'cancelled', 'failed')),
	CONSTRAINT "scheduled_messages_body_shape" CHECK (length(btrim("scheduled_messages"."body")) BETWEEN 1 AND 4096),
	CONSTRAINT "scheduled_messages_reason_len" CHECK ("scheduled_messages"."reason" IS NULL OR length("scheduled_messages"."reason") <= 60),
	CONSTRAINT "scheduled_messages_resolved_consistent" CHECK (("scheduled_messages"."status" = 'scheduled') = ("scheduled_messages"."resolved_at" IS NULL)),
	CONSTRAINT "scheduled_messages_sent_has_message" CHECK (("scheduled_messages"."status" = 'sent') = ("scheduled_messages"."message_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_messages_due_idx" ON "scheduled_messages" USING btree ("organization_id","send_at") WHERE "scheduled_messages"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "scheduled_messages_conversation_idx" ON "scheduled_messages" USING btree ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE POLICY "scheduled_messages_tenant_isolation" ON "scheduled_messages" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "scheduled_messages" FORCE ROW LEVEL SECURITY;
