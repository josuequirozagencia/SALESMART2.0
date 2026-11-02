-- M6.6 (ADR-55 fase A): historial de toques. Tabla de NEGOCIO, SOLO inserción: app_rw con SELECT e INSERT (sin UPDATE ni DELETE: el pasado no se reescribe); app_platform y app_identity sin acceso.
REVOKE ALL ON TABLE "contact_touch_events" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "contact_touch_events" TO "app_rw";
