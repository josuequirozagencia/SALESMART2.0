CREATE TABLE "automation_settings" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"http_allowed_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_settings_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "automation_settings_hosts_len" CHECK (cardinality("automation_settings"."http_allowed_hosts") <= 20)
);
--> statement-breakpoint
ALTER TABLE "automation_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_settings_org_uq" ON "automation_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "automation_settings_tenant_isolation" ON "automation_settings" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
ALTER TABLE "automation_settings" FORCE ROW LEVEL SECURITY;
