-- M10.4 (ADR-56): horario laboral por persona. Tabla de NEGOCIO: solo app_rw, SIN DELETE ni TRUNCATE (quitar el horario lo desactiva); app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "user_hours" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "user_hours" TO "app_rw";
