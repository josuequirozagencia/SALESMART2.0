-- M5.5 (ADR-14/50): compartir conversaciones. Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (revocar un acceso es ponerle la hora).
REVOKE ALL ON TABLE "conversation_participants" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_participants" TO "app_rw";
