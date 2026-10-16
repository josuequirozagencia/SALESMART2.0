CREATE TABLE "custom_field_definitions" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"name" text NOT NULL,
	"var_key" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"show_in_form" boolean DEFAULT true NOT NULL,
	"position" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_definitions_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "custom_field_definitions_org_id_entity_uq" UNIQUE("organization_id","id","entity"),
	CONSTRAINT "custom_field_definitions_entity_valid" CHECK ("custom_field_definitions"."entity" IN ('contact', 'opportunity', 'company')),
	CONSTRAINT "custom_field_definitions_type_valid" CHECK ("custom_field_definitions"."type" IN ('text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'email', 'phone', 'url', 'select', 'multiselect')),
	CONSTRAINT "custom_field_definitions_name_shape" CHECK (length(btrim("custom_field_definitions"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "custom_field_definitions_var_key_shape" CHECK ("custom_field_definitions"."var_key" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "custom_field_definitions_options_by_type" CHECK (("custom_field_definitions"."type" IN ('select', 'multiselect') AND "custom_field_definitions"."options" IS NOT NULL AND jsonb_typeof("custom_field_definitions"."options") = 'array' AND jsonb_array_length("custom_field_definitions"."options") BETWEEN 1 AND 50) OR ("custom_field_definitions"."type" NOT IN ('select', 'multiselect') AND "custom_field_definitions"."options" IS NULL)),
	CONSTRAINT "custom_field_definitions_required_in_form" CHECK (NOT "custom_field_definitions"."required" OR "custom_field_definitions"."show_in_form"),
	CONSTRAINT "custom_field_definitions_position_valid" CHECK ("custom_field_definitions"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"value_text" text,
	"value_number" numeric(15, 6),
	"value_bool" boolean,
	"value_date" date,
	"value_datetime" timestamp with time zone,
	"value_json" jsonb,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_values_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "custom_field_values_entity_valid" CHECK ("custom_field_values"."entity" IN ('contact', 'opportunity', 'company')),
	CONSTRAINT "custom_field_values_at_most_one" CHECK (num_nonnulls("custom_field_values"."value_text", "custom_field_values"."value_number", "custom_field_values"."value_bool", "custom_field_values"."value_date", "custom_field_values"."value_datetime", "custom_field_values"."value_json") <= 1),
	CONSTRAINT "custom_field_values_json_is_array" CHECK ("custom_field_values"."value_json" IS NULL OR jsonb_typeof("custom_field_values"."value_json") = 'array')
);
--> statement-breakpoint
ALTER TABLE "custom_field_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definition_fk" FOREIGN KEY ("organization_id","definition_id","entity") REFERENCES "public"."custom_field_definitions"("organization_id","id","entity") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_org_entity_key_uq" ON "custom_field_definitions" USING btree ("organization_id","entity","var_key");--> statement-breakpoint
CREATE INDEX "custom_field_definitions_org_entity_pos_idx" ON "custom_field_definitions" USING btree ("organization_id","entity","position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_org_entity_def_uq" ON "custom_field_values" USING btree ("organization_id","entity","entity_id","definition_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_org_def_idx" ON "custom_field_values" USING btree ("organization_id","definition_id");--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_isolation" ON "custom_field_definitions" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "custom_field_values_tenant_isolation" ON "custom_field_values" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "custom_field_definitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_field_values" FORCE ROW LEVEL SECURITY;