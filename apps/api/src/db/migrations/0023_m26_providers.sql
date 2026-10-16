CREATE TABLE "provider_credentials" (
	"service" text NOT NULL,
	"provider" text NOT NULL,
	"secrets_sealed" text,
	"key_version" integer,
	"secret_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "provider_credentials_pk" PRIMARY KEY("service","provider"),
	CONSTRAINT "provider_credentials_service_shape" CHECK ("provider_credentials"."service" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "provider_credentials_provider_shape" CHECK ("provider_credentials"."provider" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "provider_credentials_sealed_consistent" CHECK (("provider_credentials"."secrets_sealed" IS NULL) = ("provider_credentials"."key_version" IS NULL)),
	CONSTRAINT "provider_credentials_key_version" CHECK ("provider_credentials"."key_version" IS NULL OR "provider_credentials"."key_version" >= 1),
	CONSTRAINT "provider_credentials_hints_object" CHECK (jsonb_typeof("provider_credentials"."secret_hints") = 'object')
);
--> statement-breakpoint
CREATE TABLE "provider_selection" (
	"service" text PRIMARY KEY NOT NULL,
	"provider" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "provider_selection_service_shape" CHECK ("provider_selection"."service" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "provider_selection_provider_shape" CHECK ("provider_selection"."provider" IS NULL OR "provider_selection"."provider" ~ '^[a-z][a-z0-9_]{1,40}$')
);
