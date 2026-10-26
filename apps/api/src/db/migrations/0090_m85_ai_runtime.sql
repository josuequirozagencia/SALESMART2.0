CREATE TABLE "ai_conversation_state" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"resumed_at" timestamp with time zone,
	"handled_until" timestamp with time zone,
	"turns" integer DEFAULT 0 NOT NULL,
	"unsupported_streak" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversation_state_pk" PRIMARY KEY("organization_id","conversation_id"),
	CONSTRAINT "ai_conversation_state_status_valid" CHECK ("ai_conversation_state"."status" IN ('active', 'paused', 'handed_off')),
	CONSTRAINT "ai_conversation_state_reason_valid" CHECK ("ai_conversation_state"."reason" IS NULL OR "ai_conversation_state"."reason" IN ('requested', 'turn_limit', 'unsupported_media', 'ai_error', 'no_support', 'human_message', 'human_took', 'manual', 'no_credits')),
	CONSTRAINT "ai_conversation_state_reason_by_status" CHECK (("ai_conversation_state"."status" = 'active') = ("ai_conversation_state"."reason" IS NULL)),
	CONSTRAINT "ai_conversation_state_counts_valid" CHECK ("ai_conversation_state"."version" >= 1 AND "ai_conversation_state"."turns" >= 0 AND "ai_conversation_state"."unsupported_streak" >= 0 AND "ai_conversation_state"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversation_state_due_idx" ON "ai_conversation_state" USING btree ("organization_id","next_attempt_at") WHERE "ai_conversation_state"."status" = 'active';--> statement-breakpoint
CREATE POLICY "ai_conversation_state_tenant_isolation" ON "ai_conversation_state" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ai_conversation_state" FORCE ROW LEVEL SECURITY;
