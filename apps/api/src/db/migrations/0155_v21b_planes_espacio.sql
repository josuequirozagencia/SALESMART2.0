CREATE TABLE "storage_grants" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'grant' NOT NULL,
	"plan_id" uuid,
	"plan_name" text NOT NULL,
	"extra_bytes" bigint NOT NULL,
	"price_amount" numeric(14, 2),
	"currency" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"revokes_grant_id" uuid,
	"origin" text DEFAULT 'manual' NOT NULL,
	"granted_by" uuid,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_grants_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "storage_grants_kind_valid" CHECK ("storage_grants"."kind" IN ('grant', 'revoke')),
	CONSTRAINT "storage_grants_origin_valid" CHECK ("storage_grants"."origin" IN ('manual', 'payment')),
	CONSTRAINT "storage_grants_shape" CHECK (("storage_grants"."kind" = 'grant' AND "storage_grants"."extra_bytes" > 0 AND "storage_grants"."revokes_grant_id" IS NULL) OR ("storage_grants"."kind" = 'revoke' AND "storage_grants"."extra_bytes" = 0 AND "storage_grants"."revokes_grant_id" IS NOT NULL)),
	CONSTRAINT "storage_grants_period_valid" CHECK ("storage_grants"."ends_at" IS NULL OR "storage_grants"."ends_at" > "storage_grants"."starts_at"),
	CONSTRAINT "storage_grants_bytes_valid" CHECK ("storage_grants"."extra_bytes" <= 10995116277760),
	CONSTRAINT "storage_grants_text_len" CHECK (length(btrim("storage_grants"."plan_name")) BETWEEN 1 AND 80 AND ("storage_grants"."reason" IS NULL OR length("storage_grants"."reason") <= 300) AND length("storage_grants"."idempotency_key") BETWEEN 8 AND 120)
);
--> statement-breakpoint
ALTER TABLE "storage_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "storage_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"extra_bytes" bigint NOT NULL,
	"price_amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"period" text DEFAULT 'monthly' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_plans_name_len" CHECK (length(btrim("storage_plans"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "storage_plans_bytes_valid" CHECK ("storage_plans"."extra_bytes" BETWEEN 1 AND 10995116277760),
	CONSTRAINT "storage_plans_price_valid" CHECK ("storage_plans"."price_amount" >= 0 AND "storage_plans"."price_amount" <= 1000000),
	CONSTRAINT "storage_plans_currency_valid" CHECK ("storage_plans"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "storage_plans_period_valid" CHECK ("storage_plans"."period" IN ('monthly'))
);
--> statement-breakpoint
CREATE TABLE "storage_requests" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"requested_plan_id" uuid,
	"plan_name" text,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"requested_by" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_requests_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "storage_requests_status_valid" CHECK ("storage_requests"."status" IN ('open', 'granted', 'dismissed')),
	CONSTRAINT "storage_requests_note_len" CHECK ("storage_requests"."note" IS NULL OR length("storage_requests"."note") <= 300),
	CONSTRAINT "storage_requests_resolved_consistent" CHECK (("storage_requests"."status" = 'open') = ("storage_requests"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "storage_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_grants" ADD CONSTRAINT "storage_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_grants" ADD CONSTRAINT "storage_grants_revokes_fk" FOREIGN KEY ("organization_id","revokes_grant_id") REFERENCES "public"."storage_grants"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_requests" ADD CONSTRAINT "storage_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_requests" ADD CONSTRAINT "storage_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_grants_org_idem_uq" ON "storage_grants" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_grants_one_revoke_uq" ON "storage_grants" USING btree ("organization_id","revokes_grant_id") WHERE "storage_grants"."revokes_grant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "storage_grants_org_period_idx" ON "storage_grants" USING btree ("organization_id","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_requests_one_open_uq" ON "storage_requests" USING btree ("organization_id") WHERE "storage_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "storage_requests_org_created_idx" ON "storage_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE POLICY "storage_grants_tenant_isolation" ON "storage_grants" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "storage_requests_tenant_isolation" ON "storage_requests" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
ALTER TABLE "storage_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- V21b (ADR-75): el espacio concedido es de SOLO INSERCIÓN (anular = insertar una fila de anulación); las solicitudes se insertan y se resuelven (UPDATE), sin DELETE.
REVOKE ALL ON TABLE "storage_grants", "storage_requests" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "storage_grants" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "storage_requests" TO "app_rw";--> statement-breakpoint
-- Catálogo de planes: tabla de PLATAFORMA (solo app_platform); sin DELETE, un plan se desactiva.
REVOKE ALL ON TABLE "storage_plans" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "storage_plans" TO "app_platform";--> statement-breakpoint
-- Planes de ejemplo (el Súper Admin los edita o los reemplaza en Plataforma › Espacio).
INSERT INTO "storage_plans" ("id", "name", "extra_bytes", "price_amount", "currency", "sort") VALUES
  ('01938e00-0000-7000-8000-000000000a01', 'Extra S', 5368709120, 3.00, 'USD', 1),
  ('01938e00-0000-7000-8000-000000000a02', 'Extra M', 21474836480, 8.00, 'USD', 2),
  ('01938e00-0000-7000-8000-000000000a03', 'Extra L', 53687091200, 15.00, 'USD', 3),
  ('01938e00-0000-7000-8000-000000000a04', 'Extra XL', 107374182400, 25.00, 'USD', 4);--> statement-breakpoint
-- Permiso de plataforma (fuente en código: src/rbac/catalog.ts, vigilada por test). Solo el Súper Admin.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('platform.storage.manage', 'platform', 'platform.storage.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('super_admin', 'platform.storage.manage')
ON CONFLICT DO NOTHING;
