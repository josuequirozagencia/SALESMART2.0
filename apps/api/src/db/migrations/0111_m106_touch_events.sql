CREATE TABLE "contact_touch_events" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"campaign" text,
	"adset" text,
	"ad" text,
	"ad_id" text,
	"ctwa_clid" text,
	"headline" text,
	"thumbnail_url" text,
	"source_url" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_touch_events_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "contact_touch_events_kind_valid" CHECK ("contact_touch_events"."kind" IN ('ad_click', 'form_submit', 'message_in', 'page_visit')),
	CONSTRAINT "contact_touch_events_source_shape" CHECK ("contact_touch_events"."source" ~ '^[a-z][a-z0-9_]{1,31}$'),
	CONSTRAINT "contact_touch_events_texts_len" CHECK (length(coalesce("contact_touch_events"."campaign", '')) <= 200 AND length(coalesce("contact_touch_events"."adset", '')) <= 200 AND length(coalesce("contact_touch_events"."ad", '')) <= 200 AND length(coalesce("contact_touch_events"."ad_id", '')) <= 100 AND length(coalesce("contact_touch_events"."ctwa_clid", '')) <= 500 AND length(coalesce("contact_touch_events"."headline", '')) <= 300 AND length(coalesce("contact_touch_events"."origin_ref", '')) <= 200),
	CONSTRAINT "contact_touch_events_urls_https" CHECK (("contact_touch_events"."thumbnail_url" IS NULL OR ("contact_touch_events"."thumbnail_url" ~ '^https://[^\s]+$' AND length("contact_touch_events"."thumbnail_url") <= 1000)) AND ("contact_touch_events"."source_url" IS NULL OR ("contact_touch_events"."source_url" ~ '^https://[^\s]+$' AND length("contact_touch_events"."source_url") <= 1000))),
	CONSTRAINT "contact_touch_events_utm_shape" CHECK (jsonb_typeof("contact_touch_events"."utm") = 'object' AND length("contact_touch_events"."utm"::text) <= 2000)
);
--> statement-breakpoint
ALTER TABLE "contact_touch_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_exports" DROP CONSTRAINT "analytics_exports_report_valid";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_touch_ad_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_touch_ad_id" text;--> statement-breakpoint
ALTER TABLE "contact_touch_events" ADD CONSTRAINT "contact_touch_events_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_touch_events_origin_uq" ON "contact_touch_events" USING btree ("organization_id","contact_id","kind","origin_ref") WHERE "contact_touch_events"."origin_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contact_touch_events_contact_idx" ON "contact_touch_events" USING btree ("organization_id","contact_id","occurred_at","id");--> statement-breakpoint
ALTER TABLE "analytics_exports" ADD CONSTRAINT "analytics_exports_report_valid" CHECK ("analytics_exports"."report" IN ('sales', 'appointments', 'funnel', 'advisors', 'winning_ads'));--> statement-breakpoint
CREATE POLICY "contact_touch_events_tenant_isolation" ON "contact_touch_events" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "contact_touch_events" FORCE ROW LEVEL SECURITY;
