-- M7.3 (ADR-52): ghl_outbox es tabla de NEGOCIO, solo app_rw, sin DELETE ni TRUNCATE (cada cambio queda como registro).
REVOKE ALL ON TABLE "ghl_outbox" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ghl_outbox" TO "app_rw";
