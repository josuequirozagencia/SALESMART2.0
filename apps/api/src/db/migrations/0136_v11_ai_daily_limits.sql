CREATE TABLE "ai_limits" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tests_per_day" integer DEFAULT 100 NOT NULL,
	"suggestions_per_day" integer DEFAULT 50 NOT NULL,
	"follow_ups_per_day" integer DEFAULT 200 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "ai_limits_singleton" CHECK ("ai_limits"."id" = 1),
	CONSTRAINT "ai_limits_tests_valid" CHECK ("ai_limits"."tests_per_day" >= 1 AND "ai_limits"."tests_per_day" <= 10000),
	CONSTRAINT "ai_limits_suggestions_valid" CHECK ("ai_limits"."suggestions_per_day" >= 1 AND "ai_limits"."suggestions_per_day" <= 10000),
	CONSTRAINT "ai_limits_follow_ups_valid" CHECK ("ai_limits"."follow_ups_per_day" >= 1 AND "ai_limits"."follow_ups_per_day" <= 10000)
);
--> statement-breakpoint
-- Topes diarios de la IA por empresa (mensajes de prueba, sugerencias de respuesta y seguimientos del agente). Tabla de PLATAFORMA: solo app_platform; la API de cliente y de agencia no la ve. Una sola fila: se actualiza, nunca se borra.
REVOKE ALL ON TABLE "ai_limits" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "ai_limits" TO "app_platform";--> statement-breakpoint
INSERT INTO "ai_limits" ("id") VALUES (1);
