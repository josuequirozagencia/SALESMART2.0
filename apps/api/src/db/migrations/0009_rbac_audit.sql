CREATE TABLE "audit_logs" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"actor_user_id" uuid,
	"acting_as" text,
	"acting_org_id" uuid,
	"source" text NOT NULL,
	"request_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "audit_logs_source_valid" CHECK ("audit_logs"."source" IN ('manual', 'ai', 'automation', 'ghl', 'meta', 'api')),
	CONSTRAINT "audit_logs_acting_as_valid" CHECK ("audit_logs"."acting_as" IS NULL OR "audit_logs"."acting_as" IN ('super_admin', 'agency')),
	CONSTRAINT "audit_logs_entity_type_shape" CHECK ("audit_logs"."entity_type" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "permissions_scope_valid" CHECK ("permissions"."scope" IN ('platform', 'tenant')),
	CONSTRAINT "permissions_key_shape" CHECK ("permissions"."key" ~ '^[a-z][a-z_]*(\.[a-z_]+)*$')
);
--> statement-breakpoint
CREATE TABLE "platform_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"target_org_id" uuid,
	"details" jsonb,
	"request_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_key" text NOT NULL,
	"permission_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "roles_scope_valid" CHECK ("roles"."scope" IN ('platform', 'tenant'))
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("organization_id","entity_type","entity_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_uq" ON "role_permissions" USING btree ("role_key","permission_key");--> statement-breakpoint
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
