CREATE TABLE "contact_import_rows" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"import_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"data" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"contact_id" uuid,
	CONSTRAINT "contact_import_rows_pk" PRIMARY KEY("organization_id","import_id","row_no"),
	CONSTRAINT "contact_import_rows_status_valid" CHECK ("contact_import_rows"."status" IN ('pending', 'created', 'updated', 'skipped', 'rejected')),
	CONSTRAINT "contact_import_rows_no_valid" CHECK ("contact_import_rows"."row_no" >= 1),
	CONSTRAINT "contact_import_rows_reason_len" CHECK ("contact_import_rows"."reason" IS NULL OR length("contact_import_rows"."reason") <= 300)
);
--> statement-breakpoint
ALTER TABLE "contact_import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_imports" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"total_rows" integer NOT NULL,
	"headers" jsonb NOT NULL,
	"mapping" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"legal_basis_at" timestamp with time zone,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_imports_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "contact_imports_status_valid" CHECK ("contact_imports"."status" IN ('staging', 'ready', 'running', 'done', 'cancelled')),
	CONSTRAINT "contact_imports_rows_valid" CHECK ("contact_imports"."total_rows" BETWEEN 1 AND 5000),
	CONSTRAINT "contact_imports_hash_hex" CHECK ("contact_imports"."file_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contact_imports_name_shape" CHECK (length(btrim("contact_imports"."file_name")) BETWEEN 1 AND 200),
	CONSTRAINT "contact_imports_counts_valid" CHECK ("contact_imports"."created_count" >= 0 AND "contact_imports"."updated_count" >= 0 AND "contact_imports"."skipped_count" >= 0 AND "contact_imports"."rejected_count" >= 0),
	CONSTRAINT "contact_imports_arrays" CHECK (jsonb_typeof("contact_imports"."headers") = 'array' AND jsonb_typeof("contact_imports"."mapping") = 'array' AND jsonb_array_length("contact_imports"."headers") = jsonb_array_length("contact_imports"."mapping"))
);
--> statement-breakpoint
ALTER TABLE "contact_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_import_rows" ADD CONSTRAINT "contact_import_rows_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "public"."contact_imports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_import_rows" ADD CONSTRAINT "contact_import_rows_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_imports" ADD CONSTRAINT "contact_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_import_rows_status_idx" ON "contact_import_rows" USING btree ("organization_id","import_id","status","row_no");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_imports_org_hash_uq" ON "contact_imports" USING btree ("organization_id","file_hash") WHERE "contact_imports"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "contact_imports_org_created_idx" ON "contact_imports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE POLICY "contact_import_rows_tenant_isolation" ON "contact_import_rows" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "contact_imports_tenant_isolation" ON "contact_imports" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "contact_imports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_import_rows" FORCE ROW LEVEL SECURITY;