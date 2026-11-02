-- F2 (ADR-58): tareas que se repiten. `task_recurrences` es una tabla de NEGOCIO: solo app_rw y sin DELETE ni TRUNCATE (la serie termina con `ended_at`).
REVOKE ALL ON TABLE "task_recurrences" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "task_recurrences" TO "app_rw";
