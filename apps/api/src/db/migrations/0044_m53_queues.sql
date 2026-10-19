CREATE TABLE "queue_distribution_state" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"queue_id" uuid NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_distribution_state_pk" PRIMARY KEY("organization_id","queue_id")
);
--> statement-breakpoint
ALTER TABLE "queue_distribution_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_members" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"queue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_members_pk" PRIMARY KEY("organization_id","queue_id","user_id"),
	CONSTRAINT "queue_members_weight_valid" CHECK ("queue_members"."weight" BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "queue_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queues" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#7c5cfa' NOT NULL,
	"distribution_on" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'equal' NOT NULL,
	"batch" integer DEFAULT 1 NOT NULL,
	"daily_cap" integer DEFAULT 0 NOT NULL,
	"only_unassigned" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "queues_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "queues_name_shape" CHECK (length(btrim("queues"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "queues_color_shape" CHECK ("queues"."color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "queues_mode_valid" CHECK ("queues"."mode" IN ('equal', 'weighted', 'load')),
	CONSTRAINT "queues_batch_valid" CHECK ("queues"."batch" BETWEEN 1 AND 50),
	CONSTRAINT "queues_cap_valid" CHECK ("queues"."daily_cap" BETWEEN 0 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "queues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN "queue_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "queue_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queue_distribution_state" ADD CONSTRAINT "queue_distribution_state_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_members_user_idx" ON "queue_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queues_org_name_uq" ON "queues" USING btree ("organization_id",lower("name")) WHERE "queues"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_queue_fk" FOREIGN KEY ("organization_id","queue_id") REFERENCES "public"."queues"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_owner_idx" ON "conversations" USING btree ("organization_id","owner_id","status");--> statement-breakpoint
CREATE INDEX "conversations_assigned_idx" ON "conversations" USING btree ("organization_id","queue_id","assigned_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_status" CHECK ("conversations"."status" = 'closed' OR (("conversations"."status" = 'unassigned') = ("conversations"."owner_id" IS NULL)));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_pair" CHECK (("conversations"."owner_id" IS NULL) = ("conversations"."assigned_at" IS NULL));--> statement-breakpoint
CREATE POLICY "queue_distribution_state_tenant_isolation" ON "queue_distribution_state" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "queue_members_tenant_isolation" ON "queue_members" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "queues_tenant_isolation" ON "queues" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "queues" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue_distribution_state" FORCE ROW LEVEL SECURITY;
