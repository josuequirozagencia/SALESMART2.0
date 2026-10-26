-- M7.5 (ADR-52): ghl_enrollments es tabla de NEGOCIO, solo app_rw, de solo inserción (historial: sin UPDATE, DELETE ni TRUNCATE).
REVOKE ALL ON TABLE "ghl_enrollments" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ghl_enrollments" TO "app_rw";
