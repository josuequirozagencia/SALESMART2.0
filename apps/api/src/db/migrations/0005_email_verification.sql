CREATE TABLE "disposable_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposable_domains_normalized" CHECK ("disposable_domains"."domain" = lower(btrim("disposable_domains"."domain")) AND "disposable_domains"."domain" ~ '^[a-z0-9.-]+$')
);
--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hmac" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 1 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_org_name" text NOT NULL,
	"pending_timezone" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verifications_user_uq" UNIQUE("user_id"),
	CONSTRAINT "email_verifications_code_hmac_hex" CHECK ("email_verifications"."code_hmac" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_verifications_attempts_nonneg" CHECK ("email_verifications"."attempts" >= 0),
	CONSTRAINT "email_verifications_org_name_len" CHECK (length(btrim("email_verifications"."pending_org_name")) BETWEEN 2 AND 100)
);
--> statement-breakpoint
CREATE TABLE "signup_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_attempts_key_shape" CHECK ("signup_attempts"."key" ~ '^[svm]:[0-9a-f]{64}$'),
	CONSTRAINT "signup_attempts_count_nonneg" CHECK ("signup_attempts"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;