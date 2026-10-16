CREATE TABLE "access_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ip_hash" text,
	CONSTRAINT "access_sessions_actor_role_valid" CHECK ("access_sessions"."actor_role" IN ('super_admin', 'agency')),
	CONSTRAINT "access_sessions_end_reason_valid" CHECK ("access_sessions"."end_reason" IS NULL OR "access_sessions"."end_reason" IN ('switch', 'return', 'access_removed', 'session_ended')),
	CONSTRAINT "access_sessions_end_consistent" CHECK (("access_sessions"."ended_at" IS NULL) = ("access_sessions"."end_reason" IS NULL) AND ("access_sessions"."ended_at" IS NULL OR "access_sessions"."ended_at" >= "access_sessions"."started_at")),
	CONSTRAINT "access_sessions_ip_hash_hex" CHECK ("access_sessions"."ip_hash" IS NULL OR "access_sessions"."ip_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "agency_access_level" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
-- Las sesiones existentes nacieron en su organización activa: ese es su origen (se rellena antes de exigir NOT NULL).
ALTER TABLE "sessions" ADD COLUMN "home_org_id" uuid;--> statement-breakpoint
UPDATE "sessions" SET "home_org_id" = "active_org_id";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "home_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_sessions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_sessions_org_idx" ON "access_sessions" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "access_sessions_actor_idx" ON "access_sessions" USING btree ("actor_user_id","started_at");--> statement-breakpoint
CREATE INDEX "access_sessions_started_idx" ON "access_sessions" USING btree ("started_at","id");--> statement-breakpoint
CREATE INDEX "access_sessions_open_idx" ON "access_sessions" USING btree ("session_id") WHERE "access_sessions"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_home_org_id_organizations_id_fk" FOREIGN KEY ("home_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_agency_access_level_valid" CHECK ("organizations"."agency_access_level" IN ('read', 'advisor', 'admin'));