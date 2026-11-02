-- F1 (ADR-57): menciones «@» y centro de avisos. Tablas de NEGOCIO: solo app_rw y sin DELETE ni TRUNCATE.
--  - message_mentions: SOLO INSERCIÓN (una nota no se edita, sus menciones no cambian).
--  - notifications: se inserta y solo se actualiza `read_at` (marcar leído).
REVOKE ALL ON TABLE "message_mentions", "notifications" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "message_mentions" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "notifications" TO "app_rw";--> statement-breakpoint
-- Permisos nuevos (fuente en código: src/rbac/catalog.ts, vigilada por test): ver los avisos propios (entra en el techo de solo lectura) y marcarlos como leídos (escritura).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('notifications.read', 'tenant', 'notifications.read'),
  ('notifications.write', 'tenant', 'notifications.write');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'notifications.read'),
  ('client_admin', 'notifications.write'),
  ('advisor', 'notifications.read'),
  ('advisor', 'notifications.write')
ON CONFLICT DO NOTHING;
