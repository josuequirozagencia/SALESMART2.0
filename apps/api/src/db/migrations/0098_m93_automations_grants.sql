-- M9.3 (ADR-54): automations, automation_runs y automation_run_steps son tablas de NEGOCIO, solo app_rw. automations no se borra (borrado lógico); automation_runs se crea y se actualiza (estado, intentos);
-- automation_run_steps es SOLO INSERCIÓN: es el historial de lo que hizo cada regla.
REVOKE ALL ON TABLE "automations", "automation_runs", "automation_run_steps" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "automations" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "automation_runs" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "automation_run_steps" TO "app_rw";
