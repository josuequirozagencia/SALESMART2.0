CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_throttle_key_shape" CHECK ("auth_throttle"."key" ~ '^[ei]:[0-9a-f]{64}$'),
	CONSTRAINT "auth_throttle_failures_nonneg" CHECK ("auth_throttle"."failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"active_org_id" uuid NOT NULL,
	"user_session_version" integer NOT NULL,
	"access_hash" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_hash" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"user_agent" text,
	CONSTRAINT "sessions_hashes_hex" CHECK ("sessions"."access_hash" ~ '^[0-9a-f]{64}$' AND "sessions"."refresh_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sessions_revoked_consistent" CHECK (("sessions"."revoked_at" IS NULL) = ("sessions"."revoke_reason" IS NULL)),
	CONSTRAINT "sessions_user_agent_len" CHECK ("sessions"."user_agent" IS NULL OR length("sessions"."user_agent") <= 200)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_org_id_organizations_id_fk" FOREIGN KEY ("active_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");