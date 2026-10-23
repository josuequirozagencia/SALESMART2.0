CREATE TABLE "sale_change_requests" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_change_requests_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "sale_change_requests_status_valid" CHECK ("sale_change_requests"."status" IN ('open', 'resolved', 'dismissed')),
	CONSTRAINT "sale_change_requests_reason_len" CHECK (length(btrim("sale_change_requests"."reason")) BETWEEN 1 AND 500),
	CONSTRAINT "sale_change_requests_note_len" CHECK ("sale_change_requests"."resolution_note" IS NULL OR length("sale_change_requests"."resolution_note") <= 500),
	CONSTRAINT "sale_change_requests_resolved_consistent" CHECK (("sale_change_requests"."status" = 'open') = ("sale_change_requests"."resolved_at" IS NULL AND "sale_change_requests"."resolved_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sale_change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"method" text,
	"note" text,
	"reason" text,
	"idempotency_key" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_payments_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "sale_payments_kind_valid" CHECK ("sale_payments"."kind" IN ('payment', 'correction')),
	CONSTRAINT "sale_payments_amount_valid" CHECK ("sale_payments"."amount" > 0 AND "sale_payments"."amount" < 1000000000),
	CONSTRAINT "sale_payments_method_valid" CHECK ("sale_payments"."method" IS NULL OR "sale_payments"."method" IN ('cash', 'transfer', 'card', 'other')),
	CONSTRAINT "sale_payments_shape" CHECK (("sale_payments"."kind" = 'payment' AND "sale_payments"."method" IS NOT NULL) OR ("sale_payments"."kind" = 'correction' AND "sale_payments"."reason" IS NOT NULL AND length(btrim("sale_payments"."reason")) BETWEEN 1 AND 500)),
	CONSTRAINT "sale_payments_note_len" CHECK ("sale_payments"."note" IS NULL OR length("sale_payments"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "sale_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sale_status_history" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_status_history_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "sale_status_history_status_valid" CHECK ("sale_status_history"."to_status" IN ('active', 'cancelled') AND ("sale_status_history"."from_status" IS NULL OR "sale_status_history"."from_status" IN ('active', 'cancelled')))
);
--> statement-breakpoint
ALTER TABLE "sale_status_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"opportunity_id" uuid,
	"queue_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"product_kind" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"seller_id" uuid NOT NULL,
	"note" text,
	"idempotency_key" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"purchase_at_cancel" text,
	CONSTRAINT "sales_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "sales_amount_valid" CHECK ("sales"."amount" > 0 AND "sales"."amount" < 1000000000),
	CONSTRAINT "sales_quantity_valid" CHECK ("sales"."quantity" BETWEEN 1 AND 9999),
	CONSTRAINT "sales_currency_shape" CHECK ("sales"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "sales_status_valid" CHECK ("sales"."status" IN ('active', 'cancelled')),
	CONSTRAINT "sales_product_kind_valid" CHECK ("sales"."product_kind" IN ('product', 'service')),
	CONSTRAINT "sales_note_len" CHECK ("sales"."note" IS NULL OR length("sales"."note") BETWEEN 1 AND 500),
	CONSTRAINT "sales_key_shape" CHECK (length("sales"."idempotency_key") BETWEEN 8 AND 100),
	CONSTRAINT "sales_purchase_at_cancel_valid" CHECK ("sales"."purchase_at_cancel" IS NULL OR "sales"."purchase_at_cancel" IN ('cancelled', 'sent', 'skipped', 'none')),
	CONSTRAINT "sales_cancel_consistent" CHECK (("sales"."status" = 'cancelled') = ("sales"."cancelled_at" IS NOT NULL AND "sales"."cancelled_by" IS NOT NULL AND "sales"."cancel_reason" IS NOT NULL)),
	CONSTRAINT "sales_cancel_reason_len" CHECK ("sales"."cancel_reason" IS NULL OR length(btrim("sales"."cancel_reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "response_timers" DROP CONSTRAINT "response_timers_stop_reason_valid";--> statement-breakpoint
ALTER TABLE "sale_change_requests" ADD CONSTRAINT "sale_change_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_change_requests" ADD CONSTRAINT "sale_change_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_change_requests" ADD CONSTRAINT "sale_change_requests_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_status_history" ADD CONSTRAINT "sale_status_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_status_history" ADD CONSTRAINT "sale_status_history_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_opportunity_fk" FOREIGN KEY ("organization_id","opportunity_id") REFERENCES "public"."opportunities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."queue_products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_change_requests_sale_idx" ON "sale_change_requests" USING btree ("organization_id","sale_id","created_at");--> statement-breakpoint
CREATE INDEX "sale_change_requests_open_idx" ON "sale_change_requests" USING btree ("organization_id","created_at") WHERE "sale_change_requests"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "sale_payments_org_key_uq" ON "sale_payments" USING btree ("organization_id","idempotency_key") WHERE "sale_payments"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sale_payments_sale_idx" ON "sale_payments" USING btree ("organization_id","sale_id","created_at");--> statement-breakpoint
CREATE INDEX "sale_status_history_sale_idx" ON "sale_status_history" USING btree ("organization_id","sale_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_org_key_uq" ON "sales" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sales_contact_idx" ON "sales" USING btree ("organization_id","contact_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_seller_idx" ON "sales" USING btree ("organization_id","seller_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_created_idx" ON "sales" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "response_timers" ADD CONSTRAINT "response_timers_stop_reason_valid" CHECK ("response_timers"."stop_reason" IS NULL OR "response_timers"."stop_reason" IN ('human_reply', 'closed', 'transferred', 'reassigned', 'sale'));--> statement-breakpoint
CREATE POLICY "sale_change_requests_tenant_isolation" ON "sale_change_requests" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "sale_payments_tenant_isolation" ON "sale_payments" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "sale_status_history_tenant_isolation" ON "sale_status_history" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "sales_tenant_isolation" ON "sales" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de las tablas la elude fuera de las migraciones.
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sale_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sale_status_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sale_change_requests" FORCE ROW LEVEL SECURITY;
