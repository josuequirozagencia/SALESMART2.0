CREATE TABLE "contact_phones" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contact_phones_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "contact_phones_e164_shape" CHECK ("contact_phones"."e164" ~ '^[+][1-9][0-9]{7,14}$')
);
--> statement-breakpoint
ALTER TABLE "contact_phones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contacts" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"owner_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"consent" text DEFAULT 'unknown' NOT NULL,
	"consent_updated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contacts_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "contacts_name_shape" CHECK (length(btrim("contacts"."name")) BETWEEN 1 AND 200),
	CONSTRAINT "contacts_email_shape" CHECK ("contacts"."email" IS NULL OR ("contacts"."email" = lower("contacts"."email") AND length("contacts"."email") <= 254 AND "contacts"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}$')),
	CONSTRAINT "contacts_source_shape" CHECK ("contacts"."source" ~ '^[a-z][a-z0-9_]{1,31}$'),
	CONSTRAINT "contacts_consent_valid" CHECK ("contacts"."consent" IN ('unknown', 'granted', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_phones_org_e164_uq" ON "contact_phones" USING btree ("organization_id","e164") WHERE "contact_phones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_phones_one_primary_uq" ON "contact_phones" USING btree ("organization_id","contact_id") WHERE "contact_phones"."is_primary" AND "contact_phones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contact_phones_contact_idx" ON "contact_phones" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "contacts_org_created_idx" ON "contacts" USING btree ("organization_id","created_at","id") WHERE "contacts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contacts_org_name_idx" ON "contacts" USING btree ("organization_id",lower("name"),"id") WHERE "contacts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contacts_org_owner_idx" ON "contacts" USING btree ("organization_id","owner_id") WHERE "contacts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE POLICY "contact_phones_tenant_isolation" ON "contact_phones" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "contacts_tenant_isolation" ON "contacts" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_phones" FORCE ROW LEVEL SECURITY;
