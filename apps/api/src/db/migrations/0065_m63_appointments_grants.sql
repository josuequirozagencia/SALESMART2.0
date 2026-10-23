-- M6.3 (ADR-13/51): citas y recordatorios. Tablas de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (una cita se cancela o se completa; un recordatorio se resuelve).
REVOKE ALL ON TABLE "appointments", "appointment_reminders" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "appointments", "appointment_reminders" TO "app_rw";--> statement-breakpoint
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('appointments.read', 'tenant', 'appointments.read'),
  ('appointments.write', 'tenant', 'appointments.write'),
  ('appointments.view_all', 'tenant', 'appointments.view_all');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'appointments.read'),
  ('client_admin', 'appointments.write'),
  ('client_admin', 'appointments.view_all'),
  ('advisor', 'appointments.read'),
  ('advisor', 'appointments.write')
ON CONFLICT DO NOTHING;
