ALTER TABLE "ai_holds" DROP CONSTRAINT "ai_holds_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_ledger" DROP CONSTRAINT "ai_ledger_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_ledger" DROP CONSTRAINT "ai_ledger_sign_by_kind";--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "variant_index" smallint;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "body_variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_holds" ADD CONSTRAINT "ai_holds_kind_valid" CHECK ("ai_holds"."kind" IN ('use', 'test', 'suggest', 'follow_up', 'variants'));--> statement-breakpoint
ALTER TABLE "ai_ledger" ADD CONSTRAINT "ai_ledger_kind_valid" CHECK ("ai_ledger"."kind" IN ('welcome', 'grant', 'use', 'test', 'suggest', 'follow_up', 'variants'));--> statement-breakpoint
ALTER TABLE "ai_ledger" ADD CONSTRAINT "ai_ledger_sign_by_kind" CHECK (("ai_ledger"."kind" IN ('welcome', 'grant') AND "ai_ledger"."credits" > 0) OR ("ai_ledger"."kind" IN ('use', 'test', 'suggest', 'follow_up', 'variants') AND "ai_ledger"."credits" < 0));--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_variant_valid" CHECK ("campaign_recipients"."variant_index" IS NULL OR "campaign_recipients"."variant_index" BETWEEN 0 AND 10);--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_variants_shape" CHECK (jsonb_typeof("campaigns"."body_variants") = 'array' AND jsonb_array_length("campaigns"."body_variants") <= 10 AND ("campaigns"."mode" = 'text' OR jsonb_array_length("campaigns"."body_variants") = 0));