CREATE TABLE "business_hours" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"queue_id" uuid,
	"days" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_hours_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "business_hours_scope_valid" CHECK (("business_hours"."scope" = 'org' AND "business_hours"."queue_id" IS NULL) OR ("business_hours"."scope" = 'queue' AND "business_hours"."queue_id" IS NOT NULL)),
	CONSTRAINT "business_hours_days_shape" CHECK (jsonb_typeof("business_hours"."days") = 'array' AND jsonb_array_length("business_hours"."days") = 7)
);
--> statement-breakpoint
ALTER TABLE "business_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "holidays" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"name" text NOT NULL,
	"yearly" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "holidays_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "holidays_name_shape" CHECK (length(btrim("holidays"."name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "holidays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "response_timers" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"reassign_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"response_seconds" integer,
	"replied_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "response_timers_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "response_timers_kind_valid" CHECK ("response_timers"."kind" IN ('first', 'followup')),
	CONSTRAINT "response_timers_stop_reason_valid" CHECK ("response_timers"."stop_reason" IS NULL OR "response_timers"."stop_reason" IN ('human_reply', 'closed', 'transferred', 'reassigned')),
	CONSTRAINT "response_timers_stopped_pair" CHECK (("response_timers"."stopped_at" IS NULL) = ("response_timers"."stop_reason" IS NULL)),
	CONSTRAINT "response_timers_response_pair" CHECK (("response_timers"."response_seconds" IS NOT NULL) = ("response_timers"."stop_reason" IS NOT DISTINCT FROM 'human_reply')),
	CONSTRAINT "response_timers_response_valid" CHECK ("response_timers"."response_seconds" IS NULL OR "response_timers"."response_seconds" >= 0),
	CONSTRAINT "response_timers_reassign_first_only" CHECK ("response_timers"."reassign_at" IS NULL OR "response_timers"."kind" = 'first')
);
--> statement-breakpoint
ALTER TABLE "response_timers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"target_minutes" integer DEFAULT 15 NOT NULL,
	"risk_minutes" integer DEFAULT 3 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_policies_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "sla_policies_target_valid" CHECK ("sla_policies"."target_minutes" BETWEEN 1 AND 1440),
	CONSTRAINT "sla_policies_risk_valid" CHECK ("sla_policies"."risk_minutes" BETWEEN 0 AND 1440)
);
--> statement-breakpoint
ALTER TABLE "sla_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "rotations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tried_owners" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "respect_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "reassign_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "max_rotations" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_timers" ADD CONSTRAINT "response_timers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_timers" ADD CONSTRAINT "response_timers_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_timers" ADD CONSTRAINT "response_timers_message_fk" FOREIGN KEY ("organization_id","replied_message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_hours_org_uq" ON "business_hours" USING btree ("organization_id") WHERE "business_hours"."scope" = 'org';--> statement-breakpoint
CREATE UNIQUE INDEX "business_hours_queue_uq" ON "business_hours" USING btree ("organization_id","queue_id") WHERE "business_hours"."scope" = 'queue';--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_org_day_uq" ON "holidays" USING btree ("organization_id","day") WHERE "holidays"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "response_timers_one_open_uq" ON "response_timers" USING btree ("organization_id","conversation_id") WHERE "response_timers"."stopped_at" IS NULL;--> statement-breakpoint
CREATE INDEX "response_timers_due_idx" ON "response_timers" USING btree ("organization_id","due_at") WHERE "response_timers"."stopped_at" IS NULL;--> statement-breakpoint
CREATE INDEX "response_timers_reassign_idx" ON "response_timers" USING btree ("organization_id","reassign_at") WHERE "response_timers"."stopped_at" IS NULL AND "response_timers"."reassign_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "response_timers_conversation_idx" ON "response_timers" USING btree ("organization_id","conversation_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policies_org_uq" ON "sla_policies" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_rotations_valid" CHECK ("conversations"."rotations" >= 0);--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_reassign_valid" CHECK ("queues"."reassign_minutes" BETWEEN 0 AND 1440);--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_rotations_valid" CHECK ("queues"."max_rotations" BETWEEN 1 AND 10);--> statement-breakpoint
CREATE POLICY "business_hours_tenant_isolation" ON "business_hours" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "holidays_tenant_isolation" ON "holidays" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "response_timers_tenant_isolation" ON "response_timers" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "sla_policies_tenant_isolation" ON "sla_policies" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "sla_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_hours" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holidays" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "response_timers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Permiso nuevo (Build Spec §5.2; fuente en código: src/rbac/catalog.ts, vigilada por test): política de respuesta, horario laboral y feriados. Solo el administrador.
INSERT INTO "permissions" ("key", "scope", "description") VALUES
  ('sla.manage', 'tenant', 'sla.manage');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") VALUES
  ('client_admin', 'sla.manage');
