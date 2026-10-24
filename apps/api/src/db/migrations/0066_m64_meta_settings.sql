CREATE TABLE "meta_settings" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"credentials_sealed" text NOT NULL,
	"key_version" integer NOT NULL,
	"token_last4" text NOT NULL,
	"grace_minutes" integer DEFAULT 30 NOT NULL,
	"test_event_code" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"last_check_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_settings_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "meta_settings_dataset_shape" CHECK ("meta_settings"."dataset_id" ~ '^[0-9]{5,30}$'),
	CONSTRAINT "meta_settings_grace_valid" CHECK ("meta_settings"."grace_minutes" BETWEEN 0 AND 1440),
	CONSTRAINT "meta_settings_test_code_shape" CHECK ("meta_settings"."test_event_code" IS NULL OR "meta_settings"."test_event_code" ~ '^[A-Za-z0-9_-]{1,40}$'),
	CONSTRAINT "meta_settings_last4_shape" CHECK (length("meta_settings"."token_last4") BETWEEN 1 AND 4),
	CONSTRAINT "meta_settings_error_len" CHECK ("meta_settings"."last_error" IS NULL OR length("meta_settings"."last_error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "meta_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meta_settings" ADD CONSTRAINT "meta_settings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_settings_org_uq" ON "meta_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "meta_settings_tenant_isolation" ON "meta_settings" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "meta_settings" FORCE ROW LEVEL SECURITY;
