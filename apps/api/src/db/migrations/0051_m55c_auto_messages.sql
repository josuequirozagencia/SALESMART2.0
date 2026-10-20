ALTER TABLE "conversations" ADD COLUMN "out_of_hours_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "greeting_text" text;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "out_of_hours_text" text;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "auto_close_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_greeting_shape" CHECK ("queues"."greeting_text" IS NULL OR length(btrim("queues"."greeting_text")) BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_out_of_hours_shape" CHECK ("queues"."out_of_hours_text" IS NULL OR length(btrim("queues"."out_of_hours_text")) BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_auto_close_valid" CHECK ("queues"."auto_close_hours" BETWEEN 0 AND 720);