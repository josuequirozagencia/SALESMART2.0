CREATE TABLE "opportunities" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"lost_reason" text,
	"closed_at" timestamp with time zone,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "opportunities_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "opportunities_status_valid" CHECK ("opportunities"."status" IN ('open', 'won', 'lost')),
	CONSTRAINT "opportunities_amount_valid" CHECK ("opportunities"."amount" >= 0),
	CONSTRAINT "opportunities_currency_valid" CHECK ("opportunities"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "opportunities_lost_reason_consistent" CHECK (("opportunities"."status" = 'lost') = ("opportunities"."lost_reason" IS NOT NULL)),
	CONSTRAINT "opportunities_lost_reason_len" CHECK ("opportunities"."lost_reason" IS NULL OR length(btrim("opportunities"."lost_reason")) BETWEEN 1 AND 200),
	CONSTRAINT "opportunities_closed_consistent" CHECK (("opportunities"."status" = 'open') = ("opportunities"."closed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "opportunities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text DEFAULT 'open' NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"color" text DEFAULT 'blue' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pipeline_stages_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "pipeline_stages_org_pipeline_id_uq" UNIQUE("organization_id","pipeline_id","id"),
	CONSTRAINT "pipeline_stages_name_shape" CHECK (length(btrim("pipeline_stages"."name")) BETWEEN 1 AND 40),
	CONSTRAINT "pipeline_stages_kind_valid" CHECK ("pipeline_stages"."kind" IN ('open', 'won', 'lost')),
	CONSTRAINT "pipeline_stages_color_valid" CHECK ("pipeline_stages"."color" IN ('blue', 'teal', 'violet', 'amber', 'green', 'red', 'pink', 'gray')),
	CONSTRAINT "pipeline_stages_position_valid" CHECK ("pipeline_stages"."position" >= 0),
	CONSTRAINT "pipeline_stages_won_visible" CHECK (NOT ("pipeline_stages"."kind" = 'won' AND "pipeline_stages"."is_hidden"))
);
--> statement-breakpoint
ALTER TABLE "pipeline_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pipelines" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"appointment_stage_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pipelines_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "pipelines_name_shape" CHECK (length(btrim("pipelines"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "pipelines_position_valid" CHECK ("pipelines"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stage_history" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"user_id" uuid,
	"origin" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_history_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "stage_history_origin_valid" CHECK ("stage_history"."origin" IN ('manual', 'ai', 'automation', 'ghl', 'meta', 'api', 'system'))
);
--> statement-breakpoint
ALTER TABLE "stage_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_pipeline_fk" FOREIGN KEY ("organization_id","pipeline_id") REFERENCES "public"."pipelines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_stage_fk" FOREIGN KEY ("organization_id","pipeline_id","stage_id") REFERENCES "public"."pipeline_stages"("organization_id","pipeline_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_fk" FOREIGN KEY ("organization_id","pipeline_id") REFERENCES "public"."pipelines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_opportunity_fk" FOREIGN KEY ("organization_id","opportunity_id") REFERENCES "public"."opportunities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_from_fk" FOREIGN KEY ("organization_id","from_stage_id") REFERENCES "public"."pipeline_stages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_to_fk" FOREIGN KEY ("organization_id","to_stage_id") REFERENCES "public"."pipeline_stages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_one_open_uq" ON "opportunities" USING btree ("organization_id","pipeline_id","contact_id") WHERE "opportunities"."status" = 'open' AND "opportunities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "opportunities_stage_idx" ON "opportunities" USING btree ("organization_id","stage_id","stage_entered_at","id") WHERE "opportunities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "opportunities_contact_idx" ON "opportunities" USING btree ("organization_id","contact_id") WHERE "opportunities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "opportunities_owner_idx" ON "opportunities" USING btree ("organization_id","owner_id") WHERE "opportunities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_name_uq" ON "pipeline_stages" USING btree ("organization_id","pipeline_id",lower("name")) WHERE "pipeline_stages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_one_won_uq" ON "pipeline_stages" USING btree ("organization_id","pipeline_id") WHERE "pipeline_stages"."kind" = 'won' AND "pipeline_stages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_one_lost_uq" ON "pipeline_stages" USING btree ("organization_id","pipeline_id") WHERE "pipeline_stages"."kind" = 'lost' AND "pipeline_stages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pipeline_stages_pipeline_idx" ON "pipeline_stages" USING btree ("organization_id","pipeline_id","position") WHERE "pipeline_stages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_org_name_uq" ON "pipelines" USING btree ("organization_id",lower("name")) WHERE "pipelines"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stage_history_opportunity_idx" ON "stage_history" USING btree ("organization_id","opportunity_id","at");--> statement-breakpoint
CREATE POLICY "opportunities_tenant_isolation" ON "opportunities" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "pipeline_stages_tenant_isolation" ON "pipeline_stages" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "pipelines_tenant_isolation" ON "pipelines" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "stage_history_tenant_isolation" ON "stage_history" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "pipelines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stage_history" FORCE ROW LEVEL SECURITY;
