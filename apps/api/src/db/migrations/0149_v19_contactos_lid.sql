CREATE TABLE "contact_identities" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_identities_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "contact_identities_kind_valid" CHECK ("contact_identities"."kind" IN ('wa_lid')),
	CONSTRAINT "contact_identities_lid_shape" CHECK ("contact_identities"."kind" <> 'wa_lid' OR "contact_identities"."value" ~ '^[0-9]{5,30}@lid$')
);
--> statement-breakpoint
ALTER TABLE "contact_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identities_org_kind_value_uq" ON "contact_identities" USING btree ("organization_id","kind","value");--> statement-breakpoint
CREATE INDEX "contact_identities_contact_idx" ON "contact_identities" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE POLICY "contact_identities_tenant_isolation" ON "contact_identities" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24) y permisos de la tabla nueva (de NEGOCIO, solo app_rw, sin DELETE).
ALTER TABLE "contact_identities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "contact_identities" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "contact_identities" TO "app_rw";
