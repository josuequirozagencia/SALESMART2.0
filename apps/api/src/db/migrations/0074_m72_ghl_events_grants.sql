-- M7.2 (ADR-52): tablas de NEGOCIO, solo app_rw, sin DELETE ni TRUNCATE. Los avisos se vacian a los 30 dias (UPDATE) y los vinculos no se borran.
REVOKE ALL ON TABLE "ghl_events", "ghl_contact_links" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ghl_events", "ghl_contact_links" TO "app_rw";
