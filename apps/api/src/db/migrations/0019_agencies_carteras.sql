CREATE TABLE "organization_ownership_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_agency_id" uuid,
	"to_agency_id" uuid,
	"reason" text,
	"notify_client" boolean DEFAULT true NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_history_changed" CHECK ("organization_ownership_history"."from_agency_id" IS DISTINCT FROM "organization_ownership_history"."to_agency_id"),
	CONSTRAINT "ownership_history_reason_len" CHECK ("organization_ownership_history"."reason" IS NULL OR length(btrim("organization_ownership_history"."reason")) BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_role_valid";--> statement-breakpoint
ALTER TABLE "organization_ownership_history" ADD CONSTRAINT "organization_ownership_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_ownership_history" ADD CONSTRAINT "organization_ownership_history_from_agency_id_organizations_id_fk" FOREIGN KEY ("from_agency_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_ownership_history" ADD CONSTRAINT "organization_ownership_history_to_agency_id_organizations_id_fk" FOREIGN KEY ("to_agency_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_ownership_history" ADD CONSTRAINT "organization_ownership_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ownership_history_org_idx" ON "organization_ownership_history" USING btree ("organization_id","changed_at");--> statement-breakpoint
CREATE INDEX "ownership_history_from_idx" ON "organization_ownership_history" USING btree ("from_agency_id");--> statement-breakpoint
CREATE INDEX "ownership_history_to_idx" ON "organization_ownership_history" USING btree ("to_agency_id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_valid" CHECK ("invitations"."role" IN ('client_admin', 'advisor', 'agency'));--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_access_level_valid" CHECK ("organization_members"."access_level" IS NULL OR "organization_members"."access_level" IN ('read', 'advisor', 'admin'));