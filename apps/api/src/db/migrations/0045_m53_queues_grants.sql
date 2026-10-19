-- M5.3 (ADR-07/ADR-50): colas y reparto. Tablas de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (una cola se archiva; quitar a un asesor es apagarlo).
REVOKE ALL ON TABLE "queues", "queue_members", "queue_distribution_state" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "queues", "queue_members", "queue_distribution_state" TO "app_rw";
