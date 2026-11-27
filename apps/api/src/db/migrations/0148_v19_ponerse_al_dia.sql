ALTER TABLE "qr_accounts" ADD COLUMN "last_catch_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD COLUMN "last_catch_up_found" integer;--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD COLUMN "last_catch_up_recovered" integer;--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD COLUMN "last_catch_up_truncated" boolean;--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD COLUMN "last_catch_up_error" text;--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD CONSTRAINT "qr_accounts_catch_up_counts" CHECK (("qr_accounts"."last_catch_up_found" IS NULL OR "qr_accounts"."last_catch_up_found" >= 0) AND ("qr_accounts"."last_catch_up_recovered" IS NULL OR "qr_accounts"."last_catch_up_recovered" >= 0));--> statement-breakpoint
ALTER TABLE "qr_accounts" ADD CONSTRAINT "qr_accounts_catch_up_error_len" CHECK ("qr_accounts"."last_catch_up_error" IS NULL OR length("qr_accounts"."last_catch_up_error") <= 300);
