-- M3.3 §11/§12 (aprobado el 2026-11-07): canal del lead y panel de rendimiento de anuncios.
ALTER TABLE "contacts" ADD COLUMN "channel" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_channel_valid" CHECK ("contacts"."channel" IN ('facebook', 'instagram', 'whatsapp', 'manual', 'other'));--> statement-breakpoint
-- Los contactos que ya existen reciben el canal que se deduce de su origen (mismas reglas que el código: manual→manual, whatsapp→whatsapp, meta_ctwa→facebook, el resto→other).
-- La RLS está FORZADA en esta tabla: sin quitarla un instante, este UPDATE (sin empresa en contexto) no vería ninguna fila. Va dentro de la transacción de la migración y se vuelve a forzar antes de terminar.
ALTER TABLE "contacts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "contacts" SET "channel" = CASE "source" WHEN 'manual' THEN 'manual' WHEN 'whatsapp' THEN 'whatsapp' WHEN 'meta_ctwa' THEN 'facebook' ELSE 'other' END;--> statement-breakpoint
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test): solo el administrador.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('attribution.view', 'tenant', 'attribution.view');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'attribution.view');
