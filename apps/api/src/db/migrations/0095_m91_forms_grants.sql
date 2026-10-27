-- M9.1 (ADR-54): forms y form_fields son tablas de NEGOCIO, solo app_rw. forms no se borra (borrado lógico); form_fields se reescribe entera al guardar el constructor (por eso lleva DELETE, como los pivotes).
-- form_submissions es SOLO INSERCIÓN: es la evidencia de lo que se recibió. form_routes es de IDENTIDAD (el visitante llega sin sesión): solo app_identity, sin DELETE.
REVOKE ALL ON TABLE "forms", "form_fields", "form_submissions" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "forms" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "form_fields" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "form_submissions" TO "app_rw";--> statement-breakpoint
REVOKE ALL ON TABLE "form_routes" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "form_routes" TO "app_identity";
