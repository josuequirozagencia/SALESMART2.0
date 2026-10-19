-- M5.2 (ADR-50): conversaciones, mensajes y eventos del webhook. Tablas de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (los mensajes no se borran; una conversación se cierra).
REVOKE ALL ON TABLE "conversations", "messages", "webhook_events" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "conversations", "messages", "webhook_events" TO "app_rw";
