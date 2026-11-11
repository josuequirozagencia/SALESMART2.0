CREATE TABLE "platform_branding" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"favicon_key" text,
	"favicon_content_type" text,
	"favicon_bytes" integer,
	"favicon_px" integer,
	"favicon_version" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "platform_branding_single_row" CHECK ("platform_branding"."id" = 1),
	CONSTRAINT "platform_branding_favicon_consistent" CHECK (("platform_branding"."favicon_key" IS NULL) = ("platform_branding"."favicon_version" IS NULL) AND ("platform_branding"."favicon_key" IS NULL) = ("platform_branding"."favicon_content_type" IS NULL)),
	CONSTRAINT "platform_branding_favicon_type" CHECK ("platform_branding"."favicon_content_type" IS NULL OR "platform_branding"."favicon_content_type" IN ('image/png', 'image/x-icon', 'image/webp')),
	CONSTRAINT "platform_branding_favicon_key_shape" CHECK ("platform_branding"."favicon_key" IS NULL OR "platform_branding"."favicon_key" ~ '^platform/branding/favicon-[0-9a-f-]{36}$'),
	CONSTRAINT "platform_branding_favicon_size" CHECK ("platform_branding"."favicon_bytes" IS NULL OR ("platform_branding"."favicon_bytes" > 0 AND "platform_branding"."favicon_bytes" <= 262144)),
	CONSTRAINT "platform_branding_favicon_px" CHECK ("platform_branding"."favicon_px" IS NULL OR ("platform_branding"."favicon_px" >= 32 AND "platform_branding"."favicon_px" <= 512))
);
--> statement-breakpoint
-- v11 S3: marca de la plataforma (favicon). Tabla de PLATAFORMA: solo app_platform; app_rw (API de cliente y de agencia) y app_identity sin ningún privilegio. Una sola fila (id = 1): se crea o se actualiza, nunca se borra (quitar el favicon pone todo en NULL).
REVOKE ALL ON TABLE "platform_branding" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "platform_branding" TO "app_platform";--> statement-breakpoint
-- `platform.branding.manage` (plataforma): subir y quitar el favicon; solo el Súper Admin. Fuente en código: src/rbac/catalog.ts (vigilada por test).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('platform.branding.manage', 'platform', 'platform.branding.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('super_admin', 'platform.branding.manage')
ON CONFLICT DO NOTHING;
