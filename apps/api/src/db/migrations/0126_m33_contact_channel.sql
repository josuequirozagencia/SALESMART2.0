-- M3.3 §11 (aprobado el 2026-11-07): canal de entrada del lead en lenguaje humano.
ALTER TABLE "contacts" ADD COLUMN "channel" varchar(20) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
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
END $$;
