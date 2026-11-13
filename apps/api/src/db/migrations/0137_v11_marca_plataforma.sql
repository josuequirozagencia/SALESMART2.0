CREATE TABLE "platform_branding_assets" (
	"asset" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"px" integer,
	"version" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "platform_branding_assets_name" CHECK ("platform_branding_assets"."asset" IN ('logo-light', 'logo-dark', 'icon-32', 'icon-48', 'icon-180', 'icon-192', 'icon-512', 'badge-96', 'sound')),
	CONSTRAINT "platform_branding_assets_type" CHECK ("platform_branding_assets"."content_type" IN ('image/png', 'image/webp', 'audio/mpeg', 'audio/mp4')),
	CONSTRAINT "platform_branding_assets_key" CHECK ("platform_branding_assets"."storage_key" ~ '^platform/branding/[a-z0-9-]+-[0-9a-f-]{36}$'),
	CONSTRAINT "platform_branding_assets_size" CHECK ("platform_branding_assets"."bytes" > 0 AND "platform_branding_assets"."bytes" <= 1048576)
);
--> statement-breakpoint
ALTER TABLE "platform_branding" ADD COLUMN "app_name" text;--> statement-breakpoint
ALTER TABLE "platform_branding" ADD COLUMN "app_short_name" text;--> statement-breakpoint
ALTER TABLE "platform_branding" ADD CONSTRAINT "platform_branding_name_valid" CHECK ("platform_branding"."app_name" IS NULL OR (length("platform_branding"."app_name") BETWEEN 2 AND 40 AND "platform_branding"."app_name" !~ '[<>]'));--> statement-breakpoint
ALTER TABLE "platform_branding" ADD CONSTRAINT "platform_branding_short_name_valid" CHECK ("platform_branding"."app_short_name" IS NULL OR (length("platform_branding"."app_short_name") BETWEEN 1 AND 12 AND "platform_branding"."app_short_name" !~ '[<>]'));
--> statement-breakpoint
-- v11 §3 (Marca): los archivos de la marca de la plataforma (logos, variantes del icono y sonido). Tabla de PLATAFORMA: solo app_platform (con DELETE: restaurar el valor por defecto borra la fila); la API de cliente y de agencia no la ve.
REVOKE ALL ON TABLE "platform_branding_assets" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform_branding_assets" TO "app_platform";
