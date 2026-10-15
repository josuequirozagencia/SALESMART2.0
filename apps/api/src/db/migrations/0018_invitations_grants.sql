-- M2.3 (ADR-39): invitations es tabla de identidad. Solo app_identity: SELECT/INSERT/UPDATE (sin DELETE: una fila por organización y correo, acotada).
REVOKE ALL ON TABLE "invitations" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "invitations" TO "app_identity";
