CREATE TABLE "ghl_connections" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"auth_type" text DEFAULT 'private_token' NOT NULL,
	"location_id" text NOT NULL,
	"credentials_sealed" text,
	"key_version" integer,
	"token_last4" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_check_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ghl_connections_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ghl_connections_auth_type_valid" CHECK ("ghl_connections"."auth_type" IN ('private_token', 'oauth')),
	CONSTRAINT "ghl_connections_location_shape" CHECK ("ghl_connections"."location_id" ~ '^[A-Za-z0-9]{8,64}$'),
	CONSTRAINT "ghl_connections_status_valid" CHECK ("ghl_connections"."status" IN ('active', 'needs_reconnect', 'disconnected')),
	CONSTRAINT "ghl_connections_last4_shape" CHECK ("ghl_connections"."token_last4" IS NULL OR length("ghl_connections"."token_last4") BETWEEN 1 AND 4),
	CONSTRAINT "ghl_connections_error_len" CHECK ("ghl_connections"."last_error" IS NULL OR length("ghl_connections"."last_error") <= 300),
	CONSTRAINT "ghl_connections_credentials_by_status" CHECK (("ghl_connections"."status" = 'disconnected' AND "ghl_connections"."credentials_sealed" IS NULL AND "ghl_connections"."key_version" IS NULL AND "ghl_connections"."token_last4" IS NULL) OR ("ghl_connections"."status" <> 'disconnected' AND "ghl_connections"."credentials_sealed" IS NOT NULL AND "ghl_connections"."key_version" IS NOT NULL AND "ghl_connections"."token_last4" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "ghl_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ghl_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "ghl_routes_secret_hash_hex" CHECK ("ghl_routes"."secret_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ghl_connections" ADD CONSTRAINT "ghl_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ghl_routes" ADD CONSTRAINT "ghl_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ghl_routes" ADD CONSTRAINT "ghl_routes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ghl_connections_org_uq" ON "ghl_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ghl_routes_org_uq" ON "ghl_routes" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "ghl_connections_tenant_isolation" ON "ghl_connections" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ghl_connections" FORCE ROW LEVEL SECURITY;
