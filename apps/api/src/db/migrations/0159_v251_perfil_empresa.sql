-- V25 (ADR-76): perfil de la empresa. Datos básicos en una tabla de negocio; el nombre, el país, la zona horaria y la moneda siguen en `organizations`.
CREATE TABLE "organization_profiles" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"legal_name" text,
	"tax_id" text,
	"contact_phone" text,
	"contact_email" text,
	"website" text,
	"address" text,
	"city" text,
	"description" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_profiles_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "organization_profiles_legal_name_len" CHECK ("organization_profiles"."legal_name" IS NULL OR length(btrim("organization_profiles"."legal_name")) BETWEEN 1 AND 120),
	CONSTRAINT "organization_profiles_tax_id_len" CHECK ("organization_profiles"."tax_id" IS NULL OR length(btrim("organization_profiles"."tax_id")) BETWEEN 1 AND 32),
	CONSTRAINT "organization_profiles_phone_e164" CHECK ("organization_profiles"."contact_phone" IS NULL OR "organization_profiles"."contact_phone" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "organization_profiles_email_shape" CHECK ("organization_profiles"."contact_email" IS NULL OR (length("organization_profiles"."contact_email") BETWEEN 3 AND 254 AND "organization_profiles"."contact_email" ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
	CONSTRAINT "organization_profiles_website_https" CHECK ("organization_profiles"."website" IS NULL OR (length("organization_profiles"."website") <= 200 AND "organization_profiles"."website" ~ '^https://[^[:space:]]+$')),
	CONSTRAINT "organization_profiles_address_len" CHECK ("organization_profiles"."address" IS NULL OR length(btrim("organization_profiles"."address")) BETWEEN 1 AND 200),
	CONSTRAINT "organization_profiles_city_len" CHECK ("organization_profiles"."city" IS NULL OR length(btrim("organization_profiles"."city")) BETWEEN 1 AND 80),
	CONSTRAINT "organization_profiles_description_len" CHECK ("organization_profiles"."description" IS NULL OR length(btrim("organization_profiles"."description")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "organization_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "organization_profiles_tenant_isolation" ON "organization_profiles" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "organization_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE.
REVOKE ALL ON TABLE "organization_profiles" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "organization_profiles" TO "app_rw";--> statement-breakpoint
-- Permisos nuevos (fuente en código: src/rbac/catalog.ts, vigilada por test): ver (administrador y asesor) y editar (solo el administrador).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('organization.read', 'tenant', 'organization.read'),
  ('organization.manage', 'tenant', 'organization.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'organization.read'),
  ('client_admin', 'organization.manage'),
  ('advisor', 'organization.read');
