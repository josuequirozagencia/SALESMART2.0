-- ADR-25: las tablas de identidad (fuera de RLS) solo son accesibles por app_identity.
-- Sin DELETE/TRUNCATE: la identidad se desactiva (status/deleted_at/revoked_at), no se borra.
-- app_rw y app_platform NO reciben ningún privilegio sobre estas tablas.
REVOKE ALL ON TABLE "users", "organizations", "organization_members" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "users", "organizations", "organization_members" TO "app_identity";
