CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text NOT NULL,
	"access_level" text,
	"granted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_role_valid" CHECK ("organization_members"."role" IN ('super_admin', 'agency', 'client_admin', 'advisor'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"parent_agency_id" uuid,
	"created_by_agency_id" uuid,
	"name" text NOT NULL,
	"plan_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_kind_valid" CHECK ("organizations"."kind" IN ('platform', 'agency', 'client')),
	CONSTRAINT "organizations_platform_standalone" CHECK ("organizations"."kind" <> 'platform' OR ("organizations"."parent_agency_id" IS NULL AND "organizations"."created_by_agency_id" IS NULL)),
	CONSTRAINT "organizations_parent_only_client" CHECK ("organizations"."parent_agency_id" IS NULL OR "organizations"."kind" = 'client'),
	CONSTRAINT "organizations_name_not_blank" CHECK (length(btrim("organizations"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_uq" UNIQUE("email"),
	CONSTRAINT "users_email_normalized" CHECK ("users"."email" = lower(btrim("users"."email")) AND length("users"."email") BETWEEN 3 AND 254),
	CONSTRAINT "users_status_valid" CHECK ("users"."status" IN ('pending', 'active', 'disabled')),
	CONSTRAINT "users_password_hash_argon2id" CHECK ("users"."password_hash" LIKE '$argon2id$%')
);
--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parent_agency_id_organizations_id_fk" FOREIGN KEY ("parent_agency_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_agency_id_organizations_id_fk" FOREIGN KEY ("created_by_agency_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_active_uq" ON "organization_members" USING btree ("user_id","organization_id") WHERE "organization_members"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organization_members_org_idx" ON "organization_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_single_platform" ON "organizations" USING btree ("kind") WHERE "organizations"."kind" = 'platform';--> statement-breakpoint
CREATE INDEX "organizations_parent_agency_idx" ON "organizations" USING btree ("parent_agency_id");