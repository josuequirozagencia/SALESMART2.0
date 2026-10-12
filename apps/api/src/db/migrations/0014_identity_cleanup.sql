-- ADR-35: limpieza de las tablas de identidad SIN dar DELETE a app_identity.
-- Función SECURITY DEFINER (aprobada por ADR-35 y dada de alta en el catálogo del auditor): la ejecuta app_identity, corre con los
-- privilegios de su dueño (app_owner) y SOLO sabe borrar filas ya caducadas de cinco tablas. Sin parámetros: la app no puede
-- pedirle que borre más ni otra cosa. Retenciones PROVISIONALES; cambiarlas es una migración. No toca users, organizations ni membresías.
-- search_path fijo (pg_catalog, public) y objetos con esquema explícito: no se puede secuestrar por search_path.
-- FOR UPDATE SKIP LOCKED: varias instancias pueden limpiar a la vez sin esperarse; lotes de 5000 por tabla y llamada.
CREATE FUNCTION "public"."purge_expired_identity_rows"()
RETURNS TABLE (table_name text, purged integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  n integer;
BEGIN
  -- Sesiones: absolutamente vencidas o revocadas hace más de 7 días (las vivas y las recién revocadas se conservan para auditoría)
  WITH d AS (
    DELETE FROM public.sessions WHERE ctid IN (
      SELECT ctid FROM public.sessions
       WHERE absolute_expires_at < now() - interval '7 days' OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
       LIMIT 5000 FOR UPDATE SKIP LOCKED)
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM d;
  table_name := 'sessions'; purged := n; RETURN NEXT;

  -- Intentos de acceso: sin actividad hace más de 7 días y sin bloqueo vigente
  WITH d AS (
    DELETE FROM public.auth_throttle WHERE ctid IN (
      SELECT ctid FROM public.auth_throttle
       WHERE updated_at < now() - interval '7 days' AND (locked_until IS NULL OR locked_until < now())
       LIMIT 5000 FOR UPDATE SKIP LOCKED)
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM d;
  table_name := 'auth_throttle'; purged := n; RETURN NEXT;

  -- Verificaciones de correo: consumidas o vencidas hace más de 7 días (quien siga pendiente se registra de nuevo)
  WITH d AS (
    DELETE FROM public.email_verifications WHERE ctid IN (
      SELECT ctid FROM public.email_verifications
       WHERE expires_at < now() - interval '7 days' OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')
       LIMIT 5000 FOR UPDATE SKIP LOCKED)
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM d;
  table_name := 'email_verifications'; purged := n; RETURN NEXT;

  -- Contadores del registro (ventana fija de 1 hora): ventanas de más de 1 día
  WITH d AS (
    DELETE FROM public.signup_attempts WHERE ctid IN (
      SELECT ctid FROM public.signup_attempts
       WHERE window_started_at < now() - interval '1 day'
       LIMIT 5000 FOR UPDATE SKIP LOCKED)
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM d;
  table_name := 'signup_attempts'; purged := n; RETURN NEXT;

  -- Restablecimientos de contraseña: vencidos o consumidos hace más de 7 días
  WITH d AS (
    DELETE FROM public.password_resets WHERE ctid IN (
      SELECT ctid FROM public.password_resets
       WHERE expires_at < now() - interval '7 days' OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')
       LIMIT 5000 FOR UPDATE SKIP LOCKED)
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM d;
  table_name := 'password_resets'; purged := n; RETURN NEXT;
END
$$;--> statement-breakpoint
ALTER FUNCTION "public"."purge_expired_identity_rows"() OWNER TO "app_owner";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_expired_identity_rows"() FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."purge_expired_identity_rows"() TO "app_identity";
