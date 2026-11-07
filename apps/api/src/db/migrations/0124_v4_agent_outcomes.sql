ALTER TABLE "ai_conversation_state" ADD COLUMN "last_outcome" text;--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD COLUMN "empty_replies" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversation_state" DROP CONSTRAINT "ai_conversation_state_reason_valid";--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_reason_valid" CHECK ("ai_conversation_state"."reason" IS NULL OR "ai_conversation_state"."reason" IN ('requested', 'turn_limit', 'unsupported_media', 'ai_error', 'no_support', 'agent_decision', 'empty_reply', 'human_message', 'human_took', 'manual', 'no_credits'));--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_outcome_valid" CHECK ("ai_conversation_state"."last_outcome" IS NULL OR "ai_conversation_state"."last_outcome" = 'out_of_hours');--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_empty_valid" CHECK ("ai_conversation_state"."empty_replies" >= 0);
