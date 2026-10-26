CREATE TABLE "ai_holds" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"credits" integer NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_holds_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_holds_credits_valid" CHECK ("ai_holds"."credits" > 0),
	CONSTRAINT "ai_holds_kind_valid" CHECK ("ai_holds"."kind" IN ('use', 'test')),
	CONSTRAINT "ai_holds_status_valid" CHECK ("ai_holds"."status" IN ('active', 'settled', 'released', 'expired')),
	CONSTRAINT "ai_holds_ref_len" CHECK ("ai_holds"."ref" IS NULL OR length("ai_holds"."ref") <= 200)
);
--> statement-breakpoint
ALTER TABLE "ai_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_ledger" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"credits" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"ref" text,
	"cost_usd" numeric(14, 6),
	"margin_pct" numeric(7, 2),
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_ledger_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_ledger_kind_valid" CHECK ("ai_ledger"."kind" IN ('welcome', 'grant', 'use', 'test')),
	CONSTRAINT "ai_ledger_sign_by_kind" CHECK (("ai_ledger"."kind" IN ('welcome', 'grant') AND "ai_ledger"."credits" > 0) OR ("ai_ledger"."kind" IN ('use', 'test') AND "ai_ledger"."credits" < 0)),
	CONSTRAINT "ai_ledger_balance_valid" CHECK ("ai_ledger"."balance_after" >= 0),
	CONSTRAINT "ai_ledger_ref_len" CHECK ("ai_ledger"."ref" IS NULL OR length("ai_ledger"."ref") <= 200),
	CONSTRAINT "ai_ledger_key_shape" CHECK ("ai_ledger"."idempotency_key" IS NULL OR length("ai_ledger"."idempotency_key") BETWEEN 8 AND 100)
);
--> statement-breakpoint
ALTER TABLE "ai_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_org_pricing" (
	"target_org_id" uuid PRIMARY KEY NOT NULL,
	"margin_pct" numeric(7, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "ai_org_pricing_margin_valid" CHECK ("ai_org_pricing"."margin_pct" >= 0 AND "ai_org_pricing"."margin_pct" <= 1000)
);
--> statement-breakpoint
CREATE TABLE "ai_pricing" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"usd_per_credit" numeric(10, 6) DEFAULT '0.01' NOT NULL,
	"global_margin_pct" numeric(7, 2) DEFAULT '100' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "ai_pricing_singleton" CHECK ("ai_pricing"."id" = 1),
	CONSTRAINT "ai_pricing_price_valid" CHECK ("ai_pricing"."usd_per_credit" > 0 AND "ai_pricing"."usd_per_credit" <= 100),
	CONSTRAINT "ai_pricing_margin_valid" CHECK ("ai_pricing"."global_margin_pct" >= 0 AND "ai_pricing"."global_margin_pct" <= 1000)
);
--> statement-breakpoint
CREATE TABLE "ai_wallets" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"balance_cache" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_wallets_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_wallets_balance_valid" CHECK ("ai_wallets"."balance_cache" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_wallets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_ledger" ADD CONSTRAINT "ai_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_holds_active_idx" ON "ai_holds" USING btree ("organization_id","created_at") WHERE "ai_holds"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_ledger_org_key_uq" ON "ai_ledger" USING btree ("organization_id","idempotency_key") WHERE "ai_ledger"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_ledger_recent_idx" ON "ai_ledger" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_wallets_org_uq" ON "ai_wallets" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "ai_holds_tenant_isolation" ON "ai_holds" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "ai_ledger_tenant_isolation" ON "ai_ledger" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "ai_wallets_tenant_isolation" ON "ai_wallets" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ai_wallets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- La fila única del precio de los créditos (valores de EJEMPLO de ADR-19: 0,01 USD por crédito y margen 100 %; el Súper Admin carga los reales).
INSERT INTO "ai_pricing" ("id") VALUES (1);
