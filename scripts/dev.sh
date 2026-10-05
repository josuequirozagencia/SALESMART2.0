#!/usr/bin/env bash
# API en modo desarrollo (recarga al guardar). La API NO recibe las variables TOOLS_* (ni owner ni admin).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "Falta .env: ejecuta pnpm dev:setup" >&2; exit 2; }
pnpm --filter @sales-smart/shared build >/dev/null
exec env -i PATH="$PATH" HOME="$HOME" bash -c 'set -a; source .env; set +a; unset POSTGRES_ADMIN_PASSWORD "${!TOOLS_@}"; cd apps/api && exec pnpm exec tsx watch src/main.ts'
