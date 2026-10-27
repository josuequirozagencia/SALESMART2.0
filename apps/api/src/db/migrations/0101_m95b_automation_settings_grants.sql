-- M9.5b (ADR-54): automation_settings es una tabla de NEGOCIO, solo app_rw. Una fila por empresa (se crea al primer cambio y se actualiza); no se borra.
REVOKE ALL ON TABLE "automation_settings" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "automation_settings" TO "app_rw";
