CREATE TABLE "analytics_exports" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"report" text NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	"row_count" integer NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_exports_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "analytics_exports_report_valid" CHECK ("analytics_exports"."report" IN ('sales', 'appointments', 'funnel', 'advisors')),
	CONSTRAINT "analytics_exports_scope_valid" CHECK ("analytics_exports"."scope" IN ('all', 'own')),
	CONSTRAINT "analytics_exports_count_valid" CHECK ("analytics_exports"."row_count" >= 0),
	CONSTRAINT "analytics_exports_period_valid" CHECK ("analytics_exports"."to_at" > "analytics_exports"."from_at")
);
--> statement-breakpoint
ALTER TABLE "analytics_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "analytics_settings" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"advisor_export" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_settings_org_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "analytics_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_exports" ADD CONSTRAINT "analytics_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_settings" ADD CONSTRAINT "analytics_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_exports_recent_idx" ON "analytics_exports" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_settings_org_uq" ON "analytics_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "analytics_exports_tenant_isolation" ON "analytics_exports" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "analytics_settings_tenant_isolation" ON "analytics_settings" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "analytics_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_settings" FORCE ROW LEVEL SECURITY;
