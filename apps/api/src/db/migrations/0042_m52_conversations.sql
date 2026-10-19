CREATE TABLE "conversations" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"status" text DEFAULT 'unassigned' NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "conversations_status_valid" CHECK ("conversations"."status" IN ('unassigned', 'pending', 'working', 'waiting', 'closed')),
	CONSTRAINT "conversations_unread_valid" CHECK ("conversations"."unread_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"external_id" text,
	"direction" text NOT NULL,
	"sender_type" text NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"media" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "messages_direction_valid" CHECK ("messages"."direction" IN ('in', 'out')),
	CONSTRAINT "messages_sender_valid" CHECK ("messages"."sender_type" IN ('contact', 'human', 'ai', 'campaign', 'automation', 'system')),
	CONSTRAINT "messages_sender_direction" CHECK (("messages"."direction" = 'in') = ("messages"."sender_type" = 'contact')),
	CONSTRAINT "messages_kind_valid" CHECK ("messages"."kind" IN ('text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'interactive', 'button', 'template', 'note', 'unsupported')),
	CONSTRAINT "messages_status_valid" CHECK ("messages"."status" IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "messages_body_len" CHECK ("messages"."body" IS NULL OR length("messages"."body") <= 8000),
	CONSTRAINT "messages_error_len" CHECK ("messages"."error" IS NULL OR length("messages"."error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"payload" jsonb,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "webhook_events_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "webhook_events_status_valid" CHECK ("webhook_events"."status" IN ('pending', 'done', 'failed')),
	CONSTRAINT "webhook_events_hash_shape" CHECK ("webhook_events"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "webhook_events_attempts_valid" CHECK ("webhook_events"."attempts" >= 0),
	CONSTRAINT "webhook_events_error_len" CHECK ("webhook_events"."last_error" IS NULL OR length("webhook_events"."last_error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_open_uq" ON "conversations" USING btree ("organization_id","contact_id","channel_account_id") WHERE "conversations"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "conversations_list_idx" ON "conversations" USING btree ("organization_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_external_uq" ON "messages" USING btree ("organization_id","channel_account_id","external_id") WHERE "messages"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("organization_id","conversation_id","sent_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_org_hash_uq" ON "webhook_events" USING btree ("organization_id","payload_hash");--> statement-breakpoint
CREATE INDEX "webhook_events_due_idx" ON "webhook_events" USING btree ("organization_id","next_attempt_at") WHERE "webhook_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_events_redact_idx" ON "webhook_events" USING btree ("organization_id","processed_at") WHERE "webhook_events"."payload" IS NOT NULL AND "webhook_events"."status" <> 'pending';--> statement-breakpoint
CREATE POLICY "conversations_tenant_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "messages_tenant_isolation" ON "messages" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "webhook_events_tenant_isolation" ON "webhook_events" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;
