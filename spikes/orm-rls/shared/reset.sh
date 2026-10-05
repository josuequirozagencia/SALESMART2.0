#!/bin/sh
# uso: reset.sh <db>
set -e
export PGPASSWORD=owner
for f in schema seed; do psql -q -v ON_ERROR_STOP=1 -h localhost -U app_owner -d "$1" -f "$(dirname "$0")/$f.sql" >/dev/null; done
psql -q -h localhost -U app_owner -d "$1" -c "INSERT INTO ai_pricing VALUES (1,0.01)" 2>&1 | head -1 || true
