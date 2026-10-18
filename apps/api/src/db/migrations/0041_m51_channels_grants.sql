-- M5.1 (ADR-50): conexiones de canales. Tablas de NEGOCIO (channel_accounts, whatsapp_accounts): solo app_rw, sin DELETE ni TRUNCATE (borrado lógico).
REVOKE ALL ON TABLE "channel_accounts", "whatsapp_accounts" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "channel_accounts", "whatsapp_accounts" TO "app_rw";--> statement-breakpoint
-- channel_routes es de IDENTIDAD (el webhook de Meta llega sin sesión): solo app_identity, sin DELETE (al desconectar un número se desactiva la ruta).
REVOKE ALL ON TABLE "channel_routes" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "channel_routes" TO "app_identity";
