ALTER TABLE "agents" ADD COLUMN "audio_fallback_text" text;--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD COLUMN "preferred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_model_prices_one_preferred_uq" ON "ai_model_prices" USING btree ("kind") WHERE "ai_model_prices"."preferred";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_audio_fallback_len" CHECK ("agents"."audio_fallback_text" IS NULL OR length(btrim("agents"."audio_fallback_text")) BETWEEN 1 AND 300);--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_preferred_valid" CHECK ("ai_model_prices"."preferred" = false OR "ai_model_prices"."kind" = 'transcription');