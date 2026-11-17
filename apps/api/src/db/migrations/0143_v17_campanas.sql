CREATE TABLE "campaign_advisor_limits" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"user_id" uuid NOT NULL,
	"daily_cap" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_advisor_limits_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "campaign_advisor_limits_cap_valid" CHECK ("campaign_advisor_limits"."daily_cap" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "campaign_advisor_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"error" text,
	"conversation_id" uuid,
	"message_id" uuid,
	"queued_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipients_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "campaign_recipients_status_valid" CHECK ("campaign_recipients"."status" IN ('pending', 'queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped')),
	CONSTRAINT "campaign_recipients_skip_valid" CHECK (("campaign_recipients"."status" = 'skipped') = ("campaign_recipients"."skip_reason" IS NOT NULL) AND ("campaign_recipients"."skip_reason" IS NULL OR "campaign_recipients"."skip_reason" IN ('revoked', 'no_consent', 'no_phone', 'duplicate', 'out_of_scope', 'excluded', 'missing_variable', 'cancelled'))),
	CONSTRAINT "campaign_recipients_error_len" CHECK ("campaign_recipients"."error" IS NULL OR length("campaign_recipients"."error") <= 200)
);
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaigns" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"template_id" uuid,
	"template_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text,
	"audience" jsonb NOT NULL,
	"include_unknown_consent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"gap_seconds" integer NOT NULL,
	"daily_cap" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"launched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "campaigns_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "campaigns_name_shape" CHECK (length(btrim("campaigns"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "campaigns_mode_valid" CHECK ("campaigns"."mode" IN ('template', 'text')),
	CONSTRAINT "campaigns_status_valid" CHECK ("campaigns"."status" IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "campaigns_mode_content" CHECK (("campaigns"."mode" = 'template' AND "campaigns"."template_id" IS NOT NULL AND "campaigns"."body" IS NULL) OR ("campaigns"."mode" = 'text' AND "campaigns"."template_id" IS NULL AND "campaigns"."body" IS NOT NULL AND length(btrim("campaigns"."body")) BETWEEN 1 AND 1000)),
	CONSTRAINT "campaigns_params_object" CHECK (jsonb_typeof("campaigns"."template_params") = 'object'),
	CONSTRAINT "campaigns_audience_object" CHECK (jsonb_typeof("campaigns"."audience") = 'object'),
	CONSTRAINT "campaigns_gap_valid" CHECK ("campaigns"."gap_seconds" BETWEEN 5 AND 3600),
	CONSTRAINT "campaigns_cap_valid" CHECK ("campaigns"."daily_cap" BETWEEN 1 AND 10000),
	CONSTRAINT "campaigns_key_shape" CHECK (length("campaigns"."idempotency_key") BETWEEN 8 AND 100),
	CONSTRAINT "campaigns_reason_len" CHECK ("campaigns"."status_reason" IS NULL OR length("campaigns"."status_reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_advisor_limits" ADD CONSTRAINT "campaign_advisor_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_advisor_limits" ADD CONSTRAINT "campaign_advisor_limits_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."message_templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_contact_uq" ON "campaign_recipients" USING btree ("organization_id","campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_pending_idx" ON "campaign_recipients" USING btree ("organization_id","campaign_id","id") WHERE "campaign_recipients"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "campaign_recipients_status_idx" ON "campaign_recipients" USING btree ("organization_id","campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_recipients_message_idx" ON "campaign_recipients" USING btree ("organization_id","message_id") WHERE "campaign_recipients"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_org_key_uq" ON "campaigns" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "campaigns_org_idx" ON "campaigns" USING btree ("organization_id","created_at") WHERE "campaigns"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "campaigns_creator_idx" ON "campaigns" USING btree ("organization_id","created_by","created_at") WHERE "campaigns"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "campaigns_due_idx" ON "campaigns" USING btree ("organization_id","status","scheduled_at") WHERE "campaigns"."deleted_at" IS NULL AND "campaigns"."status" IN ('scheduled', 'running');--> statement-breakpoint
CREATE POLICY "campaign_advisor_limits_tenant_isolation" ON "campaign_advisor_limits" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "campaign_recipients_tenant_isolation" ON "campaign_recipients" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "campaigns_tenant_isolation" ON "campaigns" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_advisor_limits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- v17 (ADR-72): tablas de NEGOCIO, solo app_rw, sin DELETE (una campaña se borra en lo lógico y un destinatario nunca se borra).
REVOKE ALL ON TABLE "campaigns", "campaign_recipients", "campaign_advisor_limits" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "campaigns", "campaign_recipients", "campaign_advisor_limits" TO "app_rw";--> statement-breakpoint
-- Permisos nuevos (fuente en código: src/rbac/catalog.ts, vigilada por test). El administrador del cliente los tiene todos; el asesor, ninguno por defecto (se le conceden por persona).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('campaigns.read', 'tenant', 'campaigns.read'),
  ('campaigns.send', 'tenant', 'campaigns.send'),
  ('campaigns.view_all', 'tenant', 'campaigns.view_all'),
  ('campaigns.cancel', 'tenant', 'campaigns.cancel');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'campaigns.read'),
  ('client_admin', 'campaigns.send'),
  ('client_admin', 'campaigns.view_all'),
  ('client_admin', 'campaigns.cancel')
ON CONFLICT DO NOTHING;
