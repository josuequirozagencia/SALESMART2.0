CREATE TABLE "media_assets" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"checksum" text NOT NULL,
	"scan_status" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"usable_by_advisors" boolean DEFAULT true NOT NULL,
	"usable_by_ai" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "media_assets_kind_valid" CHECK ("media_assets"."kind" IN ('image', 'video', 'audio', 'document')),
	CONSTRAINT "media_assets_state_valid" CHECK ("media_assets"."state" IN ('ready', 'archived')),
	CONSTRAINT "media_assets_scan_valid" CHECK ("media_assets"."scan_status" IN ('clean', 'skipped')),
	CONSTRAINT "media_assets_size_valid" CHECK ("media_assets"."size_bytes" BETWEEN 1 AND 26214400),
	CONSTRAINT "media_assets_name_len" CHECK (length(btrim("media_assets"."name")) BETWEEN 1 AND 200 AND length("media_assets"."mime_type") BETWEEN 3 AND 127 AND ("media_assets"."description" IS NULL OR length("media_assets"."description") <= 300)),
	CONSTRAINT "media_assets_archived_consistent" CHECK (("media_assets"."state" = 'archived') = ("media_assets"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_folders" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_folders_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "media_folders_name_len" CHECK (length(btrim("media_folders"."name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "media_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "storage_quota_bytes" bigint DEFAULT 1073741824 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_folder_fk" FOREIGN KEY ("organization_id","folder_id") REFERENCES "public"."media_folders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_org_state_idx" ON "media_assets" USING btree ("organization_id","state","folder_id");--> statement-breakpoint
CREATE INDEX "media_assets_org_created_idx" ON "media_assets" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_folders_org_name_uq" ON "media_folders" USING btree ("organization_id",lower("name")) WHERE "media_folders"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_storage_quota_valid" CHECK ("organizations"."storage_quota_bytes" BETWEEN 0 AND 10995116277760);--> statement-breakpoint
CREATE POLICY "media_assets_tenant_isolation" ON "media_assets" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "media_folders_tenant_isolation" ON "media_folders" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
ALTER TABLE "media_assets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_folders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- V21 (ADR-75): media_assets y media_folders son tablas de NEGOCIO, solo app_rw, sin DELETE (un archivo o una carpeta se archiva; el objeto del almacenamiento solo lo borra la eliminación definitiva de la empresa).
REVOKE ALL ON TABLE "media_assets", "media_folders" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "media_assets", "media_folders" TO "app_rw";--> statement-breakpoint
-- Permisos nuevos (fuente en código: src/rbac/catalog.ts, vigilada por test). El administrador del cliente tiene los dos; el asesor solo `library.read` (ve y envía lo marcado para asesores).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('library.read', 'tenant', 'library.read'),
  ('library.manage', 'tenant', 'library.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'library.read'),
  ('client_admin', 'library.manage'),
  ('advisor', 'library.read')
ON CONFLICT DO NOTHING;
