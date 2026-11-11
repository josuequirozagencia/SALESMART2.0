CREATE TABLE "ai_suggestion_runs" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid,
	"grounded" boolean NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_suggestion_runs_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_suggestion_runs_counts_valid" CHECK ("ai_suggestion_runs"."hits" >= 0 AND "ai_suggestion_runs"."tokens_in" >= 0 AND "ai_suggestion_runs"."tokens_out" >= 0 AND "ai_suggestion_runs"."credits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_suggestion_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_holds" DROP CONSTRAINT "ai_holds_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_ledger" DROP CONSTRAINT "ai_ledger_kind_valid";--> statement-breakpoint
ALTER TABLE "ai_ledger" DROP CONSTRAINT "ai_ledger_sign_by_kind";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "suggestions_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_suggestion_runs" ADD CONSTRAINT "ai_suggestion_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion_runs" ADD CONSTRAINT "ai_suggestion_runs_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion_runs" ADD CONSTRAINT "ai_suggestion_runs_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_suggestion_runs_recent_idx" ON "ai_suggestion_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_holds" ADD CONSTRAINT "ai_holds_kind_valid" CHECK ("ai_holds"."kind" IN ('use', 'test', 'suggest'));--> statement-breakpoint
ALTER TABLE "ai_ledger" ADD CONSTRAINT "ai_ledger_kind_valid" CHECK ("ai_ledger"."kind" IN ('welcome', 'grant', 'use', 'test', 'suggest'));--> statement-breakpoint
ALTER TABLE "ai_ledger" ADD CONSTRAINT "ai_ledger_sign_by_kind" CHECK (("ai_ledger"."kind" IN ('welcome', 'grant') AND "ai_ledger"."credits" > 0) OR ("ai_ledger"."kind" IN ('use', 'test', 'suggest') AND "ai_ledger"."credits" < 0));--> statement-breakpoint
CREATE POLICY "ai_suggestion_runs_tenant_isolation" ON "ai_suggestion_runs" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "ai_suggestion_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- v11 S4 (ADR-61): ai_suggestion_runs es tabla de NEGOCIO, solo app_rw, de solo inserción (metadatos de cada sugerencia de respuesta: sin el texto; sin UPDATE, DELETE ni TRUNCATE).
REVOKE ALL ON TABLE "ai_suggestion_runs" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_suggestion_runs" TO "app_rw";
