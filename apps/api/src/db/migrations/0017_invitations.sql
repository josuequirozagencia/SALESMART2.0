CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"invited_by" uuid NOT NULL,
	"sent_count" integer DEFAULT 1 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_email_normalized" CHECK ("invitations"."email" = lower(btrim("invitations"."email")) AND length("invitations"."email") BETWEEN 3 AND 254),
	CONSTRAINT "invitations_role_valid" CHECK ("invitations"."role" IN ('client_admin', 'advisor')),
	CONSTRAINT "invitations_token_hash_hex" CHECK ("invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invitations_consumed_consistent" CHECK (("invitations"."consumed_at" IS NULL) = ("invitations"."accepted_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "signup_attempts" DROP CONSTRAINT "signup_attempts_key_shape";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_org_email_uq" ON "invitations" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_country_iso2" CHECK ("organizations"."country" IS NULL OR "organizations"."country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "signup_attempts" ADD CONSTRAINT "signup_attempts_key_shape" CHECK ("signup_attempts"."key" ~ '^[svmfrxi]:[0-9a-f]{64}$');