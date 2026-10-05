-- Bootstrap de ROLES del clúster (ejecutar como superusuario, una vez por clúster; idempotente).
-- Uso: psql -v ON_ERROR_STOP=1 -v owner_pw=... -v rw_pw=... -v platform_pw=... -v identity_pw=... -f bootstrap-roles.sql
-- Las contraseñas se pasan por variable; este repositorio no contiene ninguna.
--
-- Los valores de timeout son PROVISIONALES (ajustables por operación), no reglas de producto.

SELECT format('CREATE ROLE app_owner LOGIN PASSWORD %L', :'owner_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') \gexec
SELECT format('CREATE ROLE app_rw LOGIN PASSWORD %L', :'rw_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') \gexec
SELECT format('CREATE ROLE app_platform LOGIN PASSWORD %L', :'platform_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') \gexec
SELECT format('CREATE ROLE app_identity LOGIN PASSWORD %L', :'identity_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_identity') \gexec

-- Atributos y contraseñas siempre sincronizados (idempotente)
SELECT format('ALTER ROLE app_owner    NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION LOGIN PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE app_rw       NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION LOGIN PASSWORD %L', :'rw_pw') \gexec
SELECT format('ALTER ROLE app_platform NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION LOGIN PASSWORD %L', :'platform_pw') \gexec
SELECT format('ALTER ROLE app_identity NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION LOGIN PASSWORD %L', :'identity_pw') \gexec

-- Los roles de conexión de la app no heredan nada: ninguna pertenencia a otros roles
SELECT format('REVOKE %I FROM %I', g.rolname, m.rolname)
  FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid
 WHERE m.rolname IN ('app_rw', 'app_platform', 'app_identity') AND g.rolname = 'app_owner' \gexec

-- search_path fijo (evita secuestro por esquemas) y timeouts defensivos a nivel de rol (PROVISIONAL)
ALTER ROLE app_rw       SET search_path = public;
ALTER ROLE app_platform SET search_path = public;
ALTER ROLE app_identity SET search_path = public;
ALTER ROLE app_rw       SET statement_timeout = '30s';
ALTER ROLE app_rw       SET lock_timeout = '5s';
ALTER ROLE app_rw       SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_platform SET statement_timeout = '60s';
ALTER ROLE app_platform SET lock_timeout = '5s';
ALTER ROLE app_platform SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_identity SET statement_timeout = '30s';
ALTER ROLE app_identity SET lock_timeout = '5s';
ALTER ROLE app_identity SET idle_in_transaction_session_timeout = '30s';
