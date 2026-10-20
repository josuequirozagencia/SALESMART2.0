CREATE TABLE "quick_replies" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"shortcut" text NOT NULL,
	"body" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "quick_replies_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "quick_replies_shortcut_shape" CHECK (length("quick_replies"."shortcut") BETWEEN 1 AND 32 AND "quick_replies"."shortcut" ~ '^[a-z0-9][a-z0-9_-]*$'),
	CONSTRAINT "quick_replies_body_shape" CHECK (length(btrim("quick_replies"."body")) BETWEEN 1 AND 4096)
);
--> statement-breakpoint
ALTER TABLE "quick_replies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quick_replies_shared_shortcut_uq" ON "quick_replies" USING btree ("organization_id","shortcut") WHERE "quick_replies"."shared" AND "quick_replies"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quick_replies_owner_shortcut_uq" ON "quick_replies" USING btree ("organization_id","owner_id","shortcut") WHERE NOT "quick_replies"."shared" AND "quick_replies"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "quick_replies_org_idx" ON "quick_replies" USING btree ("organization_id","owner_id") WHERE "quick_replies"."deleted_at" IS NULL;--> statement-breakpoint
CREATE POLICY "quick_replies_tenant_isolation" ON "quick_replies" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "quick_replies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test): compartir, editar y borrar las respuestas rápidas de TODA la empresa. Solo el administrador. Las personales no lo necesitan (basta responder).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('quick_replies.manage', 'tenant', 'quick_replies.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'quick_replies.manage');
