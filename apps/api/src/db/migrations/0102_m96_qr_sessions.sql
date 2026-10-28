CREATE TABLE "qr_accounts" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"instance_name" text NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"phone_e164" text,
	"profile_name" text,
	"first_connected_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"last_error" text,
	"down_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qr_accounts_state_valid" CHECK ("qr_accounts"."state" IN ('created', 'connecting', 'open', 'logged_out', 'closed')),
	CONSTRAINT "qr_accounts_instance_shape" CHECK ("qr_accounts"."instance_name" ~ '^[a-z0-9-]{8,60}$'),
	CONSTRAINT "qr_accounts_error_len" CHECK ("qr_accounts"."last_error" IS NULL OR length("qr_accounts"."last_error") <= 300)
);
--> statement-breakpoint
ALTER TABLE "qr_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "qr_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "qr_routes_token_hash_hex" CHECK ("qr_routes"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD CONSTRAINT "qr_accounts_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_routes" ADD CONSTRAINT "qr_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qr_accounts_channel_uq" ON "qr_accounts" USING btree ("organization_id","channel_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_accounts_instance_uq" ON "qr_accounts" USING btree ("instance_name");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_routes_channel_uq" ON "qr_routes" USING btree ("organization_id","channel_account_id");--> statement-breakpoint
CREATE POLICY "qr_accounts_tenant_isolation" ON "qr_accounts" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
ALTER TABLE "qr_accounts" FORCE ROW LEVEL SECURITY;
