-- V25 (ADR-76): archivos de la biblioteca en las respuestas rápidas y la llave de cada envío.
CREATE TABLE "quick_reply_assets" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"quick_reply_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "quick_reply_assets_pk" PRIMARY KEY("organization_id","quick_reply_id","position"),
	CONSTRAINT "quick_reply_assets_asset_uq" UNIQUE("organization_id","quick_reply_id","asset_id"),
	CONSTRAINT "quick_reply_assets_position_valid" CHECK ("quick_reply_assets"."position" BETWEEN 0 AND 2)
);
--> statement-breakpoint
ALTER TABLE "quick_reply_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quick_reply_sends" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"idempotency_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"quick_reply_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"message_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_reply_sends_pk" PRIMARY KEY("organization_id","idempotency_key"),
	CONSTRAINT "quick_reply_sends_key_shape" CHECK (length("quick_reply_sends"."idempotency_key") BETWEEN 8 AND 100),
	CONSTRAINT "quick_reply_sends_hash_shape" CHECK ("quick_reply_sends"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "quick_reply_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quick_reply_assets" ADD CONSTRAINT "quick_reply_assets_reply_fk" FOREIGN KEY ("organization_id","quick_reply_id") REFERENCES "public"."quick_replies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_reply_assets" ADD CONSTRAINT "quick_reply_assets_asset_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."media_assets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_reply_sends" ADD CONSTRAINT "quick_reply_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_reply_sends" ADD CONSTRAINT "quick_reply_sends_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_reply_sends" ADD CONSTRAINT "quick_reply_sends_reply_fk" FOREIGN KEY ("organization_id","quick_reply_id") REFERENCES "public"."quick_replies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quick_reply_assets_asset_idx" ON "quick_reply_assets" USING btree ("organization_id","asset_id");--> statement-breakpoint
CREATE POLICY "quick_reply_assets_tenant_isolation" ON "quick_reply_assets" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
CREATE POLICY "quick_reply_sends_tenant_isolation" ON "quick_reply_sends" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de las tablas la elude fuera de las migraciones.
ALTER TABLE "quick_reply_assets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quick_reply_sends" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- `quick_reply_assets` es una tabla de enlace (guardar reemplaza el conjunto): lleva DELETE, como `contact_tags`; sin UPDATE ni TRUNCATE.
REVOKE ALL ON TABLE "quick_reply_assets" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "quick_reply_assets" TO "app_rw";--> statement-breakpoint
-- `quick_reply_sends` es de solo inserción.
REVOKE ALL ON TABLE "quick_reply_sends" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "quick_reply_sends" TO "app_rw";
