CREATE TABLE "member_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"changed_by" uuid,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_history_kind_valid" CHECK ("member_history"."kind" IN ('invited', 'invitation_cancelled', 'role_changed', 'permissions_changed', 'queues_changed', 'deactivated', 'reactivated', 'removed', 'sessions_revoked'))
);
--> statement-breakpoint
CREATE TABLE "member_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"membership_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"effect" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "member_permissions_effect_valid" CHECK ("member_permissions"."effect" IN ('grant', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "setup" jsonb;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "member_history" ADD CONSTRAINT "member_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_history" ADD CONSTRAINT "member_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_history" ADD CONSTRAINT "member_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_permissions" ADD CONSTRAINT "member_permissions_membership_id_organization_members_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."organization_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_permissions" ADD CONSTRAINT "member_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_history_org_idx" ON "member_history" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "member_history_user_idx" ON "member_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "member_permissions_member_key_uq" ON "member_permissions" USING btree ("membership_id","permission_key") WHERE "member_permissions"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_revoked_reason_valid" CHECK ("organization_members"."revoked_reason" IS NULL OR "organization_members"."revoked_reason" IN ('deactivated', 'removed'));