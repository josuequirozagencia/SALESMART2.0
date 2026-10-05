-- M1.4. (1) RBAC: datos de referencia globales; tablas de identidad (solo app_identity, SOLO LECTURA; se cambian por migración).
REVOKE ALL ON TABLE "roles", "permissions", "role_permissions" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT ON TABLE "roles", "permissions", "role_permissions" TO "app_identity";--> statement-breakpoint
-- (2) Auditoría del cliente: tenant, FORCE RLS, APPEND-ONLY (solo SELECT/INSERT; sin UPDATE/DELETE/TRUNCATE).
REVOKE ALL ON TABLE "audit_logs" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "audit_logs" TO "app_rw";--> statement-breakpoint
-- (3) Auditoría de plataforma: solo app_platform, append-only.
REVOKE ALL ON TABLE "platform_audit" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "platform_audit" TO "app_platform";--> statement-breakpoint
-- (4) SIEMBRA de roles, permisos y matriz rol→permisos (PROVISIONAL; fuente en código: src/rbac/catalog.ts, vigilada por test).
INSERT INTO "roles" ("key", "scope", "description") VALUES
  ('super_admin', 'platform', 'Plataforma: agencias, planes, proveedores, pruebas y accesos'),
  ('agency', 'tenant', 'Agencia: administra su cartera de clientes (el nivel por cliente se define en M2)'),
  ('client_admin', 'tenant', 'Administra su organización'),
  ('advisor', 'tenant', 'Ve sus chats y los que le compartieron');
--> statement-breakpoint
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('inbox.view_all', 'tenant', 'inbox.view_all'),
  ('inbox.reply', 'tenant', 'inbox.reply'),
  ('inbox.transfer', 'tenant', 'inbox.transfer'),
  ('inbox.share', 'tenant', 'inbox.share'),
  ('contacts.read', 'tenant', 'contacts.read'),
  ('contacts.write', 'tenant', 'contacts.write'),
  ('contacts.import', 'tenant', 'contacts.import'),
  ('contacts.export', 'tenant', 'contacts.export'),
  ('opportunities.read', 'tenant', 'opportunities.read'),
  ('opportunities.write', 'tenant', 'opportunities.write'),
  ('pipelines.manage', 'tenant', 'pipelines.manage'),
  ('sales.create', 'tenant', 'sales.create'),
  ('sales.cancel', 'tenant', 'sales.cancel'),
  ('appointments.manage', 'tenant', 'appointments.manage'),
  ('queues.manage', 'tenant', 'queues.manage'),
  ('tags.manage', 'tenant', 'tags.manage'),
  ('agents.manage', 'tenant', 'agents.manage'),
  ('agents.test', 'tenant', 'agents.test'),
  ('knowledge.manage', 'tenant', 'knowledge.manage'),
  ('channels.manage', 'tenant', 'channels.manage'),
  ('integrations.manage', 'tenant', 'integrations.manage'),
  ('forms.manage', 'tenant', 'forms.manage'),
  ('automations.manage', 'tenant', 'automations.manage'),
  ('commissions.view', 'tenant', 'commissions.view'),
  ('commissions.manage', 'tenant', 'commissions.manage'),
  ('analytics.view', 'tenant', 'analytics.view'),
  ('export', 'tenant', 'export'),
  ('team.manage', 'tenant', 'team.manage'),
  ('billing.manage', 'tenant', 'billing.manage'),
  ('platform.providers.manage', 'platform', 'platform.providers.manage'),
  ('platform.agencies.manage', 'platform', 'platform.agencies.manage'),
  ('platform.trials.manage', 'platform', 'platform.trials.manage'),
  ('platform.access_log.read', 'platform', 'platform.access_log.read');
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('super_admin', 'platform.providers.manage'),
  ('super_admin', 'platform.agencies.manage'),
  ('super_admin', 'platform.trials.manage'),
  ('super_admin', 'platform.access_log.read'),
  ('client_admin', 'inbox.view_all'),
  ('client_admin', 'inbox.reply'),
  ('client_admin', 'inbox.transfer'),
  ('client_admin', 'inbox.share'),
  ('client_admin', 'contacts.read'),
  ('client_admin', 'contacts.write'),
  ('client_admin', 'contacts.import'),
  ('client_admin', 'contacts.export'),
  ('client_admin', 'opportunities.read'),
  ('client_admin', 'opportunities.write'),
  ('client_admin', 'pipelines.manage'),
  ('client_admin', 'sales.create'),
  ('client_admin', 'sales.cancel'),
  ('client_admin', 'appointments.manage'),
  ('client_admin', 'queues.manage'),
  ('client_admin', 'tags.manage'),
  ('client_admin', 'agents.manage'),
  ('client_admin', 'agents.test'),
  ('client_admin', 'knowledge.manage'),
  ('client_admin', 'channels.manage'),
  ('client_admin', 'integrations.manage'),
  ('client_admin', 'forms.manage'),
  ('client_admin', 'automations.manage'),
  ('client_admin', 'commissions.view'),
  ('client_admin', 'commissions.manage'),
  ('client_admin', 'analytics.view'),
  ('client_admin', 'export'),
  ('client_admin', 'team.manage'),
  ('client_admin', 'billing.manage'),
  ('advisor', 'inbox.reply'),
  ('advisor', 'contacts.read'),
  ('advisor', 'opportunities.read');
