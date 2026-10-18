-- M4.2 (ADR-49): el asesor opera sus oportunidades (crear, mover, editar, borrar), con alcance PROPIO. Fuente en código: src/rbac/catalog.ts (vigilada por test).
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('advisor', 'opportunities.write');
