-- M3.3 (ADR-45): etiquetas, atribución y salida de eventos. Tablas de NEGOCIO: solo app_rw, SIN DELETE ni TRUNCATE; app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "tags", "contact_tags", "meta_events" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "tags", "contact_tags", "meta_events" TO "app_rw";--> statement-breakpoint
-- attribution_endpoints es tabla de IDENTIDAD (el webhook llega sin sesión): solo app_identity, sin DELETE (una fila por empresa; regenerar la reemplaza).
REVOKE ALL ON TABLE "attribution_endpoints" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "attribution_endpoints" TO "app_identity";
