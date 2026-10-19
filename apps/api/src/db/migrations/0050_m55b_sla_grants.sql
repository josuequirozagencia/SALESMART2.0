-- M5.5b (ADR-07/50): SLA, horario laboral y feriados. Tablas de NEGOCIO: solo app_rw, sin TRUNCATE. Un feriado se quita con borrado lógico y los cronómetros conservan su historial (sin DELETE);
-- `business_hours` es configuración sin historia (quitar el horario propio de una cola lo borra), por eso lleva DELETE.
REVOKE ALL ON TABLE "sla_policies", "business_hours", "holidays", "response_timers" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "sla_policies", "holidays", "response_timers" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "business_hours" TO "app_rw";
