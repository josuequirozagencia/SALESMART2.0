-- M3.6 (ADR-48): empresas, notas y tareas. Tablas de NEGOCIO: solo app_rw; app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "companies", "contact_companies", "notes", "tasks" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
-- companies, notes y tasks: borrado lógico (sin DELETE ni TRUNCATE).
GRANT SELECT, INSERT, UPDATE ON TABLE "companies", "notes", "tasks" TO "app_rw";--> statement-breakpoint
-- Pivote sin valor propio (ADR-48 #1): desvincular un contacto de una empresa borra la fila; el historial queda en audit_logs.
-- Excepción puntual y documentada a «app_rw sin DELETE»; TRUNCATE sigue sin concederse.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "contact_companies" TO "app_rw";--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test). Solo el administrador de la empresa; el asesor no crea ni edita empresas.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('companies.manage', 'tenant', 'companies.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'companies.manage');
