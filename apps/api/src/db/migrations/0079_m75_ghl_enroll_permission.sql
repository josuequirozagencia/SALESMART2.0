-- M7.5 (ADR-52): inscribir un contacto en un flujo (Workflow) de GoHighLevel. Permiso nuevo `ghl.enroll` (fuente en código: src/rbac/catalog.ts, vigilada por test): el administrador y el asesor
-- (este solo sobre los contactos que ve). Quien entra con acceso de solo lectura NO lo tiene (no está en el techo de lectura).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('ghl.enroll', 'tenant', 'ghl.enroll');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'ghl.enroll'),
  ('advisor', 'ghl.enroll')
ON CONFLICT DO NOTHING;
