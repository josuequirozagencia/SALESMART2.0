-- M3.1 (ADR-43): contactos. Tablas de NEGOCIO: solo app_rw, SIN DELETE ni TRUNCATE (borrado lógico con deleted_at); app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "contacts", "contact_phones" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "contacts", "contact_phones" TO "app_rw";--> statement-breakpoint
-- Permisos nuevos (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test). Sin `contacts.view_all` el alcance es PROPIO.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('contacts.view_all', 'tenant', 'contacts.view_all'),
  ('contacts.delete', 'tenant', 'contacts.delete');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'contacts.view_all'),
  ('client_admin', 'contacts.delete'),
  -- ADR-32 #3: el asesor crea contactos asignados a sí mismo y edita los suyos (alcance propio, lo aplica el servidor)
  ('advisor', 'contacts.write');
