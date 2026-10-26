-- M8.1 (ADR-53): tablas de NEGOCIO de créditos, solo app_rw. El libro es de solo inserción (sin UPDATE ni DELETE); el monedero y las reservas se actualizan pero no se borran.
REVOKE ALL ON TABLE "ai_wallets", "ai_ledger", "ai_holds" FROM PUBLIC, "app_platform", "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ai_wallets" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_ledger" TO "app_rw";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ai_holds" TO "app_rw";--> statement-breakpoint
-- Tablas de PLATAFORMA (precio y margen): solo app_platform; la API de cliente y de agencia no las ve.
REVOKE ALL ON TABLE "ai_pricing", "ai_org_pricing" FROM PUBLIC, "app_rw", "app_identity";--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "ai_pricing" TO "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ai_org_pricing" TO "app_platform";
