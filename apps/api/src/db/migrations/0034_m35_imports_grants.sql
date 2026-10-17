-- M3.5 (ADR-47): importación de contactos. Tablas de NEGOCIO: solo app_rw, SIN DELETE ni TRUNCATE; app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "contact_imports", "contact_import_rows" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "contact_imports", "contact_import_rows" TO "app_rw";
