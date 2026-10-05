-- M1.3 (ADR-25): password_resets es tabla de identidad; solo app_identity (SELECT/INSERT/UPDATE), sin DELETE.
REVOKE ALL ON TABLE "password_resets" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "password_resets" TO "app_identity";
