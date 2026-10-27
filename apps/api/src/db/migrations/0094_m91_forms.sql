CREATE TABLE "form_fields" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"maps_to" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" text[],
	"placeholder" text,
	CONSTRAINT "form_fields_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "form_fields_key_shape" CHECK ("form_fields"."key" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "form_fields_kind_valid" CHECK ("form_fields"."kind" IN ('text', 'long_text', 'email', 'phone', 'number', 'select')),
	CONSTRAINT "form_fields_label_len" CHECK (length(btrim("form_fields"."label")) BETWEEN 1 AND 100),
	CONSTRAINT "form_fields_maps_to_valid" CHECK ("form_fields"."maps_to" ~ '^(name|phone|email|note|custom:[a-z][a-z0-9_]{0,39})$'),
	CONSTRAINT "form_fields_placeholder_len" CHECK ("form_fields"."placeholder" IS NULL OR length("form_fields"."placeholder") <= 100),
	CONSTRAINT "form_fields_options_by_kind" CHECK (("form_fields"."kind" = 'select') = ("form_fields"."options" IS NOT NULL AND cardinality("form_fields"."options") BETWEEN 1 AND 30)),
	CONSTRAINT "form_fields_position_valid" CHECK ("form_fields"."position" BETWEEN 0 AND 29)
);
--> statement-breakpoint
ALTER TABLE "form_fields" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "form_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text,
	"ip_hash" text,
	"event_id" text NOT NULL,
	"contact_created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_submissions_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "form_submissions_key_len" CHECK (length("form_submissions"."idempotency_key") BETWEEN 8 AND 100),
	CONSTRAINT "form_submissions_source_len" CHECK ("form_submissions"."source_url" IS NULL OR length("form_submissions"."source_url") <= 500)
);
--> statement-breakpoint
ALTER TABLE "form_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forms" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"queue_id" uuid,
	"pipeline_id" uuid,
	"stage_id" uuid,
	"extra_tag_id" uuid,
	"consent_text" text DEFAULT 'Acepto que me contacten por WhatsApp y por teléfono para atender mi solicitud.' NOT NULL,
	"thanks_message" text DEFAULT '¡Gracias! Recibimos tus datos y te contactaremos en breve.' NOT NULL,
	"redirect_url" text,
	"allowed_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"phone_prefix" text DEFAULT '+593' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "forms_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "forms_name_shape" CHECK (length(btrim("forms"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "forms_description_len" CHECK ("forms"."description" IS NULL OR length("forms"."description") <= 300),
	CONSTRAINT "forms_status_valid" CHECK ("forms"."status" IN ('draft', 'published', 'paused')),
	CONSTRAINT "forms_stage_needs_pipeline" CHECK ("forms"."stage_id" IS NULL OR "forms"."pipeline_id" IS NOT NULL),
	CONSTRAINT "forms_consent_len" CHECK (length(btrim("forms"."consent_text")) BETWEEN 10 AND 500),
	CONSTRAINT "forms_thanks_len" CHECK (length(btrim("forms"."thanks_message")) BETWEEN 1 AND 300),
	CONSTRAINT "forms_redirect_https" CHECK ("forms"."redirect_url" IS NULL OR ("forms"."redirect_url" ~ '^https://[^\s]+$' AND length("forms"."redirect_url") <= 500)),
	CONSTRAINT "forms_domains_valid" CHECK (cardinality("forms"."allowed_domains") <= 20),
	CONSTRAINT "forms_prefix_shape" CHECK ("forms"."phone_prefix" ~ '^\+[1-9][0-9]{0,3}$')
);
--> statement-breakpoint
ALTER TABLE "forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_form_fk" FOREIGN KEY ("organization_id","form_id") REFERENCES "public"."forms"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_routes" ADD CONSTRAINT "form_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_fk" FOREIGN KEY ("organization_id","form_id") REFERENCES "public"."forms"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_pipeline_fk" FOREIGN KEY ("organization_id","pipeline_id") REFERENCES "public"."pipelines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_stage_fk" FOREIGN KEY ("organization_id","pipeline_id","stage_id") REFERENCES "public"."pipeline_stages"("organization_id","pipeline_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_extra_tag_fk" FOREIGN KEY ("organization_id","extra_tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_fields_key_uq" ON "form_fields" USING btree ("organization_id","form_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "form_fields_position_uq" ON "form_fields" USING btree ("organization_id","form_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "form_routes_form_uq" ON "form_routes" USING btree ("organization_id","form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_submissions_idem_uq" ON "form_submissions" USING btree ("organization_id","form_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "form_submissions_form_idx" ON "form_submissions" USING btree ("organization_id","form_id","created_at");--> statement-breakpoint
CREATE INDEX "form_submissions_contact_idx" ON "form_submissions" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_name_uq" ON "forms" USING btree ("organization_id",lower("name")) WHERE "forms"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "forms_list_idx" ON "forms" USING btree ("organization_id","created_at","id") WHERE "forms"."deleted_at" IS NULL;--> statement-breakpoint
CREATE POLICY "form_fields_tenant_isolation" ON "form_fields" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_isolation" ON "form_submissions" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "forms_tenant_isolation" ON "forms" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de las tablas la elude fuera de las migraciones.
ALTER TABLE "forms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_fields" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_submissions" FORCE ROW LEVEL SECURITY;
