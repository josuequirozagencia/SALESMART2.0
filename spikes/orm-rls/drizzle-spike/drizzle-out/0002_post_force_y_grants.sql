ALTER TABLE organizations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE deals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE counters FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, contacts, deals, counters TO app_rw;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_org() TO app_rw, app_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_pricing TO app_platform;
