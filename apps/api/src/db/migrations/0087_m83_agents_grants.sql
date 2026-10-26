-- M8.3 (ADR-53): tablas de NEGOCIO de agentes, solo app_rw. Los agentes se cambian pero no se borran (borrado lógico); los pivotes de documentos y conexiones se escriben y se borran al cambiar la selección.
REVOKE ALL ON TABLE "agents", "agent_documents", "agent_channels" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "agents" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "agent_documents", "agent_channels" TO "app_rw";
