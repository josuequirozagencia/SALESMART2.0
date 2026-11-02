CREATE TABLE "task_recurrences" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"freq" text NOT NULL,
	"interval_n" smallint DEFAULT 1 NOT NULL,
	"weekdays" integer[],
	"day_of_month" smallint,
	"ends_kind" text DEFAULT 'never' NOT NULL,
	"ends_on" date,
	"ends_after" smallint,
	"occurrences_created" integer DEFAULT 1 NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_recurrences_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "task_recurrences_freq_valid" CHECK ("task_recurrences"."freq" IN ('daily', 'weekly', 'monthly')),
	CONSTRAINT "task_recurrences_interval_valid" CHECK ("task_recurrences"."interval_n" BETWEEN 1 AND 30),
	CONSTRAINT "task_recurrences_weekdays_valid" CHECK (("task_recurrences"."freq" = 'weekly') = ("task_recurrences"."weekdays" IS NOT NULL) AND ("task_recurrences"."weekdays" IS NULL OR (cardinality("task_recurrences"."weekdays") BETWEEN 1 AND 7 AND "task_recurrences"."weekdays" <@ ARRAY[0,1,2,3,4,5,6]))),
	CONSTRAINT "task_recurrences_month_day_valid" CHECK (("task_recurrences"."freq" = 'monthly') = ("task_recurrences"."day_of_month" IS NOT NULL) AND ("task_recurrences"."day_of_month" IS NULL OR "task_recurrences"."day_of_month" BETWEEN 1 AND 31)),
	CONSTRAINT "task_recurrences_ends_valid" CHECK (("task_recurrences"."ends_kind" = 'never' AND "task_recurrences"."ends_on" IS NULL AND "task_recurrences"."ends_after" IS NULL) OR ("task_recurrences"."ends_kind" = 'on' AND "task_recurrences"."ends_on" IS NOT NULL AND "task_recurrences"."ends_after" IS NULL) OR ("task_recurrences"."ends_kind" = 'after' AND "task_recurrences"."ends_after" BETWEEN 2 AND 365 AND "task_recurrences"."ends_on" IS NULL)),
	CONSTRAINT "task_recurrences_ended_valid" CHECK (("task_recurrences"."ended_at" IS NULL) = ("task_recurrences"."ended_reason" IS NULL) AND ("task_recurrences"."ended_reason" IS NULL OR "task_recurrences"."ended_reason" IN ('completed', 'stopped', 'deleted')))
);
--> statement-breakpoint
ALTER TABLE "task_recurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "occurrence_no" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "remind_before_minutes" smallint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_recurrences" ADD CONSTRAINT "task_recurrences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurrence_fk" FOREIGN KEY ("organization_id","recurrence_id") REFERENCES "public"."task_recurrences"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_task_uq" ON "notifications" USING btree ("organization_id","user_id","task_id","type") WHERE "notifications"."task_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_recurrence_occurrence_uq" ON "tasks" USING btree ("organization_id","recurrence_id","occurrence_no") WHERE "tasks"."recurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_recurrence_open_uq" ON "tasks" USING btree ("organization_id","recurrence_id") WHERE "tasks"."recurrence_id" IS NOT NULL AND "tasks"."status" = 'open' AND "tasks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_notice_idx" ON "tasks" USING btree ("organization_id","notice_at") WHERE "tasks"."notice_at" IS NOT NULL AND "tasks"."status" = 'open' AND "tasks"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_shape" CHECK ("notifications"."type" NOT IN ('task_assigned', 'task_due') OR ("notifications"."task_id" IS NOT NULL AND "notifications"."conversation_id" IS NULL AND "notifications"."message_id" IS NULL));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK ("notifications"."type" IN ('mention', 'task_assigned', 'task_due'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurrence_consistent" CHECK (("tasks"."recurrence_id" IS NULL) = ("tasks"."occurrence_no" IS NULL));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_remind_valid" CHECK ("tasks"."remind_before_minutes" IS NULL OR "tasks"."remind_before_minutes" IN (15, 60, 1440));--> statement-breakpoint
CREATE POLICY "task_recurrences_tenant_isolation" ON "task_recurrences" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "task_recurrences" FORCE ROW LEVEL SECURITY;
