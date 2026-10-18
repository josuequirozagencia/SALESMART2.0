CREATE TABLE "companies" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"phone" text,
	"email" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "companies_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "companies_name_shape" CHECK (length(btrim("companies"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "companies_website_len" CHECK ("companies"."website" IS NULL OR length("companies"."website") BETWEEN 1 AND 200),
	CONSTRAINT "companies_phone_e164" CHECK ("companies"."phone" IS NULL OR "companies"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "companies_email_len" CHECK ("companies"."email" IS NULL OR length("companies"."email") BETWEEN 3 AND 254)
);
--> statement-breakpoint
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_companies" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_companies_pk" PRIMARY KEY("organization_id","contact_id","company_id")
);
--> statement-breakpoint
ALTER TABLE "contact_companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notes" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"body" text NOT NULL,
	"author_id" uuid NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notes_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "notes_target_one" CHECK (("notes"."contact_id" IS NULL) <> ("notes"."company_id" IS NULL)),
	CONSTRAINT "notes_body_len" CHECK (length(btrim("notes"."body")) BETWEEN 1 AND 5000)
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tasks" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"assignee_id" uuid NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tasks_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "tasks_title_len" CHECK (length(btrim("tasks"."title")) BETWEEN 1 AND 200),
	CONSTRAINT "tasks_description_len" CHECK ("tasks"."description" IS NULL OR length("tasks"."description") <= 2000),
	CONSTRAINT "tasks_status_valid" CHECK ("tasks"."status" IN ('open', 'done')),
	CONSTRAINT "tasks_completion_consistent" CHECK (("tasks"."status" = 'done') = ("tasks"."completed_at" IS NOT NULL)),
	CONSTRAINT "tasks_one_target" CHECK ("tasks"."contact_id" IS NULL OR "tasks"."company_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_org_name_uq" ON "companies" USING btree ("organization_id",lower("name")) WHERE "companies"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contact_companies_company_idx" ON "contact_companies" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "notes_contact_idx" ON "notes" USING btree ("organization_id","contact_id","created_at","id") WHERE "notes"."deleted_at" IS NULL AND "notes"."contact_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_company_idx" ON "notes" USING btree ("organization_id","company_id","created_at","id") WHERE "notes"."deleted_at" IS NULL AND "notes"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("organization_id","assignee_id","status","due_at") WHERE "tasks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_contact_idx" ON "tasks" USING btree ("organization_id","contact_id") WHERE "tasks"."deleted_at" IS NULL AND "tasks"."contact_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_company_idx" ON "tasks" USING btree ("organization_id","company_id") WHERE "tasks"."deleted_at" IS NULL AND "tasks"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "companies_tenant_isolation" ON "companies" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "contact_companies_tenant_isolation" ON "contact_companies" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "notes_tenant_isolation" ON "notes" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "tasks_tenant_isolation" ON "tasks" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_companies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
