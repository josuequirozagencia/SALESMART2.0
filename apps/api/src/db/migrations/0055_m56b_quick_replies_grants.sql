-- M5.6b (ADR-50): respuestas rápidas. Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (una respuesta borrada se marca con `deleted_at`).
REVOKE ALL ON TABLE "quick_replies" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "quick_replies" TO "app_rw";
