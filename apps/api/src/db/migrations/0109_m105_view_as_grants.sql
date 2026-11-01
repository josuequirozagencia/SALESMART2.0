-- M10.5 (ADR-56 B4): view_as_log es tabla de IDENTIDAD. Solo app_identity; app_rw y app_platform NO tienen ningún privilegio (lo lee el Súper Admin por la API).
-- El historial no se reescribe: sin DELETE y el UPDATE se limita a las dos columnas con las que se CIERRA una entrada (ended_at, end_reason), como access_sessions.
REVOKE ALL ON TABLE "view_as_log" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "view_as_log" TO "app_identity";--> statement-breakpoint
GRANT UPDATE ("ended_at", "end_reason") ON TABLE "view_as_log" TO "app_identity";
