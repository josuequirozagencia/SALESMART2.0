CREATE TABLE "attribution_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "attribution_endpoints_secret_hash_hex" CHECK ("attribution_endpoints"."secret_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"set_by" text DEFAULT 'user' NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tags_pk" PRIMARY KEY("organization_id","contact_id","tag_id"),
	CONSTRAINT "contact_tags_set_by_valid" CHECK ("contact_tags"."set_by" IN ('system', 'user'))
);
--> statement-breakpoint
ALTER TABLE "contact_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "meta_events" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_events_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "meta_events_type_valid" CHECK ("meta_events"."type" IN ('Lead', 'Schedule', 'Purchase', 'SaleCanceled')),
	CONSTRAINT "meta_events_status_valid" CHECK ("meta_events"."status" IN ('pending', 'sent', 'skipped', 'blocked', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "meta_events_attempts_valid" CHECK ("meta_events"."attempts" >= 0),
	CONSTRAINT "meta_events_event_id_shape" CHECK (length("meta_events"."event_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "meta_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tags" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6a44f2' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"system_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tags_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "tags_name_shape" CHECK (length(btrim("tags"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "tags_color_shape" CHECK ("tags"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "tags_system_key_valid" CHECK ("tags"."system_key" IS NULL OR "tags"."system_key" IN ('lead', 'appointment', 'sale')),
	CONSTRAINT "tags_system_consistent" CHECK ("tags"."is_system" = ("tags"."system_key" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ctwa_cl_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_touch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_touch_source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_touch_campaign" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_touch_adset" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_touch_ad" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_touch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_touch_source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_touch_campaign" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_touch_adset" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_touch_ad" text;--> statement-breakpoint
ALTER TABLE "attribution_endpoints" ADD CONSTRAINT "attribution_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_endpoints" ADD CONSTRAINT "attribution_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_fk" FOREIGN KEY ("organization_id","tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_events" ADD CONSTRAINT "meta_events_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_endpoints_org_uq" ON "attribution_endpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_tags_contact_idx" ON "contact_tags" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_events_org_event_id_uq" ON "meta_events" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "meta_events_pending_idx" ON "meta_events" USING btree ("organization_id","send_after") WHERE "meta_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "meta_events_contact_idx" ON "meta_events" USING btree ("organization_id","contact_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_system_key_uq" ON "tags" USING btree ("organization_id","system_key") WHERE "tags"."system_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_name_uq" ON "tags" USING btree ("organization_id",lower("name")) WHERE "tags"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_ctwa_cl_id_shape" CHECK ("contacts"."ctwa_cl_id" IS NULL OR length(btrim("contacts"."ctwa_cl_id")) BETWEEN 1 AND 500);--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_touch_source_shape" CHECK (("contacts"."first_touch_source" IS NULL OR "contacts"."first_touch_source" ~ '^[a-z][a-z0-9_]{1,31}$') AND ("contacts"."last_touch_source" IS NULL OR "contacts"."last_touch_source" ~ '^[a-z][a-z0-9_]{1,31}$'));--> statement-breakpoint
CREATE POLICY "contact_tags_tenant_isolation" ON "contact_tags" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "meta_events_tenant_isolation" ON "meta_events" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "tags_tenant_isolation" ON "tags" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_tags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meta_events" FORCE ROW LEVEL SECURITY;