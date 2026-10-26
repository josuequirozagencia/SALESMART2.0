-- M8.2 (ADR-53): tablas de NEGOCIO de conocimiento, solo app_rw. Los documentos se cambian pero no se borran (borrado lógico); los fragmentos son datos derivados y se reescriben al reprocesar (DELETE permitido).
REVOKE ALL ON TABLE "knowledge_documents", "document_chunks" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "knowledge_documents" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "document_chunks" TO "app_rw";--> statement-breakpoint
-- Precios de los modelos: tabla de PLATAFORMA, solo app_platform (se editan, no se borran).
REVOKE ALL ON TABLE "ai_model_prices" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ai_model_prices" TO "app_platform";
