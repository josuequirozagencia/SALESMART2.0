CREATE TABLE "webhook_ignored" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "webhook_ignored_pk" PRIMARY KEY("organization_id","channel_account_id","hour","reason"),
	CONSTRAINT "webhook_ignored_reason_valid" CHECK ("webhook_ignored"."reason" IN ('group', 'status', 'from_me', 'no_phone', 'malformed', 'receipt', 'unsupported')),
	CONSTRAINT "webhook_ignored_n_valid" CHECK ("webhook_ignored"."n" >= 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_ignored" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "channel_account_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "alert_reason" text;--> statement-breakpoint
ALTER TABLE "webhook_ignored" ADD CONSTRAINT "webhook_ignored_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_fk" FOREIGN KEY ("organization_id","channel_account_id") REFERENCES "public"."channel_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_connection_uq" ON "notifications" USING btree ("organization_id","user_id","channel_account_id","alert_reason") WHERE "notifications"."type" = 'connection_health' AND "notifications"."read_at" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_connection_shape" CHECK (("notifications"."type" = 'connection_health' AND "notifications"."channel_account_id" IS NOT NULL AND "notifications"."alert_reason" IN ('lag', 'silent', 'failed', 'backlog') AND "notifications"."conversation_id" IS NULL AND "notifications"."message_id" IS NULL AND "notifications"."task_id" IS NULL AND "notifications"."sale_id" IS NULL AND "notifications"."actor_id" IS NULL) OR ("notifications"."type" <> 'connection_health' AND "notifications"."channel_account_id" IS NULL AND "notifications"."alert_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK ("notifications"."type" IN ('mention', 'task_assigned', 'task_due', 'calendar_reconnect', 'sale_created', 'connection_health'));--> statement-breakpoint
CREATE POLICY "webhook_ignored_tenant_isolation" ON "webhook_ignored" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24) y permisos de la tabla nueva (de NEGOCIO, solo app_rw, sin DELETE).
ALTER TABLE "webhook_ignored" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "webhook_ignored" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "webhook_ignored" TO "app_rw";
