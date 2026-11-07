-- M3.3 §12 (aprobado el 2026-11-07): permiso del panel de rendimiento de anuncios. Fuente en código: src/rbac/catalog.ts (vigilada por test). Solo el administrador.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('attribution.view', 'tenant', 'attribution.view');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'attribution.view');
