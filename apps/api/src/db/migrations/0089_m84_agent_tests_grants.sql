-- M8.4 (ADR-53): agent_test_runs es tabla de NEGOCIO, solo app_rw, de solo inserción (metadatos de cada turno del simulador: sin UPDATE, DELETE ni TRUNCATE).
REVOKE ALL ON TABLE "agent_test_runs" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "agent_test_runs" TO "app_rw";
