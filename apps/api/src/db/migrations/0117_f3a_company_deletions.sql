CREATE TABLE "organization_deletions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"organization_name" text NOT NULL,
	"plan_name" text,
	"previous_status" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"recovered_at" timestamp with time zone,
	"recovered_by" uuid,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notice_sent_at" timestamp with time zone,
	CONSTRAINT "organization_deletions_state_valid" CHECK ("organization_deletions"."state" IN ('scheduled', 'recovered', 'purging', 'purge_failed', 'purged')),
	CONSTRAINT "organization_deletions_reason_len" CHECK (length(btrim("organization_deletions"."reason")) BETWEEN 10 AND 300),
	CONSTRAINT "organization_deletions_window" CHECK ("organization_deletions"."purge_after" > "organization_deletions"."requested_at"),
	CONSTRAINT "organization_deletions_recovered_consistent" CHECK (("organization_deletions"."state" = 'recovered') = ("organization_deletions"."recovered_at" IS NOT NULL AND "organization_deletions"."recovered_by" IS NOT NULL)),
	CONSTRAINT "organization_deletions_summary_object" CHECK (jsonb_typeof("organization_deletions"."summary") = 'object')
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD CONSTRAINT "organization_deletions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD CONSTRAINT "organization_deletions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD CONSTRAINT "organization_deletions_recovered_by_users_id_fk" FOREIGN KEY ("recovered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_deletions_open_uq" ON "organization_deletions" USING btree ("organization_id") WHERE "organization_deletions"."state" IN ('scheduled', 'purging', 'purge_failed');--> statement-breakpoint
CREATE INDEX "organization_deletions_org_idx" ON "organization_deletions" USING btree ("organization_id","requested_at");--> statement-breakpoint
CREATE INDEX "organization_deletions_due_idx" ON "organization_deletions" USING btree ("purge_after") WHERE "organization_deletions"."state" = 'scheduled';--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;