CREATE TABLE "ai_media_runs" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"model" text NOT NULL,
	"seconds" integer,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_media_runs_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_media_runs_kind_valid" CHECK ("ai_media_runs"."kind" IN ('image', 'audio')),
	CONSTRAINT "ai_media_runs_outcome_valid" CHECK ("ai_media_runs"."outcome" IN ('ok', 'failed')),
	CONSTRAINT "ai_media_runs_counts_valid" CHECK ("ai_media_runs"."bytes" >= 0 AND ("ai_media_runs"."seconds" IS NULL OR "ai_media_runs"."seconds" >= 0))
);
--> statement-breakpoint
ALTER TABLE "ai_media_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_conversation_state" DROP CONSTRAINT "ai_conversation_state_reason_valid";--> statement-breakpoint
ALTER TABLE "ai_model_prices" DROP CONSTRAINT "ai_model_prices_kind_valid";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "read_images" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "transcribe_audio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_limits" ADD COLUMN "transcriptions_per_day" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_limits" ADD COLUMN "images_per_day" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_limits" ADD COLUMN "audio_max_seconds" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD COLUMN "vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD COLUMN "usd_per_minute" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "ai_media_runs" ADD CONSTRAINT "ai_media_runs_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_media_runs" ADD CONSTRAINT "ai_media_runs_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_media_runs_recent_idx" ON "ai_media_runs" USING btree ("organization_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_reason_valid" CHECK ("ai_conversation_state"."reason" IS NULL OR "ai_conversation_state"."reason" IN ('requested', 'turn_limit', 'unsupported_media', 'ai_error', 'no_support', 'agent_decision', 'empty_reply', 'human_message', 'human_took', 'manual', 'no_credits', 'audio_too_long', 'media_blocked', 'daily_limit'));--> statement-breakpoint
ALTER TABLE "ai_limits" ADD CONSTRAINT "ai_limits_transcriptions_valid" CHECK ("ai_limits"."transcriptions_per_day" >= 1 AND "ai_limits"."transcriptions_per_day" <= 10000);--> statement-breakpoint
ALTER TABLE "ai_limits" ADD CONSTRAINT "ai_limits_images_valid" CHECK ("ai_limits"."images_per_day" >= 1 AND "ai_limits"."images_per_day" <= 10000);--> statement-breakpoint
ALTER TABLE "ai_limits" ADD CONSTRAINT "ai_limits_audio_seconds_valid" CHECK ("ai_limits"."audio_max_seconds" >= 15 AND "ai_limits"."audio_max_seconds" <= 300);--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_minute_valid" CHECK (("ai_model_prices"."kind" = 'transcription') = ("ai_model_prices"."usd_per_minute" IS NOT NULL) AND ("ai_model_prices"."usd_per_minute" IS NULL OR ("ai_model_prices"."usd_per_minute" >= 0 AND "ai_model_prices"."usd_per_minute" <= 10000)));--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_vision_valid" CHECK ("ai_model_prices"."vision" = false OR "ai_model_prices"."kind" = 'chat');--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_kind_valid" CHECK ("ai_model_prices"."kind" IN ('embedding', 'chat', 'transcription'));--> statement-breakpoint
CREATE POLICY "ai_media_runs_tenant_isolation" ON "ai_media_runs" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ai_media_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- v13 S5 (ADR-70): ai_media_runs es tabla de NEGOCIO, solo app_rw, de solo inserción (metadatos de cada imagen o audio que un agente leyó: sin el contenido; sin UPDATE, DELETE ni TRUNCATE).
REVOKE ALL ON TABLE "ai_media_runs" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_media_runs" TO "app_rw";--> statement-breakpoint
-- Los modelos de chat que ya estaban cargados y que entienden imágenes (el Súper Admin ajusta el resto en «Modelos de IA»).
UPDATE "ai_model_prices" SET "vision" = true WHERE "kind" = 'chat' AND "model" IN ('gpt-4o-mini', 'gpt-4o');
