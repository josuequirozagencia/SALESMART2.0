-- 0000_foundation — fundación multi-tenant (ADR-24). Ejecutar como app_owner.
-- Los roles (app_owner / app_rw / app_platform) los crea infra/postgres/bootstrap-*.sql, no esta migración.

-- Contexto de organización de la transacción actual. Falla cerrado: sin contexto devuelve NULL
-- (ninguna fila coincide con `organization_id = NULL`; los INSERT/UPDATE fallan en WITH CHECK).
-- STABLE, SECURITY INVOKER (nunca DEFINER). El valor lo fija SOLO Database.withTenant con set_config(..., true).
CREATE OR REPLACE FUNCTION public.app_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_org() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_org() TO app_rw;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_rw, app_platform;
--> statement-breakpoint
-- Ningún privilegio por defecto: cada tabla recibe sus GRANT explícitos en su propia migración.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
