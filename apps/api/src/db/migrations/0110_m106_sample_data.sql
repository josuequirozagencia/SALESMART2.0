ALTER TABLE "agents" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "sample_key" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "sample_key" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "sample_key" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sample_seeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "sample_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_sample_key_uq" ON "agents" USING btree ("organization_id","sample_key") WHERE "agents"."sample_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automations_sample_key_uq" ON "automations" USING btree ("organization_id","sample_key") WHERE "automations"."sample_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "forms_sample_key_uq" ON "forms" USING btree ("organization_id","sample_key") WHERE "forms"."sample_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "queues_sample_key_uq" ON "queues" USING btree ("organization_id","sample_key") WHERE "queues"."sample_key" IS NOT NULL;