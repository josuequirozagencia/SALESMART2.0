CREATE TABLE "conversation_participants" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "conversation_participants_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "conversation_participants_permission_valid" CHECK ("conversation_participants"."permission" IN ('reply', 'view')),
	CONSTRAINT "conversation_participants_revoked_pair" CHECK (("conversation_participants"."revoked_at" IS NULL) = ("conversation_participants"."revoked_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assignment_source" text DEFAULT 'distribution' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_active_uq" ON "conversation_participants" USING btree ("organization_id","conversation_id","user_id") WHERE "conversation_participants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_participants_user_idx" ON "conversation_participants" USING btree ("organization_id","user_id","conversation_id") WHERE "conversation_participants"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignment_source_valid" CHECK ("conversations"."assignment_source" IN ('distribution', 'manual'));--> statement-breakpoint
CREATE POLICY "conversation_participants_tenant_isolation" ON "conversation_participants" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "conversation_participants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Permisos del asesor (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test): transferir y compartir SUS conversaciones (F10: «AS o supervisor»). El administrador ya los tiene.
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('advisor', 'inbox.transfer'),
  ('advisor', 'inbox.share');
