-- M9.6 (ADR-54): qr_accounts es una tabla de NEGOCIO (solo app_rw; una fila por conexión QR, se crea y se actualiza, no se borra: la conexión se borra de forma lógica).
-- qr_routes es de IDENTIDAD (Evolution avisa sin sesión): solo app_identity, sin DELETE (rotar el token reemplaza el hash).
REVOKE ALL ON TABLE "qr_accounts" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "qr_accounts" TO "app_rw";--> statement-breakpoint
REVOKE ALL ON TABLE "qr_routes" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "qr_routes" TO "app_identity";
