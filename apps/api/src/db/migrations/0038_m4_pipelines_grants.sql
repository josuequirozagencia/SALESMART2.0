-- M4 (ADR-49): pipelines, etapas, oportunidades e historial. Tablas de NEGOCIO: solo app_rw; app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "pipelines", "pipeline_stages", "opportunities", "stage_history" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
-- pipelines, etapas y oportunidades: borrado lógico (sin DELETE ni TRUNCATE).
GRANT SELECT, INSERT, UPDATE ON TABLE "pipelines", "pipeline_stages", "opportunities" TO "app_rw";--> statement-breakpoint
-- El historial de etapas es APPEND-ONLY: la aplicación solo lee e inserta.
GRANT SELECT, INSERT ON TABLE "stage_history" TO "app_rw";--> statement-breakpoint
-- Etapa de cita opcional (ADR-18): debe ser una etapa del MISMO pipeline y de la misma organización. Con la etapa en NULL la clave no se evalúa.
-- Está aquí y no en el esquema de drizzle porque es circular con pipeline_stages_pipeline_fk.
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_appointment_stage_fk" FOREIGN KEY ("organization_id","id","appointment_stage_id") REFERENCES "public"."pipeline_stages"("organization_id","pipeline_id","id") ON DELETE no action ON UPDATE no action;
