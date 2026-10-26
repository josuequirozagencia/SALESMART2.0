-- M8.1 (ADR-53): créditos IA. `ai.credits.view` (tenant): ver saldo y movimientos de la empresa, nunca costo ni margen; el administrador del cliente lo tiene y entra en el techo de solo lectura.
-- `platform.ai.manage` (plataforma): precio y margen de los créditos, regalos de créditos y saldos de todas las empresas; solo el Súper Admin. Fuente en código: src/rbac/catalog.ts (vigilada por test).
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('ai.credits.view', 'tenant', 'ai.credits.view'),
  ('platform.ai.manage', 'platform', 'platform.ai.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'ai.credits.view'),
  ('super_admin', 'platform.ai.manage')
ON CONFLICT DO NOTHING;
