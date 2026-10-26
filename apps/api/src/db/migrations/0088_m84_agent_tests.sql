CREATE TABLE "agent_test_runs" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid,
	"grounded" boolean NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_test_runs_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_test_runs_counts_valid" CHECK ("agent_test_runs"."hits" >= 0 AND "agent_test_runs"."tokens_in" >= 0 AND "agent_test_runs"."tokens_out" >= 0 AND "agent_test_runs"."credits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_test_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_test_runs" ADD CONSTRAINT "agent_test_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_runs" ADD CONSTRAINT "agent_test_runs_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_test_runs_recent_idx" ON "agent_test_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE POLICY "agent_test_runs_tenant_isolation" ON "agent_test_runs" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "agent_test_runs" FORCE ROW LEVEL SECURITY;
