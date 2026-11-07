-- Borrado lógico de conversaciones (ADR-63): la conversación se conserva (mensajes, adjuntos, historial y auditoría) pero deja de verse y de procesarse. Siempre queda finalizada.
ALTER TABLE "conversations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_deleted_closed" CHECK ("conversations"."deleted_at" IS NULL OR "conversations"."status" = 'closed');--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test): solo el administrador.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('conversations.delete', 'tenant', 'conversations.delete');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'conversations.delete');
