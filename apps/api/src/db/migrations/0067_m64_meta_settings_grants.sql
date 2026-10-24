-- M6.4 (ADR-45 #5/ADR-51): conexión de cada empresa con la API de Conversiones de Meta. Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (se apaga con `enabled`).
REVOKE ALL ON TABLE "meta_settings" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "meta_settings" TO "app_rw";
