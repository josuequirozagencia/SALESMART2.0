#!/usr/bin/env bash
# Prepara el entorno de desarrollo: .env con contraseñas ALEATORIAS (gitignored), PostgreSQL, roles, migraciones.
# Idempotente: si .env existe no lo sobrescribe.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rnd() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28; }
if [[ ! -f .env ]]; then
  THR=$(rnd)$(rnd); ADMIN=$(rnd); OWNER=$(rnd); RW=$(rnd); PLAT=$(rnd); IDEN=$(rnd)
  umask 077
  cat > .env <<ENV
NODE_ENV=development
LOG_LEVEL=debug
HTTP_PORT=3000
POSTGRES_ADMIN_PASSWORD=$ADMIN
DATABASE_URL_APP=postgresql://app_rw:$RW@127.0.0.1:5432/sales_smart
DATABASE_URL_PLATFORM=postgresql://app_platform:$PLAT@127.0.0.1:5432/sales_smart
DATABASE_URL_IDENTITY=postgresql://app_identity:$IDEN@127.0.0.1:5432/sales_smart
AUTH_THROTTLE_KEY=$THR
# Solo desarrollo: el código de verificación se imprime en el log y el CAPTCHA acepta el token fake-pass
MAIL_PROVIDER=console
# URL del frontend para los enlaces de los correos (explícita, no se deriva del Host). Solo desarrollo: ajusta el puerto de tu frontend
FRONTEND_BASE_URL=http://localhost:5173
CAPTCHA_PROVIDER=fake
# --- Solo herramientas (NO cargar en la API de producción) ---
TOOLS_DB_ADMIN_URL=postgresql://postgres:$ADMIN@127.0.0.1:5432/postgres
TOOLS_DATABASE_URL_OWNER=postgresql://app_owner:$OWNER@127.0.0.1:5432/sales_smart
TOOLS_OWNER_PW=$OWNER
TOOLS_RW_PW=$RW
TOOLS_PLATFORM_PW=$PLAT
TOOLS_IDENTITY_PW=$IDEN
ENV
  echo ".env creado (contraseñas aleatorias, solo local)"
fi
set -a; source .env; set +a
docker compose up -d --wait postgres
DB_ADMIN_URL="$TOOLS_DB_ADMIN_URL" DB_NAME=sales_smart APP_OWNER_PASSWORD="$TOOLS_OWNER_PW" APP_RW_PASSWORD="$TOOLS_RW_PW" \
  APP_PLATFORM_PASSWORD="$TOOLS_PLATFORM_PW" APP_IDENTITY_PASSWORD="$TOOLS_IDENTITY_PW" bash scripts/db-bootstrap.sh
DATABASE_URL_OWNER="$TOOLS_DATABASE_URL_OWNER" pnpm db:migrate
DATABASE_URL_OWNER="$TOOLS_DATABASE_URL_OWNER" pnpm db:audit
echo "Listo. Siguiente: pnpm dev"
