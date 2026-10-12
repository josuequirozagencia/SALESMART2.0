ALTER TABLE "users" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_full_name_len" CHECK ("users"."full_name" IS NULL OR length(btrim("users"."full_name")) BETWEEN 2 AND 100);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164" CHECK ("users"."phone" IS NULL OR "users"."phone" ~ '^\+[1-9][0-9]{7,14}$');