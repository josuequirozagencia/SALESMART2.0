CREATE TABLE "automation_run_steps" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"action_type" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_run_steps_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "automation_run_steps_outcome_valid" CHECK ("automation_run_steps"."outcome" IN ('done', 'skipped', 'failed')),
	CONSTRAINT "automation_run_steps_detail_len" CHECK ("automation_run_steps"."detail" IS NULL OR length("automation_run_steps"."detail") <= 500)
);
--> statement-breakpoint
ALTER TABLE "automation_run_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_key" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"chain" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cause_run_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "automation_runs_status_valid" CHECK ("automation_runs"."status" IN ('queued', 'done', 'skipped', 'failed')),
	CONSTRAINT "automation_runs_depth_valid" CHECK ("automation_runs"."depth" BETWEEN 0 AND 10 AND "automation_runs"."attempts" >= 0),
	CONSTRAINT "automation_runs_context_shape" CHECK (jsonb_typeof("automation_runs"."context") = 'object' AND length("automation_runs"."context"::text) <= 2000),
	CONSTRAINT "automation_runs_reason_len" CHECK ("automation_runs"."reason" IS NULL OR length("automation_runs"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "automations" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "automations_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "automations_name_shape" CHECK (length(btrim("automations"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "automations_description_len" CHECK ("automations"."description" IS NULL OR length("automations"."description") <= 300),
	CONSTRAINT "automations_status_valid" CHECK ("automations"."status" IN ('draft', 'active', 'paused')),
	CONSTRAINT "automations_trigger_valid" CHECK ("automations"."trigger_type" IN ('contact_created', 'message_received', 'opportunity_created', 'stage_changed', 'field_changed', 'sale_created')),
	CONSTRAINT "automations_shape" CHECK (jsonb_typeof("automations"."trigger_filter") = 'object' AND jsonb_typeof("automations"."conditions") = 'array' AND jsonb_typeof("automations"."actions") = 'array' AND jsonb_array_length("automations"."conditions") <= 10 AND jsonb_array_length("automations"."actions") <= 10)
);
--> statement-breakpoint
ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."automation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "public"."automations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_steps_pos_uq" ON "automation_run_steps" USING btree ("organization_id","run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_event_uq" ON "automation_runs" USING btree ("organization_id","automation_id","event_key");--> statement-breakpoint
CREATE INDEX "automation_runs_due_idx" ON "automation_runs" USING btree ("organization_id","next_attempt_at") WHERE "automation_runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "automation_runs_automation_idx" ON "automation_runs" USING btree ("organization_id","automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_contact_idx" ON "automation_runs" USING btree ("organization_id","automation_id","contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_name_uq" ON "automations" USING btree ("organization_id",lower("name")) WHERE "automations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "automations_trigger_idx" ON "automations" USING btree ("organization_id","trigger_type") WHERE "automations"."status" = 'active' AND "automations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE POLICY "automation_run_steps_tenant_isolation" ON "automation_run_steps" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "automation_runs_tenant_isolation" ON "automation_runs" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "automations_tenant_isolation" ON "automations" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de las tablas la elude fuera de las migraciones.
ALTER TABLE "automations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_run_steps" FORCE ROW LEVEL SECURITY;
