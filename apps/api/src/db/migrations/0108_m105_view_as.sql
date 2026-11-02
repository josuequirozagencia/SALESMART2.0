CREATE TABLE "view_as_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"viewed_role" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "view_as_log_role_valid" CHECK ("view_as_log"."viewed_role" IN ('agency', 'client_admin', 'advisor')),
	CONSTRAINT "view_as_log_end_reason_valid" CHECK ("view_as_log"."end_reason" IS NULL OR "view_as_log"."end_reason" IN ('changed', 'cleared', 'switch', 'logout')),
	CONSTRAINT "view_as_log_end_consistent" CHECK (("view_as_log"."ended_at" IS NULL) = ("view_as_log"."end_reason" IS NULL) AND ("view_as_log"."ended_at" IS NULL OR "view_as_log"."ended_at" >= "view_as_log"."started_at"))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "view_as_role" text;--> statement-breakpoint
ALTER TABLE "view_as_log" ADD CONSTRAINT "view_as_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_as_log" ADD CONSTRAINT "view_as_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "view_as_log_org_idx" ON "view_as_log" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "view_as_log_open_idx" ON "view_as_log" USING btree ("session_id") WHERE "view_as_log"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_view_as_role_valid" CHECK ("sessions"."view_as_role" IS NULL OR "sessions"."view_as_role" IN ('agency', 'client_admin', 'advisor'));