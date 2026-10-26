-- M8.5b (ADR-53): ai_tool_calls es tabla de NEGOCIO, solo app_rw, SOLO INSERCIÓN: es la evidencia de lo que hizo la IA y nadie la edita ni la borra.
REVOKE ALL ON TABLE "ai_tool_calls" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_tool_calls" TO "app_rw";
