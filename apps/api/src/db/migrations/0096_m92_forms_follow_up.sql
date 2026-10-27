ALTER TABLE "form_submissions" ADD COLUMN "follow_up" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "follow_up_task" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "follow_up_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "follow_up_template_id" uuid;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "follow_up_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_follow_up_channel_fk" FOREIGN KEY ("organization_id","follow_up_channel_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_follow_up_template_fk" FOREIGN KEY ("organization_id","follow_up_template_id") REFERENCES "public"."message_templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_follow_up_valid" CHECK ("form_submissions"."follow_up" IN ('none', 'task', 'template', 'template_task'));--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_follow_up_pair" CHECK (("forms"."follow_up_channel_id" IS NULL) = ("forms"."follow_up_template_id" IS NULL));--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_follow_up_params_shape" CHECK (jsonb_typeof("forms"."follow_up_params") = 'object' AND length("forms"."follow_up_params"::text) <= 4000);