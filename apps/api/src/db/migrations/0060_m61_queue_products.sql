CREATE TABLE "queue_products" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"queue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'product' NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_products_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "queue_products_name_shape" CHECK (length(btrim("queue_products"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "queue_products_kind_valid" CHECK ("queue_products"."kind" IN ('product', 'service')),
	CONSTRAINT "queue_products_price_valid" CHECK ("queue_products"."price" >= 0 AND "queue_products"."price" < 1000000000)
);
--> statement-breakpoint
ALTER TABLE "queue_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_products" ADD CONSTRAINT "queue_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_products" ADD CONSTRAINT "queue_products_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_products_queue_name_uq" ON "queue_products" USING btree ("organization_id","queue_id",lower("name"));--> statement-breakpoint
CREATE INDEX "queue_products_queue_idx" ON "queue_products" USING btree ("organization_id","queue_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_currency_iso4217" CHECK ("organizations"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
CREATE POLICY "queue_products_tenant_isolation" ON "queue_products" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "queue_products" FORCE ROW LEVEL SECURITY;
