CREATE TABLE "channel_accounts" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"is_official" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credentials_sealed" text,
	"key_version" integer,
	"token_last4" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "channel_accounts_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "channel_accounts_provider_valid" CHECK ("channel_accounts"."provider" IN ('meta_cloud', 'evolution')),
	CONSTRAINT "channel_accounts_status_valid" CHECK ("channel_accounts"."status" IN ('active', 'disabled')),
	CONSTRAINT "channel_accounts_name_shape" CHECK (length(btrim("channel_accounts"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "channel_accounts_last4_shape" CHECK ("channel_accounts"."token_last4" IS NULL OR length("channel_accounts"."token_last4") = 4),
	CONSTRAINT "channel_accounts_credentials_pair" CHECK (("channel_accounts"."credentials_sealed" IS NULL) = ("channel_accounts"."key_version" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "channel_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_routes" (
	"phone_number_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_routes_phone_id_shape" CHECK ("channel_routes"."phone_number_id" ~ '^[0-9]{5,25}$')
);
--> statement-breakpoint
CREATE TABLE "whatsapp_accounts" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_phone" text,
	"verified_name" text,
	"last_check_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_accounts_waba_shape" CHECK ("whatsapp_accounts"."waba_id" ~ '^[0-9]{5,25}$'),
	CONSTRAINT "whatsapp_accounts_phone_id_shape" CHECK ("whatsapp_accounts"."phone_number_id" ~ '^[0-9]{5,25}$'),
	CONSTRAINT "whatsapp_accounts_error_len" CHECK ("whatsapp_accounts"."last_error" IS NULL OR length("whatsapp_accounts"."last_error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_routes" ADD CONSTRAINT "channel_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_accounts_org_name_uq" ON "channel_accounts" USING btree ("organization_id",lower("name")) WHERE "channel_accounts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "channel_routes_org_idx" ON "channel_routes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_accounts_channel_uq" ON "whatsapp_accounts" USING btree ("organization_id","channel_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_accounts_phone_active_uq" ON "whatsapp_accounts" USING btree ("organization_id","phone_number_id") WHERE "whatsapp_accounts"."active";--> statement-breakpoint
CREATE POLICY "channel_accounts_tenant_isolation" ON "channel_accounts" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "whatsapp_accounts_tenant_isolation" ON "whatsapp_accounts" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "channel_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" FORCE ROW LEVEL SECURITY;
