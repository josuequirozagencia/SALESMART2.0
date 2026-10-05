-- Esquema común del spike (DESCARTABLE). Se aplica como app_owner a ambas BD.
CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL);
CREATE TABLE deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  amount numeric(14,2) NOT NULL);
CREATE TABLE counters (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL, value int NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, key));
-- tabla de plataforma (sin organization_id): solo app_platform
CREATE TABLE ai_pricing (id int PRIMARY KEY, cost_per_credit numeric(10,4) NOT NULL);

-- RLS: falla cerrado si app.org_id no está definido (current_setting(..., true) -> NULL)
CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['contacts','deals','counters'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app_org()) WITH CHECK (organization_id = app_org())', t);
 END LOOP;
END $$;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (id = app_org()) WITH CHECK (id = app_org());

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, contacts, deals, counters TO app_rw;
GRANT EXECUTE ON FUNCTION app_org() TO app_rw, app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_pricing TO app_platform;
-- app_rw NO tiene permisos sobre ai_pricing
