-- M1.2 (ADR-25): tablas de identidad del registro. Solo app_identity; sin DELETE (la limpieza se decide con el job de M1.5).
-- disposable_domains es de solo lectura para la aplicación: la lista la gestiona operación con el rol propietario.
REVOKE ALL ON TABLE "email_verifications", "signup_attempts", "disposable_domains" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "email_verifications", "signup_attempts" TO "app_identity";--> statement-breakpoint
GRANT SELECT ON TABLE "disposable_domains" TO "app_identity";
