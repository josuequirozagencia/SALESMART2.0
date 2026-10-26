CREATE TABLE "ghl_enrollments" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_name" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ghl_enrollments_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ghl_enrollments_status_valid" CHECK ("ghl_enrollments"."status" IN ('done', 'failed')),
	CONSTRAINT "ghl_enrollments_workflow_shape" CHECK (length("ghl_enrollments"."workflow_id") BETWEEN 1 AND 100 AND length(btrim("ghl_enrollments"."workflow_name")) BETWEEN 1 AND 150),
	CONSTRAINT "ghl_enrollments_error_len" CHECK ("ghl_enrollments"."error" IS NULL OR length("ghl_enrollments"."error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "ghl_enrollments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ghl_enrollments" ADD CONSTRAINT "ghl_enrollments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ghl_enrollments" ADD CONSTRAINT "ghl_enrollments_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ghl_enrollments_contact_idx" ON "ghl_enrollments" USING btree ("organization_id","contact_id","created_at","id");--> statement-breakpoint
CREATE POLICY "ghl_enrollments_tenant_isolation" ON "ghl_enrollments" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ghl_enrollments" FORCE ROW LEVEL SECURITY;
