-- M2.5 (ADR-41): access_sessions es tabla de identidad. Solo app_identity; app_rw y app_platform NO tienen ningún privilegio (lo lee el Súper Admin por la API).
-- El historial no se reescribe: sin DELETE y el UPDATE se limita a las dos columnas con las que se CIERRA una entrada (ended_at, end_reason).
REVOKE ALL ON TABLE "access_sessions" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "access_sessions" TO "app_identity";--> statement-breakpoint
GRANT UPDATE ("ended_at", "end_reason") ON TABLE "access_sessions" TO "app_identity";--> statement-breakpoint
-- Permisos de la consola «Mis clientes» de la agencia (Build Spec §5). Fuente en código: src/rbac/catalog.ts, vigilada por test.
-- Son del ámbito de organización (la agencia es una organización): solo el rol `agency` en SU organización; dentro de un cliente el acceso
-- de la agencia sale del nivel por cliente (read | advisor | admin) y nunca incluye estos permisos.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('agency.clients.read', 'tenant', 'agency.clients.read'),
  ('agency.clients.create', 'tenant', 'agency.clients.create');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('agency', 'agency.clients.read'),
  ('agency', 'agency.clients.create');
