CREATE TABLE "ai_tool_calls" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tool_calls_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_tool_calls_tool_valid" CHECK ("ai_tool_calls"."tool" IN ('update_contact_fields', 'create_task', 'transfer_to_person')),
	CONSTRAINT "ai_tool_calls_outcome_valid" CHECK ("ai_tool_calls"."outcome" IN ('done', 'unchanged', 'rejected', 'error')),
	CONSTRAINT "ai_tool_calls_detail_len" CHECK ("ai_tool_calls"."detail" IS NULL OR length("ai_tool_calls"."detail") <= 500)
);
--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_conversation_state" DROP CONSTRAINT "ai_conversation_state_reason_valid";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "capture_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tasks_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tool_calls_conversation_idx" ON "ai_tool_calls" USING btree ("organization_id","conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_capture_fields_valid" CHECK (cardinality("agents"."capture_fields") <= 10);--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_reason_valid" CHECK ("ai_conversation_state"."reason" IS NULL OR "ai_conversation_state"."reason" IN ('requested', 'turn_limit', 'unsupported_media', 'ai_error', 'no_support', 'agent_decision', 'human_message', 'human_took', 'manual', 'no_credits'));--> statement-breakpoint
CREATE POLICY "ai_tool_calls_tenant_isolation" ON "ai_tool_calls" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ai_tool_calls" FORCE ROW LEVEL SECURITY;
