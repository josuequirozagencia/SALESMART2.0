-- V24: permiso para asignar o cambiar el departamento de una conversación (fuente en código: src/rbac/catalog.ts, vigilada por test). Solo el administrador.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('inbox.set_queue', 'tenant', 'inbox.set_queue');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'inbox.set_queue');--> statement-breakpoint
-- Las conversaciones abiertas sin departamento toman el de su conexión (si está vigente). Las finalizadas y las eliminadas no se tocan. La asignación pasa a «manual» para no
-- consumir el tope diario del departamento. Empresa por empresa: con RLS forzada, un UPDATE sin app.org_id no tocaría ninguna fila.
DO $$ DECLARE o RECORD; BEGIN
  FOR o IN SELECT "id" FROM "organizations" LOOP
    PERFORM set_config('app.org_id', o."id"::text, true);
    UPDATE "conversations" c SET "queue_id" = ca."queue_id", "assignment_source" = 'manual', "updated_at" = now()
      FROM "channel_accounts" ca
      JOIN "queues" q ON q."organization_id" = ca."organization_id" AND q."id" = ca."queue_id" AND q."deleted_at" IS NULL
      WHERE c."organization_id" = o."id" AND ca."organization_id" = c."organization_id" AND ca."id" = c."channel_account_id"
        AND c."queue_id" IS NULL AND c."status" <> 'closed' AND c."deleted_at" IS NULL;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
END $$;
