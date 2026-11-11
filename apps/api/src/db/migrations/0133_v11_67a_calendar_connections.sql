CREATE TABLE "calendar_connections" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"credentials_sealed" text,
	"key_version" integer,
	"calendar_id" text,
	"calendar_name" text,
	"account_masked" text,
	"scopes" text DEFAULT '' NOT NULL,
	"last_error" text,
	"last_check_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "calendar_connections_mode_valid" CHECK ("calendar_connections"."mode" IN ('own', 'existing')),
	CONSTRAINT "calendar_connections_status_valid" CHECK ("calendar_connections"."status" IN ('pending_calendar', 'connected', 'needs_reconnect', 'disconnected')),
	CONSTRAINT "calendar_connections_error_len" CHECK ("calendar_connections"."last_error" IS NULL OR length("calendar_connections"."last_error") <= 300),
	CONSTRAINT "calendar_connections_name_len" CHECK ("calendar_connections"."calendar_name" IS NULL OR length("calendar_connections"."calendar_name") <= 200),
	CONSTRAINT "calendar_connections_credentials_by_status" CHECK (("calendar_connections"."status" = 'disconnected' AND "calendar_connections"."credentials_sealed" IS NULL AND "calendar_connections"."key_version" IS NULL) OR ("calendar_connections"."status" <> 'disconnected' AND "calendar_connections"."credentials_sealed" IS NOT NULL AND "calendar_connections"."key_version" IS NOT NULL)),
	CONSTRAINT "calendar_connections_calendar_when_connected" CHECK ("calendar_connections"."status" <> 'connected' OR "calendar_connections"."calendar_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "calendar_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_org_uq" ON "calendar_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "calendar_connections_tenant_isolation" ON "calendar_connections" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "calendar_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- v11 Pista G (ADR-67): tabla de NEGOCIO, solo app_rw, sin DELETE (al desconectar se borra el token y el estado pasa a «disconnected»).
REVOKE ALL ON TABLE "calendar_connections" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "calendar_connections" TO "app_rw";
