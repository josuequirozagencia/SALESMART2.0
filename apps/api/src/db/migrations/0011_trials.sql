CREATE TABLE "trial_config" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"days" integer NOT NULL,
	"extension_days" integer NOT NULL,
	"retention_days" integer NOT NULL,
	"welcome_credits" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_config_singleton" CHECK ("trial_config"."id" = true),
	CONSTRAINT "trial_config_ranges" CHECK ("trial_config"."days" BETWEEN 1 AND 90 AND "trial_config"."extension_days" BETWEEN 1 AND 30 AND "trial_config"."retention_days" BETWEEN 1 AND 365 AND "trial_config"."welcome_credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expired_at" timestamp with time zone,
	"ext_status" text DEFAULT 'none' NOT NULL,
	"ext_reason" text,
	"ext_requested_at" timestamp with time zone,
	"ext_decided_by" uuid,
	"ext_decided_at" timestamp with time zone,
	"ext_days_granted" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trials_org_uq" UNIQUE("organization_id"),
	CONSTRAINT "trials_status_valid" CHECK ("trials"."status" IN ('active', 'expired')),
	CONSTRAINT "trials_expired_consistent" CHECK (("trials"."status" = 'expired') = ("trials"."expired_at" IS NOT NULL)),
	CONSTRAINT "trials_period_valid" CHECK ("trials"."ends_at" > "trials"."started_at"),
	CONSTRAINT "trials_ext_status_valid" CHECK ("trials"."ext_status" IN ('none', 'pending', 'approved', 'denied')),
	CONSTRAINT "trials_ext_reason_len" CHECK ("trials"."ext_reason" IS NULL OR length(btrim("trials"."ext_reason")) BETWEEN 10 AND 500),
	CONSTRAINT "trials_ext_consistent" CHECK (("trials"."ext_status" = 'none' AND "trials"."ext_reason" IS NULL AND "trials"."ext_requested_at" IS NULL AND "trials"."ext_decided_by" IS NULL AND "trials"."ext_decided_at" IS NULL AND "trials"."ext_days_granted" IS NULL)
        OR ("trials"."ext_status" = 'pending' AND "trials"."ext_reason" IS NOT NULL AND "trials"."ext_requested_at" IS NOT NULL AND "trials"."ext_decided_by" IS NULL AND "trials"."ext_decided_at" IS NULL AND "trials"."ext_days_granted" IS NULL)
        OR ("trials"."ext_status" = 'approved' AND "trials"."ext_reason" IS NOT NULL AND "trials"."ext_requested_at" IS NOT NULL AND "trials"."ext_decided_by" IS NOT NULL AND "trials"."ext_decided_at" IS NOT NULL AND "trials"."ext_days_granted" > 0)
        OR ("trials"."ext_status" = 'denied' AND "trials"."ext_reason" IS NOT NULL AND "trials"."ext_requested_at" IS NOT NULL AND "trials"."ext_decided_by" IS NOT NULL AND "trials"."ext_decided_at" IS NOT NULL AND "trials"."ext_days_granted" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_ext_decided_by_users_id_fk" FOREIGN KEY ("ext_decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trials_ends_active_idx" ON "trials" USING btree ("ends_at") WHERE "trials"."status" = 'active';--> statement-breakpoint
CREATE INDEX "trials_ext_pending_idx" ON "trials" USING btree ("ext_requested_at") WHERE "trials"."ext_status" = 'pending';