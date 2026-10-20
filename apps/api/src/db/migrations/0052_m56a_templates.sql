CREATE TABLE "message_templates" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"parameter_format" text DEFAULT 'positional' NOT NULL,
	"components" jsonb NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sendable" boolean DEFAULT false NOT NULL,
	"unsupported_reason" text,
	"rejected_reason" text,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "message_templates_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "message_templates_category_valid" CHECK ("message_templates"."category" IN ('marketing', 'utility', 'authentication', 'other')),
	CONSTRAINT "message_templates_status_valid" CHECK ("message_templates"."status" IN ('approved', 'pending', 'rejected', 'paused', 'disabled', 'other')),
	CONSTRAINT "message_templates_format_valid" CHECK ("message_templates"."parameter_format" IN ('positional', 'named')),
	CONSTRAINT "message_templates_name_shape" CHECK (length("message_templates"."name") BETWEEN 1 AND 512 AND "message_templates"."name" ~ '^[a-z0-9_]+$'),
	CONSTRAINT "message_templates_sendable_status" CHECK (NOT "message_templates"."sendable" OR "message_templates"."status" = 'approved'),
	CONSTRAINT "message_templates_sendable_clean" CHECK (NOT "message_templates"."sendable" OR "message_templates"."unsupported_reason" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD COLUMN "templates_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD COLUMN "templates_sync_error" text;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_channel_name_uq" ON "message_templates" USING btree ("organization_id","channel_account_id","name","language");--> statement-breakpoint
CREATE INDEX "message_templates_channel_idx" ON "message_templates" USING btree ("organization_id","channel_account_id","deleted_at");--> statement-breakpoint
CREATE POLICY "message_templates_tenant_isolation" ON "message_templates" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;
