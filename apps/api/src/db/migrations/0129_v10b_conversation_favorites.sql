CREATE TABLE "conversation_favorites" (
	"organization_id" uuid DEFAULT app_org() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_favorites_pk" PRIMARY KEY("organization_id","user_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_favorites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_favorites" ADD CONSTRAINT "conversation_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_favorites" ADD CONSTRAINT "conversation_favorites_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_favorites_conversation_idx" ON "conversation_favorites" USING btree ("organization_id","conversation_id","user_id");--> statement-breakpoint
CREATE POLICY "conversation_favorites_tenant_isolation" ON "conversation_favorites" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint
-- RLS FORZADA (ADR-24): ni el dueño de la tabla la elude fuera de las migraciones.
ALTER TABLE "conversation_favorites" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tabla de NEGOCIO: solo app_rw. Es una tabla de enlace (la estrella de una persona en una conversación): destacar inserta y quitar la estrella borra, así que lleva DELETE (como `contact_tags`); sin UPDATE ni TRUNCATE.
REVOKE ALL ON TABLE "conversation_favorites" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "conversation_favorites" TO "app_rw";
