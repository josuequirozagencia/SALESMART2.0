-- F3c (ADR-59 #10–12): borrado definitivo de una empresa eliminada. DOS funciones SECURITY DEFINER (aprobadas por ADR-59 y dadas de alta en el catálogo del auditor). Las ejecuta app_identity (que no tiene DELETE
-- en nada), corren con los privilegios de su dueño app_owner y SOLO saben borrar lo de UNA empresa que ya está eliminada y cuyo plazo de 7 días venció. search_path fijo y objetos con esquema explícito.
--
-- Defensas, dentro de la función y por tanto imposibles de saltar desde la aplicación:
--   (1) solo actúan sobre una empresa `client` o `agency` en estado `deleted` con una eliminación programada o en curso cuyo `purge_after` ya pasó; con una empresa viva, la plataforma, una inexistente o antes del plazo, lanzan error;
--   (2) el único parámetro es el uuid: no hay nombres de tabla ni condiciones libres (los nombres de tabla salen del catálogo de PostgreSQL y se escapan con %I);
--   (3) `purge_company_step` fija `app.org_id` de esa empresa: las políticas RLS (forzadas incluso al dueño) acotan cada DELETE a ESA empresa, así que es imposible que borre filas de otra;
--   (4) dejan constancia en `organization_deletions` (estado `purging`).
-- Las tablas de negocio se descubren del catálogo (toda tabla con RLS forzada y `organization_id`): una tabla nueva queda cubierta sin acordarse de añadirla aquí.

CREATE FUNCTION "public"."purge_company_step"(p_org uuid)
RETURNS TABLE (table_name text, deleted bigint, remaining bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text;
  v_status text;
  v_del uuid;
  v_state text;
  v_due timestamptz;
  t record;
  n bigint;
  r bigint;
BEGIN
  SELECT o.kind, o.status INTO v_kind, v_status FROM public.organizations o WHERE o.id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purge_company_step: la empresa no existe' USING ERRCODE = '42501';
  END IF;
  SELECT d.id, d.state, d.purge_after INTO v_del, v_state, v_due
    FROM public.organization_deletions d
   WHERE d.organization_id = p_org AND d.state IN ('scheduled', 'purging', 'purge_failed')
   ORDER BY d.requested_at DESC LIMIT 1;
  -- 'purged' (la lápida) solo se admite mientras la eliminación siga `purging`: es el reintento tras un corte justo antes de cerrarla
  IF v_kind NOT IN ('client', 'agency') OR NOT (v_status = 'deleted' OR (v_status = 'purged' AND v_state = 'purging')) OR v_del IS NULL OR v_due > now() THEN
    RAISE EXCEPTION 'purge_company_step: la empresa no está eliminada o su plazo no venció' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.org_id', p_org::text, true);
  UPDATE public.organization_deletions
     SET state = 'purging', purge_started_at = COALESCE(purge_started_at, now())
   WHERE id = v_del AND state <> 'purging';

  -- El único ciclo entre tablas de negocio: pipelines ↔ pipeline_stages (la etapa de cita). Se rompe antes de borrar.
  UPDATE public.pipelines SET appointment_stage_id = NULL WHERE appointment_stage_id IS NOT NULL;

  FOR t IN
    SELECT c.relname::text AS name
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
     WHERE c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
     ORDER BY c.relname
  LOOP
    n := 0;
    BEGIN
      -- Hasta 5000 filas por tabla y llamada: la tarea repite hasta que no quede nada, así que un corte a mitad solo retrasa
      EXECUTE format('WITH d AS (DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I LIMIT 5000) RETURNING 1) SELECT count(*) FROM d', t.name, t.name) INTO n;
    EXCEPTION WHEN foreign_key_violation THEN
      n := 0; -- otra tabla aún la referencia: se vuelve a intentar en el siguiente pase, cuando ya no tenga hijos
    END;
    EXECUTE format('SELECT count(*) FROM public.%I', t.name) INTO r;
    table_name := t.name;
    deleted := n;
    remaining := r;
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint

CREATE FUNCTION "public"."purge_company_identity"(p_org uuid)
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text;
  v_status text;
  v_del uuid;
  v_state text;
  v_due timestamptz;
  v_users uuid[];
  t record;
  u uuid;
  r bigint;
  n bigint;
  v_anon bigint := 0;
BEGIN
  SELECT o.kind, o.status INTO v_kind, v_status FROM public.organizations o WHERE o.id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purge_company_identity: la empresa no existe' USING ERRCODE = '42501';
  END IF;
  SELECT d.id, d.state, d.purge_after INTO v_del, v_state, v_due
    FROM public.organization_deletions d
   WHERE d.organization_id = p_org AND d.state IN ('scheduled', 'purging', 'purge_failed')
   ORDER BY d.requested_at DESC LIMIT 1;
  -- Aquí además el borrado de negocio ya debe estar en marcha (`purging`): esta parte solo se llama al final
  IF v_kind NOT IN ('client', 'agency') OR v_status NOT IN ('deleted', 'purged') OR v_del IS NULL OR v_state <> 'purging' OR v_due > now() THEN
    RAISE EXCEPTION 'purge_company_identity: la empresa no está en borrado definitivo o su plazo no venció' USING ERRCODE = '42501';
  END IF;

  -- No se toca la identidad (membresías, rutas, personas) mientras quede un solo dato de negocio: se dejarían datos huérfanos
  PERFORM set_config('app.org_id', p_org::text, true);
  FOR t IN
    SELECT c.relname::text AS name
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
     WHERE c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t.name) INTO r;
    IF r > 0 THEN
      RAISE EXCEPTION 'purge_company_identity: aún quedan datos de negocio en %', t.name USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Las personas que SOLO pertenecían a esta empresa (las que están también en otra empresa o agencia —y los Súper Admin, que son de la plataforma— se conservan)
  SELECT COALESCE(array_agg(DISTINCT m.user_id), ARRAY[]::uuid[]) INTO v_users
    FROM public.organization_members m
   WHERE m.organization_id = p_org
     AND NOT EXISTS (SELECT 1 FROM public.organization_members o WHERE o.user_id = m.user_id AND o.organization_id <> p_org);

  WITH d AS (DELETE FROM public.member_permissions WHERE membership_id IN (SELECT id FROM public.organization_members WHERE organization_id = p_org) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'member_permissions'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.access_sessions WHERE organization_id = p_org OR actor_user_id = ANY(v_users) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'access_sessions'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.sessions WHERE active_org_id = p_org OR home_org_id = p_org OR user_id = ANY(v_users) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'sessions'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.view_as_log WHERE organization_id = p_org OR actor_user_id = ANY(v_users) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'view_as_log'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.invitations WHERE organization_id = p_org OR invited_by = ANY(v_users) OR accepted_user_id = ANY(v_users) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'invitations'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.member_history WHERE organization_id = p_org OR user_id = ANY(v_users) OR changed_by = ANY(v_users) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'member_history'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.organization_members WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'organization_members'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.trials WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'trials'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.channel_routes WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'channel_routes'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.qr_routes WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'qr_routes'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.form_routes WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'form_routes'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.ghl_routes WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'ghl_routes'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.attribution_endpoints WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'attribution_endpoints'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.company_exports WHERE organization_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'company_exports'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.ai_org_pricing WHERE target_org_id = p_org RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'ai_org_pricing'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.email_verifications WHERE user_id = ANY(v_users) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'email_verifications'; deleted := n; RETURN NEXT;
  WITH d AS (DELETE FROM public.password_resets WHERE user_id = ANY(v_users) RETURNING 1) SELECT count(*) INTO n FROM d;
  table_name := 'password_resets'; deleted := n; RETURN NEXT;

  -- La fila de la empresa queda como LÁPIDA mínima: la auditoría de plataforma, las claves foráneas y los identificadores no quedan colgando y no se reutilizan
  UPDATE public.organizations
     SET name = '[empresa eliminada]', status = 'purged', owner_user_id = NULL, plan_id = NULL, updated_at = now()
   WHERE id = p_org;
  table_name := 'organizations_tombstone'; deleted := 1; RETURN NEXT;

  -- Las personas exclusivas se borran; si alguna sigue referenciada por algo que se conserva, se ANONIMIZA (no se puede volver a entrar con esa cuenta ni se reutiliza su correo)
  n := 0;
  FOREACH u IN ARRAY v_users LOOP
    BEGIN
      DELETE FROM public.users WHERE id = u;
      n := n + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      UPDATE public.users
         SET email = 'purged-' || id::text || '@purged.invalid', full_name = NULL, phone = NULL, password_hash = '$argon2id$purged', status = 'disabled',
             session_version = session_version + 1, deleted_at = now(), updated_at = now()
       WHERE id = u;
      v_anon := v_anon + 1;
    END;
  END LOOP;
  table_name := 'users'; deleted := n; RETURN NEXT;
  table_name := 'users_anonymized'; deleted := v_anon; RETURN NEXT;

  UPDATE public.organization_deletions SET export_token_hash = NULL WHERE id = v_del;
END
$$;--> statement-breakpoint

ALTER FUNCTION "public"."purge_company_step"(uuid) OWNER TO "app_owner";--> statement-breakpoint
ALTER FUNCTION "public"."purge_company_identity"(uuid) OWNER TO "app_owner";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_company_step"(uuid) FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_company_identity"(uuid) FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."purge_company_step"(uuid) TO "app_identity";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."purge_company_identity"(uuid) TO "app_identity";
