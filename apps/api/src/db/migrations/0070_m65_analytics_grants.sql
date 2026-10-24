-- M6.5 (ADR-51): tablas de NEGOCIO, solo app_rw. El registro de descargas es solo de inserción (sin UPDATE ni DELETE); los ajustes se cambian, no se borran.
REVOKE ALL ON TABLE "analytics_exports", "analytics_settings" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "analytics_exports" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "analytics_settings" TO "app_rw";
