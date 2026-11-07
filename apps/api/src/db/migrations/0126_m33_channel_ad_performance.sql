-- M3.3 §11/§12 (aprobado el 2026-11-07): canal del lead y panel de rendimiento de anuncios.
ALTER TABLE "contacts" ADD COLUMN "channel" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_channel_valid" CHECK ("contacts"."channel" IN ('facebook', 'instagram', 'whatsapp', 'manual', 'other'));--> statement-breakpoint
-- Los contactos que ya existen reciben el canal que se deduce de su origen (mismas reglas que el código: manual→manual, whatsapp→whatsapp, meta_ctwa→facebook, el resto→other).
-- La RLS sigue FORZADA: el relleno se hace empresa por empresa, poniendo la empresa en contexto (como lo hace la aplicación) y sin saltarse ninguna política. El contexto se limpia al terminar.
DO $$
DECLARE o RECORD;
BEGIN
  FOR o IN SELECT "id" FROM "organizations" LOOP
    PERFORM set_config('app.org_id', o."id"::text, true);
    UPDATE "contacts" SET "channel" = CASE "source" WHEN 'manual' THEN 'manual' WHEN 'whatsapp' THEN 'whatsapp' WHEN 'meta_ctwa' THEN 'facebook' ELSE 'other' END;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
END $$;--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test): solo el administrador.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('attribution.view', 'tenant', 'attribution.view');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'attribution.view');
