ALTER TABLE "contacts" ADD COLUMN "photo_key" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "photo_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "photo_key" text;