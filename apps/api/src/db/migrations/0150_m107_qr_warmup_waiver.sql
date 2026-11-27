ALTER TABLE "qr_accounts" ADD COLUMN "warmup_waived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD COLUMN "warmup_waived_at" timestamp with time zone;