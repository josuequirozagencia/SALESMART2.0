CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"max_users" integer,
	"max_connections" integer,
	"max_queues" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_len" CHECK (length(btrim("plans"."name")) BETWEEN 2 AND 60),
	CONSTRAINT "plans_description_len" CHECK ("plans"."description" IS NULL OR length("plans"."description") <= 200),
	CONSTRAINT "plans_limits_range" CHECK (("plans"."max_users" IS NULL OR "plans"."max_users" BETWEEN 1 AND 100000) AND ("plans"."max_connections" IS NULL OR "plans"."max_connections" BETWEEN 1 AND 100000) AND ("plans"."max_queues" IS NULL OR "plans"."max_queues" BETWEEN 1 AND 100000)),
	CONSTRAINT "plans_features_object" CHECK (jsonb_typeof("plans"."features") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plans_name_uq" ON "plans" USING btree (lower(btrim("name")));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_platform_no_plan" CHECK ("organizations"."kind" <> 'platform' OR "organizations"."plan_id" IS NULL);