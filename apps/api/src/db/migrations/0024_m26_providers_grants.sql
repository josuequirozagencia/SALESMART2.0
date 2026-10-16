-- M2.6 (ADR-42): proveedores de la plataforma. Tablas de PLATAFORMA: solo app_platform; app_rw (API de cliente y de agencia) y app_identity sin ningún privilegio.
-- provider_credentials: el Súper Admin guarda y quita credenciales (INSERT/UPDATE/DELETE); todo valor va cifrado y la API nunca lo devuelve (solo los últimos 4).
REVOKE ALL ON TABLE "provider_credentials", "provider_selection" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "provider_credentials" TO "app_platform";--> statement-breakpoint
-- provider_selection: una fila por servicio; «sin proveedor» es NULL (no se borra).
GRANT SELECT, INSERT, UPDATE ON TABLE "provider_selection" TO "app_platform";
