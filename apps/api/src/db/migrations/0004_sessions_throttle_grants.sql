-- ADR-25/ADR-26: sessions y auth_throttle son tablas de identidad. Solo app_identity (SELECT/INSERT/UPDATE).
-- Sin DELETE: la limpieza de filas vencidas se decidirá con el job de M1.5 (requeriría enmendar ADR-25).
REVOKE ALL ON TABLE "sessions", "auth_throttle" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "sessions", "auth_throttle" TO "app_identity";
