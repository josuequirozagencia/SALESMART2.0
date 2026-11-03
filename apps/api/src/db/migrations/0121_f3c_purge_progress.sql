ALTER TABLE "organization_deletions" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD COLUMN "purge_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD COLUMN "purge_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD COLUMN "purge_error" text;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD COLUMN "purge_counts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD CONSTRAINT "organization_deletions_purged_consistent" CHECK (("organization_deletions"."state" = 'purged') = ("organization_deletions"."purged_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD CONSTRAINT "organization_deletions_purge_counts_object" CHECK (jsonb_typeof("organization_deletions"."purge_counts") = 'object');