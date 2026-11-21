CREATE TABLE "ad_creatives" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"headline" text,
	"body" text,
	"source_url" text,
	"platform" text,
	"thumbnail_key" text,
	"thumbnail_mime" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_creatives_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ad_creatives_source_shape" CHECK (length("ad_creatives"."source_id") BETWEEN 1 AND 100),
	CONSTRAINT "ad_creatives_platform_valid" CHECK ("ad_creatives"."platform" IS NULL OR "ad_creatives"."platform" IN ('facebook', 'instagram')),
	CONSTRAINT "ad_creatives_mime_valid" CHECK ("ad_creatives"."thumbnail_mime" IS NULL OR "ad_creatives"."thumbnail_mime" IN ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "ad_creatives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "ad_scanned_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_creatives_org_source_uq" ON "ad_creatives" USING btree ("organization_id","source_id");--> statement-breakpoint
CREATE INDEX "webhook_events_ad_scan_idx" ON "webhook_events" USING btree ("organization_id","received_at") WHERE "webhook_events"."ad_scanned_at" IS NULL AND "webhook_events"."payload" @> '{"data":{"contextInfo":{"externalAdReply":{}}}}'::jsonb;--> statement-breakpoint
CREATE POLICY "ad_creatives_tenant_isolation" ON "ad_creatives" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24) y permisos de la tabla nueva (de NEGOCIO, solo app_rw, sin DELETE).
ALTER TABLE "ad_creatives" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "ad_creatives" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ad_creatives" TO "app_rw";
