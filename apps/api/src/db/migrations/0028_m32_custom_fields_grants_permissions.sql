-- M3.2 (ADR-44): campos personalizados. Tablas de NEGOCIO: solo app_rw, SIN DELETE ni TRUNCATE (las definiciones se archivan; vaciar un valor lo deja en NULL); app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "custom_field_definitions", "custom_field_values" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "custom_field_definitions", "custom_field_values" TO "app_rw";--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test). Leer las definiciones va con `contacts.read`.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('custom_fields.manage', 'tenant', 'custom_fields.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'custom_fields.manage');
