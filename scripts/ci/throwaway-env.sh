#!/usr/bin/env bash
# Write a THROWAWAY compose env file for CI (V0.1.56): random credentials for a
# database that lives only on the CI runner. Nothing here is a real secret and
# nothing is ever reused outside the job. Values are never printed; on GitHub
# Actions each one is masked as well.
#
#   scripts/ci/throwaway-env.sh <output-file>
set -euo pipefail
out="${1:?usage: throwaway-env.sh <output-file>}"

hex() { openssl rand -hex "$1"; }
pg_pw="$(hex 24)"
app_pw="$(hex 32)"
internal="$(hex 32)"
rate="$(hex 32)"

if [ "${GITHUB_ACTIONS:-}" = true ]; then
  for v in "$pg_pw" "$app_pw" "$internal" "$rate"; do echo "::add-mask::$v"; done
fi

umask 077
cat > "$out" <<EOF
POSTGRES_DB=cartoona
POSTGRES_USER=cartoona
POSTGRES_PASSWORD=$pg_pw
CARTOONA_APP_DB_PASSWORD=$app_pw
BACKEND_DATABASE_URL=postgresql://cartoona_app_login:$app_pw@postgres:5432/cartoona
CARTOONA_INTERNAL_AUTH_SECRET=$internal
RATE_LIMIT_HASH_SECRET=$rate
CARTOONA_APP_ORIGIN=http://localhost:3000
CARTOONA_WRITE_FREEZE=1
EOF
echo "throwaway-env: wrote $(wc -l < "$out" | tr -d ' ') variables to $out (values not shown)"
