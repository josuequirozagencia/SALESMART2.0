-- M5.6a (ADR-50): plantillas de WhatsApp sincronizadas desde Meta. Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (una plantilla que Meta ya no devuelve se marca con `deleted_at`).
REVOKE ALL ON TABLE "message_templates" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "message_templates" TO "app_rw";
