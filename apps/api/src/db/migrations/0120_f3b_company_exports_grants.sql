-- F3b (ADR-59 #8): company_exports es tabla de IDENTIDAD. Solo app_identity: SELECT/INSERT/UPDATE, SIN DELETE (las limpia el borrado definitivo, F3c); app_rw y app_platform no tienen ningún privilegio.
REVOKE ALL ON TABLE "company_exports" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "company_exports" TO "app_identity";--> statement-breakpoint
-- Permiso de plataforma para pedir y descargar el paquete de una empresa eliminada (solo el Súper Admin). Fuente en código: src/rbac/catalog.ts, vigilada por test.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('platform.companies.export', 'platform', 'platform.companies.export');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('super_admin', 'platform.companies.export');
