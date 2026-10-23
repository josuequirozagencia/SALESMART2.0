-- M5.6d (ADR-50): adjuntos de mensajes. Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (un adjunto que ya no sirve pasa a infected/expired y su archivo se borra del almacenamiento).
REVOKE ALL ON TABLE "message_attachments" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "message_attachments" TO "app_rw";
