-- M7.1 (ADR-52): ghl_connections es tabla de NEGOCIO, solo app_rw, sin DELETE ni TRUNCATE (al desconectar se borra el token y el estado pasa a `disconnected`).
REVOKE ALL ON TABLE "ghl_connections" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ghl_connections" TO "app_rw";--> statement-breakpoint
-- ghl_routes es tabla de IDENTIDAD (el Workflow de GHL llega sin sesión): solo app_identity, sin DELETE (una fila por empresa; rotar el secreto la reemplaza).
REVOKE ALL ON TABLE "ghl_routes" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ghl_routes" TO "app_identity";
