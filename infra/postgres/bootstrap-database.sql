-- Crea (si no existe) la base de datos de la aplicación, propiedad de app_owner, y fija sus privilegios.
-- Uso: psql -v ON_ERROR_STOP=1 -v dbname=sales_smart -f bootstrap-database.sql  (como superusuario, conectado a "postgres")
SELECT format('CREATE DATABASE %I OWNER app_owner', :'dbname')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'dbname') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO app_rw, app_platform, app_identity, app_owner', :'dbname') \gexec
