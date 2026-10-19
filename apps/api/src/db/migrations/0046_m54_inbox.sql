ALTER TABLE "messages" DROP CONSTRAINT "messages_status_valid";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "peer_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_outbox_idx" ON "messages" USING btree ("organization_id","next_attempt_at") WHERE "messages"."status" = 'queued';--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_note_internal" CHECK (("messages"."kind" = 'note') = ("messages"."status" = 'internal'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attempts_valid" CHECK ("messages"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_status_valid" CHECK ("messages"."status" IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'internal'));--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test): ver las conversaciones a las que se tiene acceso. Lo tienen el administrador y el asesor.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('inbox.read', 'tenant', 'inbox.read');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'inbox.read'),
  ('advisor', 'inbox.read');
