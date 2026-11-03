-- F3a (ADR-59): organization_deletions es tabla de IDENTIDAD. Solo app_identity: SELECT/INSERT/UPDATE, SIN DELETE (es parte de la evidencia del borrado); app_rw y app_platform no tienen ningún privilegio.
REVOKE ALL ON TABLE "organization_deletions" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "organization_deletions" TO "app_identity";--> statement-breakpoint
-- El «dueño» de las empresas existentes (ADR-59 #7): el primer administrador que tuvo la empresa (aunque ya no esté vigente). Las agencias y la plataforma no tienen dueño.
UPDATE "organizations" o SET "owner_user_id" = (
  SELECT m."user_id" FROM "organization_members" m
   WHERE m."organization_id" = o."id" AND m."role" = 'client_admin'
   ORDER BY m."created_at", m."id" LIMIT 1)
 WHERE o."kind" = 'client' AND o."owner_user_id" IS NULL;--> statement-breakpoint
-- Permiso de plataforma para eliminar y recuperar empresas (solo el Súper Admin). Fuente en código: src/rbac/catalog.ts, vigilada por test.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('platform.companies.delete', 'platform', 'platform.companies.delete');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('super_admin', 'platform.companies.delete');
