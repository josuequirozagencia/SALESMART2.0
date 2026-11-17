CREATE TABLE "campaign_settings" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"official_daily_cap" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_settings_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "campaign_settings_cap_valid" CHECK ("campaign_settings"."official_daily_cap" BETWEEN 1 AND 100000)
);
--> statement-breakpoint
ALTER TABLE "campaign_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "campaign_recipients_message_idx";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "next_send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_settings" ADD CONSTRAINT "campaign_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_message_uq" ON "campaign_recipients" USING btree ("organization_id","message_id") WHERE "campaign_recipients"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_recipients_queued_idx" ON "campaign_recipients" USING btree ("organization_id","queued_at") WHERE "campaign_recipients"."queued_at" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "campaign_settings_tenant_isolation" ON "campaign_settings" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24) y permisos de la tabla nueva (de NEGOCIO, solo app_rw, sin DELETE).
ALTER TABLE "campaign_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "campaign_settings" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "campaign_settings" TO "app_rw";
