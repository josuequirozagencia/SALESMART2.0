-- M6.1 (ADR-08/ADR-51): catálogo de productos por cola. Tabla de NEGOCIO: solo app_rw, sin DELETE ni TRUNCATE (un producto que ya no se vende se desactiva).
REVOKE ALL ON TABLE "queue_products" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "queue_products" TO "app_rw";
