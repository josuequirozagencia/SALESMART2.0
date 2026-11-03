CREATE TABLE "company_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"deletion_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_via" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"ready_notice_at" timestamp with time zone,
	"download_token_hash" text,
	CONSTRAINT "company_exports_state_valid" CHECK ("company_exports"."state" IN ('queued', 'running', 'ready', 'failed', 'expired')),
	CONSTRAINT "company_exports_via_valid" CHECK ("company_exports"."requested_via" IN ('platform', 'owner')),
	CONSTRAINT "company_exports_parts_array" CHECK (jsonb_typeof("company_exports"."parts") = 'array'),
	CONSTRAINT "company_exports_counts_object" CHECK (jsonb_typeof("company_exports"."counts") = 'object'),
	CONSTRAINT "company_exports_download_token_hex" CHECK ("company_exports"."download_token_hash" IS NULL OR "company_exports"."download_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "company_exports_ready_consistent" CHECK (("company_exports"."state" IN ('ready', 'expired')) = ("company_exports"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD COLUMN "export_token_hash" text;--> statement-breakpoint
ALTER TABLE "company_exports" ADD CONSTRAINT "company_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_exports" ADD CONSTRAINT "company_exports_deletion_id_organization_deletions_id_fk" FOREIGN KEY ("deletion_id") REFERENCES "public"."organization_deletions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_exports" ADD CONSTRAINT "company_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_exports_download_token_uq" ON "company_exports" USING btree ("download_token_hash") WHERE "company_exports"."download_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "company_exports_open_uq" ON "company_exports" USING btree ("organization_id") WHERE "company_exports"."state" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "company_exports_org_idx" ON "company_exports" USING btree ("organization_id","requested_at");--> statement-breakpoint
CREATE INDEX "company_exports_work_idx" ON "company_exports" USING btree ("state","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_deletions_export_token_uq" ON "organization_deletions" USING btree ("export_token_hash") WHERE "organization_deletions"."export_token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_deletions" ADD CONSTRAINT "organization_deletions_export_token_hex" CHECK ("organization_deletions"."export_token_hash" IS NULL OR "organization_deletions"."export_token_hash" ~ '^[0-9a-f]{64}$');