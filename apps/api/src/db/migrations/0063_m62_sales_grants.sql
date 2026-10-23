-- M6.2 (ADR-08/32/51): ventas. Tablas de NEGOCIO: solo app_rw. Una venta se anula (no se borra ni se edita su valor); los abonos, el historial y las solicitudes de corrección son solo de inserción.
REVOKE ALL ON TABLE "sales", "sale_payments", "sale_status_history", "sale_change_requests" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "sales" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "sale_payments", "sale_status_history" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "sale_change_requests" TO "app_rw";--> statement-breakpoint
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('sales.read', 'tenant', 'sales.read'),
  ('sales.view_all', 'tenant', 'sales.view_all'),
  ('sales.register_payment', 'tenant', 'sales.register_payment'),
  ('sales.manage', 'tenant', 'sales.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'sales.read'),
  ('client_admin', 'sales.view_all'),
  ('client_admin', 'sales.register_payment'),
  ('client_admin', 'sales.manage'),
  ('advisor', 'sales.read'),
  ('advisor', 'sales.create'),
  ('advisor', 'sales.register_payment')
ON CONFLICT DO NOTHING;
