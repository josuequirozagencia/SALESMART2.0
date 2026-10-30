CREATE TABLE "user_hours" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"days" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_hours_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "user_hours_days_shape" CHECK (jsonb_typeof("user_hours"."days") = 'array' AND jsonb_array_length("user_hours"."days") = 7)
);
--> statement-breakpoint
ALTER TABLE "user_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_hours" ADD CONSTRAINT "user_hours_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hours" ADD CONSTRAINT "user_hours_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_hours_org_user_uq" ON "user_hours" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE POLICY "user_hours_tenant_isolation" ON "user_hours" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "user_hours" FORCE ROW LEVEL SECURITY;
