-- M2.2 (ADR-38): plans es tabla de identidad. Solo app_identity: SELECT/INSERT/UPDATE (sin DELETE: los planes se archivan).
REVOKE ALL ON TABLE "plans" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "plans" TO "app_identity";--> statement-breakpoint
-- Permisos nuevos de la consola de plataforma (Build Spec §5.2). Fuente en código: src/rbac/catalog.ts, vigilada por test.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('platform.plans.manage', 'platform', 'platform.plans.manage'),
  ('platform.companies.manage', 'platform', 'platform.companies.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('super_admin', 'platform.plans.manage'),
  ('super_admin', 'platform.companies.manage');
