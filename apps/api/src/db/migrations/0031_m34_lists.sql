CREATE TABLE "contact_list_members" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"list_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_list_members_pk" PRIMARY KEY("organization_id","list_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "contact_list_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_lists" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"columns" jsonb,
	"sort" jsonb,
	"owner_id" uuid NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contact_lists_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "contact_lists_name_shape" CHECK (length(btrim("contact_lists"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "contact_lists_kind_valid" CHECK ("contact_lists"."kind" IN ('dynamic', 'fixed')),
	CONSTRAINT "contact_lists_filters_object" CHECK (jsonb_typeof("contact_lists"."filters") = 'object'),
	CONSTRAINT "contact_lists_columns_array" CHECK ("contact_lists"."columns" IS NULL OR (jsonb_typeof("contact_lists"."columns") = 'array' AND jsonb_array_length("contact_lists"."columns") BETWEEN 1 AND 40)),
	CONSTRAINT "contact_lists_sort_object" CHECK ("contact_lists"."sort" IS NULL OR jsonb_typeof("contact_lists"."sort") = 'object')
);
--> statement-breakpoint
ALTER TABLE "contact_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_list_fk" FOREIGN KEY ("organization_id","list_id") REFERENCES "public"."contact_lists"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_list_members_contact_idx" ON "contact_list_members" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_lists_org_owner_name_uq" ON "contact_lists" USING btree ("organization_id","owner_id",lower("name")) WHERE "contact_lists"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contact_lists_org_idx" ON "contact_lists" USING btree ("organization_id","owner_id") WHERE "contact_lists"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "custom_field_values_number_idx" ON "custom_field_values" USING btree ("organization_id","definition_id","value_number") WHERE "custom_field_values"."value_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_field_values_date_idx" ON "custom_field_values" USING btree ("organization_id","definition_id","value_date") WHERE "custom_field_values"."value_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_field_values_bool_idx" ON "custom_field_values" USING btree ("organization_id","definition_id","value_bool") WHERE "custom_field_values"."value_bool" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_field_values_json_idx" ON "custom_field_values" USING gin ("value_json");--> statement-breakpoint
CREATE POLICY "contact_list_members_tenant_isolation" ON "contact_list_members" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "contact_lists_tenant_isolation" ON "contact_lists" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "contact_lists" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_list_members" FORCE ROW LEVEL SECURITY;