-- M6.5 (ADR-51): tablero y analítica. Permisos nuevos: `analytics.view_all` (toda la empresa), `analytics.export` (descargar CSV) y `analytics.manage` (ver el registro de
-- descargas y decidir si el asesor puede descargar). El asesor ve su propio tablero (`analytics.view`) y puede descargar lo suyo mientras el administrador no lo desactive.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('analytics.view_all', 'tenant', 'analytics.view_all'),
  ('analytics.export', 'tenant', 'analytics.export'),
  ('analytics.manage', 'tenant', 'analytics.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'analytics.view'),
  ('client_admin', 'analytics.view_all'),
  ('client_admin', 'analytics.export'),
  ('client_admin', 'analytics.manage'),
  ('advisor', 'analytics.view'),
  ('advisor', 'analytics.export')
ON CONFLICT DO NOTHING;
