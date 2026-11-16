CREATE TABLE "agent_follow_up_files" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"follow_up_id" uuid NOT NULL,
	"step_position" smallint,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text,
	"checksum" text NOT NULL,
	"scan_status" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_follow_up_files_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_follow_up_files_kind_valid" CHECK ("agent_follow_up_files"."kind" IN ('image', 'video', 'audio', 'document')),
	CONSTRAINT "agent_follow_up_files_state_valid" CHECK ("agent_follow_up_files"."state" IN ('ready', 'expired')),
	CONSTRAINT "agent_follow_up_files_scan_valid" CHECK ("agent_follow_up_files"."scan_status" IN ('clean', 'skipped')),
	CONSTRAINT "agent_follow_up_files_step_valid" CHECK ("agent_follow_up_files"."step_position" IS NULL OR "agent_follow_up_files"."step_position" BETWEEN 1 AND 5),
	CONSTRAINT "agent_follow_up_files_order_valid" CHECK ("agent_follow_up_files"."sort_order" BETWEEN 0 AND 2),
	CONSTRAINT "agent_follow_up_files_size_valid" CHECK ("agent_follow_up_files"."size_bytes" BETWEEN 1 AND 104857600),
	CONSTRAINT "agent_follow_up_files_name_len" CHECK (length("agent_follow_up_files"."filename") BETWEEN 1 AND 200 AND length("agent_follow_up_files"."mime_type") BETWEEN 3 AND 127),
	CONSTRAINT "agent_follow_up_files_ready_has_key" CHECK ("agent_follow_up_files"."state" <> 'ready' OR "agent_follow_up_files"."storage_key" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_follow_up_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_follow_up_files" ADD CONSTRAINT "agent_follow_up_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follow_up_files" ADD CONSTRAINT "agent_follow_up_files_follow_up_fk" FOREIGN KEY ("organization_id","follow_up_id") REFERENCES "public"."agent_follow_ups"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_follow_up_files_slot_uq" ON "agent_follow_up_files" USING btree ("follow_up_id","step_position","sort_order") WHERE "agent_follow_up_files"."state" = 'ready' AND "agent_follow_up_files"."step_position" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_follow_up_files_follow_up_idx" ON "agent_follow_up_files" USING btree ("organization_id","follow_up_id","state");--> statement-breakpoint
CREATE POLICY "agent_follow_up_files_tenant_isolation" ON "agent_follow_up_files" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "agent_follow_up_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- v15 (ADR-68): agent_follow_up_files es tabla de NEGOCIO, solo app_rw, sin DELETE (un archivo quitado queda `expired` y la tarea borra el objeto del almacenamiento).
REVOKE ALL ON TABLE "agent_follow_up_files" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "agent_follow_up_files" TO "app_rw";
