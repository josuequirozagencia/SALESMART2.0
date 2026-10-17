-- M3.4 (ADR-46): listas de contactos. Tablas de NEGOCIO: solo app_rw; app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "contact_lists", "contact_list_members" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
-- contact_lists: borrado lógico (sin DELETE ni TRUNCATE).
GRANT SELECT, INSERT, UPDATE ON TABLE "contact_lists" TO "app_rw";--> statement-breakpoint
-- Pivotes sin valor propio (ADR-46 #1): quitar una etiqueta de un contacto o un contacto de una lista fija borra la fila; el historial queda en audit_logs.
-- Excepción puntual y documentada a «app_rw sin DELETE»; TRUNCATE sigue sin concederse.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "contact_list_members" TO "app_rw";--> statement-breakpoint
GRANT DELETE ON TABLE "contact_tags" TO "app_rw";
