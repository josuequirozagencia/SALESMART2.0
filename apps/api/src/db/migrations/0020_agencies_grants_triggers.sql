-- M2.4 (ADR-40): historial de administración de clientes. Tabla de identidad y APPEND-ONLY: app_identity solo SELECT/INSERT.
REVOKE ALL ON TABLE "organization_ownership_history" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "organization_ownership_history" TO "app_identity";--> statement-breakpoint
-- Defensa en profundidad (riesgo aceptado 2 de ADR-25): parent_agency_id solo puede apuntar a una organización de tipo agency.
CREATE FUNCTION "organizations_check_parent_agency"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_agency_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organizations a WHERE a.id = NEW.parent_agency_id AND a.kind = 'agency') THEN
    RAISE EXCEPTION 'organizations.parent_agency_id debe apuntar a una organización de tipo agency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "organizations_parent_is_agency" BEFORE INSERT OR UPDATE OF "parent_agency_id" ON "organizations" FOR EACH ROW EXECUTE FUNCTION "organizations_check_parent_agency"();
