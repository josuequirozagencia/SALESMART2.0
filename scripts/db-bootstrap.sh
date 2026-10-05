#!/usr/bin/env bash
# Bootstrap de roles + base de datos (ejecutar con un superusuario). Sin contraseñas por defecto.
# Requiere: DB_ADMIN_URL (superusuario, base "postgres"), DB_NAME, APP_OWNER_PASSWORD, APP_RW_PASSWORD, APP_PLATFORM_PASSWORD
set -euo pipefail
: "${DB_ADMIN_URL:?define DB_ADMIN_URL (superusuario)}"
: "${DB_NAME:?define DB_NAME}"
: "${APP_OWNER_PASSWORD:?define APP_OWNER_PASSWORD}"
: "${APP_RW_PASSWORD:?define APP_RW_PASSWORD}"
: "${APP_PLATFORM_PASSWORD:?define APP_PLATFORM_PASSWORD}"
: "${APP_IDENTITY_PASSWORD:?define APP_IDENTITY_PASSWORD}"
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "DB_NAME inválido" >&2; exit 2; }
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/postgres" && pwd)"
psql "$DB_ADMIN_URL" -q -v ON_ERROR_STOP=1 \
  -v owner_pw="$APP_OWNER_PASSWORD" -v rw_pw="$APP_RW_PASSWORD" -v platform_pw="$APP_PLATFORM_PASSWORD" -v identity_pw="$APP_IDENTITY_PASSWORD" \
  -f "$dir/bootstrap-roles.sql" >/dev/null
psql "$DB_ADMIN_URL" -q -v ON_ERROR_STOP=1 -v dbname="$DB_NAME" -f "$dir/bootstrap-database.sql" >/dev/null
echo "bootstrap OK: roles + base ${DB_NAME}"
