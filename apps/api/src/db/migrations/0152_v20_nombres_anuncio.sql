ALTER TABLE "ad_creatives" ADD COLUMN "ad_name" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "adset_id" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "adset_name" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "campaign_id" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "campaign_name" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "names_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "names_status" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_names_status_valid" CHECK ("ad_creatives"."names_status" IS NULL OR "ad_creatives"."names_status" IN ('ok', 'not_found', 'no_access', 'error'));