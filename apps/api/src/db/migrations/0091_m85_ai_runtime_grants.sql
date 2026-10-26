-- M8.5 (ADR-53): ai_conversation_state es tabla de NEGOCIO, solo app_rw. Se crea y se actualiza (estado, arrendamiento, contadores) pero no se borra: la conversación conserva su historial con el agente.
REVOKE ALL ON TABLE "ai_conversation_state" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ai_conversation_state" TO "app_rw";
