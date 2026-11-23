ALTER TABLE "meta_settings" ADD COLUMN "waba_id" text;--> statement-breakpoint
ALTER TABLE "meta_settings" ADD COLUMN "messaging_dataset_id" text;--> statement-breakpoint
ALTER TABLE "meta_settings" ADD CONSTRAINT "meta_settings_waba_shape" CHECK ("meta_settings"."waba_id" IS NULL OR "meta_settings"."waba_id" ~ '^[0-9]{5,30}$');--> statement-breakpoint
ALTER TABLE "meta_settings" ADD CONSTRAINT "meta_settings_messaging_dataset_shape" CHECK ("meta_settings"."messaging_dataset_id" IS NULL OR "meta_settings"."messaging_dataset_id" ~ '^[0-9]{5,30}$');