CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
