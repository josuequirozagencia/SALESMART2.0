CREATE TABLE "agent_follow_up_runs" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"scenario" text DEFAULT 'stopped_replying' NOT NULL,
	"chain_inbound_at" timestamp with time zone NOT NULL,
	"anchor_at" timestamp with time zone NOT NULL,
	"owner_id" uuid,
	"step_position" smallint NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"processing_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "agent_follow_up_runs_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_follow_up_runs_scenario_valid" CHECK ("agent_follow_up_runs"."scenario" IN ('stopped_replying')),
	CONSTRAINT "agent_follow_up_runs_step_valid" CHECK ("agent_follow_up_runs"."step_position" BETWEEN 1 AND 5),
	CONSTRAINT "agent_follow_up_runs_status_valid" CHECK ("agent_follow_up_runs"."status" IN ('pending', 'sent', 'skipped', 'cancelled')),
	CONSTRAINT "agent_follow_up_runs_reason_len" CHECK ("agent_follow_up_runs"."reason" IS NULL OR length("agent_follow_up_runs"."reason") <= 80)
);
--> statement-breakpoint
ALTER TABLE "agent_follow_up_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_follow_up_steps" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"follow_up_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"delay_minutes" integer NOT NULL,
	"mode" text NOT NULL,
	"fixed_text" text,
	"start_automation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_follow_up_steps_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_follow_up_steps_position_valid" CHECK ("agent_follow_up_steps"."position" BETWEEN 1 AND 5),
	CONSTRAINT "agent_follow_up_steps_delay_valid" CHECK ("agent_follow_up_steps"."delay_minutes" BETWEEN 5 AND 10080),
	CONSTRAINT "agent_follow_up_steps_mode_valid" CHECK ("agent_follow_up_steps"."mode" IN ('ai', 'fixed_text', 'none')),
	CONSTRAINT "agent_follow_up_steps_text_valid" CHECK (("agent_follow_up_steps"."mode" = 'fixed_text' AND "agent_follow_up_steps"."fixed_text" IS NOT NULL AND length(btrim("agent_follow_up_steps"."fixed_text")) BETWEEN 1 AND 1000) OR ("agent_follow_up_steps"."mode" <> 'fixed_text' AND "agent_follow_up_steps"."fixed_text" IS NULL)),
	CONSTRAINT "agent_follow_up_steps_does_something" CHECK ("agent_follow_up_steps"."mode" <> 'none' OR "agent_follow_up_steps"."start_automation_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_follow_up_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_follow_ups" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"scenario" text DEFAULT 'stopped_replying' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_follow_ups_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_follow_ups_scenario_valid" CHECK ("agent_follow_ups"."scenario" IN ('stopped_replying'))
);
--> statement-breakpoint
ALTER TABLE "agent_follow_ups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_holds" DROP CONSTRAINT "ai_holds_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_ledger" DROP CONSTRAINT "ai_ledger_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_ledger" DROP CONSTRAINT "ai_ledger_sign_by_kind";--> statement-breakpoint
ALTER TABLE "agent_follow_up_runs" ADD CONSTRAINT "agent_follow_up_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follow_up_runs" ADD CONSTRAINT "agent_follow_up_runs_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follow_up_runs" ADD CONSTRAINT "agent_follow_up_runs_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follow_up_steps" ADD CONSTRAINT "agent_follow_up_steps_follow_up_fk" FOREIGN KEY ("organization_id","follow_up_id") REFERENCES "public"."agent_follow_ups"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follow_up_steps" ADD CONSTRAINT "agent_follow_up_steps_automation_fk" FOREIGN KEY ("organization_id","start_automation_id") REFERENCES "public"."automations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follow_ups" ADD CONSTRAINT "agent_follow_ups_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follow_ups" ADD CONSTRAINT "agent_follow_ups_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_follow_up_runs_step_uq" ON "agent_follow_up_runs" USING btree ("organization_id","conversation_id","scenario","chain_inbound_at","step_position");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_follow_up_runs_one_pending_uq" ON "agent_follow_up_runs" USING btree ("organization_id","conversation_id","scenario") WHERE "agent_follow_up_runs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_follow_up_runs_due_idx" ON "agent_follow_up_runs" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_follow_up_steps_position_uq" ON "agent_follow_up_steps" USING btree ("follow_up_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_follow_ups_agent_scenario_uq" ON "agent_follow_ups" USING btree ("organization_id","agent_id","scenario");--> statement-breakpoint
ALTER TABLE "ai_holds" ADD CONSTRAINT "ai_holds_kind_valid" CHECK ("ai_holds"."kind" IN ('use', 'test', 'suggest', 'follow_up'));--> statement-breakpoint
ALTER TABLE "ai_ledger" ADD CONSTRAINT "ai_ledger_kind_valid" CHECK ("ai_ledger"."kind" IN ('welcome', 'grant', 'use', 'test', 'suggest', 'follow_up'));--> statement-breakpoint
ALTER TABLE "ai_ledger" ADD CONSTRAINT "ai_ledger_sign_by_kind" CHECK (("ai_ledger"."kind" IN ('welcome', 'grant') AND "ai_ledger"."credits" > 0) OR ("ai_ledger"."kind" IN ('use', 'test', 'suggest', 'follow_up') AND "ai_ledger"."credits" < 0));--> statement-breakpoint
CREATE POLICY "agent_follow_up_runs_tenant_isolation" ON "agent_follow_up_runs" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "agent_follow_up_steps_tenant_isolation" ON "agent_follow_up_steps" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "agent_follow_ups_tenant_isolation" ON "agent_follow_ups" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de las tablas la elude fuera de las migraciones.
ALTER TABLE "agent_follow_ups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_follow_up_steps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_follow_up_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- v11 S5 (ADR-68): tablas de NEGOCIO, solo app_rw. agent_follow_ups y agent_follow_up_runs sin DELETE (se apagan o se resuelven); agent_follow_up_steps lleva DELETE porque la secuencia se reemplaza entera
-- al guardarla (configuración, no historial: lo ocurrido queda en agent_follow_up_runs).
REVOKE ALL ON TABLE "agent_follow_ups", "agent_follow_up_steps", "agent_follow_up_runs" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "agent_follow_ups" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_follow_up_steps" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "agent_follow_up_runs" TO "app_rw";
