-- M5.6c (ADR-50): mensajes programados. Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (un mensaje se resuelve y queda como historial).
REVOKE ALL ON TABLE "scheduled_messages" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "scheduled_messages" TO "app_rw";
