CREATE TABLE "access_resets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"actor_org_id" uuid,
	"organization_id" uuid,
	"target_user_id" uuid NOT NULL,
	"target_email_masked" text NOT NULL,
	"reason" text,
	"sessions_revoked" integer DEFAULT 0 NOT NULL,
	"mail_sent" boolean DEFAULT false NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_resets_actor_role_valid" CHECK ("access_resets"."actor_role" IN ('client_admin', 'agency', 'super_admin')),
	CONSTRAINT "access_resets_reason_len" CHECK ("access_resets"."reason" IS NULL OR length(btrim("access_resets"."reason")) BETWEEN 10 AND 300),
	CONSTRAINT "access_resets_ip_hash_hex" CHECK ("access_resets"."ip_hash" IS NULL OR "access_resets"."ip_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "member_history" DROP CONSTRAINT "member_history_kind_valid";--> statement-breakpoint
ALTER TABLE "signup_attempts" DROP CONSTRAINT "signup_attempts_key_shape";--> statement-breakpoint
ALTER TABLE "signup_attempts" ADD CONSTRAINT "signup_attempts_key_shape" CHECK ("signup_attempts"."key" ~ '^[svmfrxiato]:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "password_resets" ADD COLUMN "origin" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "password_resets" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_reset_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_resets" ADD CONSTRAINT "access_resets_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_resets" ADD CONSTRAINT "access_resets_actor_org_id_organizations_id_fk" FOREIGN KEY ("actor_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_resets" ADD CONSTRAINT "access_resets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_resets" ADD CONSTRAINT "access_resets_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_resets_created_idx" ON "access_resets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "access_resets_org_idx" ON "access_resets" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "access_resets_actor_idx" ON "access_resets" USING btree ("actor_user_id","created_at");--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_history" ADD CONSTRAINT "member_history_kind_valid" CHECK ("member_history"."kind" IN ('invited', 'invitation_cancelled', 'role_changed', 'permissions_changed', 'queues_changed', 'deactivated', 'reactivated', 'removed', 'sessions_revoked', 'access_reset'));--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_origin_valid" CHECK ("password_resets"."origin" IN ('self', 'admin'));--> statement-breakpoint
-- ADR-71: access_resets es tabla de IDENTIDAD de solo inserción (solo se completa `mail_sent`). Solo app_identity; app_rw y app_platform NO tienen ningún privilegio (la lee el Súper Admin).
REVOKE ALL ON TABLE "access_resets" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "access_resets" TO "app_identity";--> statement-breakpoint
GRANT UPDATE ("mail_sent") ON TABLE "access_resets" TO "app_identity";--> statement-breakpoint
-- Permisos nuevos (fuente en código: src/rbac/catalog.ts, vigilada por test): restablecer el acceso de una persona de la empresa (administrador del cliente y, por su nivel por cliente, la agencia) y hacerlo desde la plataforma.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('users.reset_access', 'tenant', 'users.reset_access'),
  ('platform.users.reset_access', 'platform', 'platform.users.reset_access');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'users.reset_access'),
  ('super_admin', 'platform.users.reset_access')
ON CONFLICT DO NOTHING;
