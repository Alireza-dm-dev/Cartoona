#!/usr/bin/env bash
# Production-shaped smoke test of the built images (V0.1.56).
#
#   scripts/ci/smoke-stack.sh
#
# Expects the images under the overlay's local tags (cartoona-frontend:deployed,
# cartoona-backend:deployed). Mirrors the server layout in a temporary
# directory — compose.yml + compose.production.yml + a THROWAWAY .env.docker —
# then: fresh PostgreSQL 17, all migrations (twice: the second run must apply
# nothing), the restricted app login, backend, frontend, and the same probes the
# deploy script runs (/health, /ready, /api/health, /api/creation-pricing,
# write freeze ON, frontend published on loopback only).
#
# Isolation: its own compose project (cartoona-smoke), its own volume
# (cartoona_smoke_postgres_data) and postgres on 127.0.0.1:55433, so it never
# meets a developer's local `cartoona` stack or its cartoona_postgres_data.
# SMOKE_CLEANUP=1 removes the smoke project and that one volume afterwards.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cartoona-smoke.XXXXXX")"
project=cartoona-smoke
smoke_volume=cartoona_smoke_postgres_data

cp "$root/compose.yml" "$work/compose.yml"
cp "$root/deploy/compose.production.yml" "$work/compose.production.yml"
"$root/scripts/ci/throwaway-env.sh" "$work/.env.docker"
cat > "$work/compose.smoke.yml" <<EOF
services:
  postgres:
    ports: !override
      - "127.0.0.1:55433:5432"
volumes:
  postgres_data:
    name: $smoke_volume
EOF

dc() {
  docker compose -p "$project" --project-directory "$work" --env-file "$work/.env.docker" \
    -f "$work/compose.yml" -f "$work/compose.production.yml" -f "$work/compose.smoke.yml" "$@"
}

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "smoke-stack: FAILED - container state and recent logs follow" >&2
    dc ps -a >&2 || true
    dc logs --no-color --tail 80 backend frontend >&2 || true
  fi
  if [ "${SMOKE_CLEANUP:-0}" = 1 ]; then
    dc down --remove-orphans >/dev/null 2>&1 || true
    docker volume rm "$smoke_volume" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT

if docker volume inspect "$smoke_volume" >/dev/null 2>&1; then
  echo "smoke-stack: volume $smoke_volume already exists; refusing to reuse it" >&2
  exit 2
fi

echo "smoke-stack: starting postgres"
dc up -d --wait --wait-timeout 120 postgres
pg="$(dc ps -q postgres)"
export CARTOONA_PG_CONTAINER="$pg"
owner_url=postgresql://cartoona@postgres:5432/cartoona

echo "smoke-stack: applying migrations"
PSQL="$root/scripts/db/psql-docker.sh" DATABASE_URL="$owner_url" "$root/scripts/db/migrate-local.sh"
second="$(PSQL="$root/scripts/db/psql-docker.sh" DATABASE_URL="$owner_url" "$root/scripts/db/migrate-local.sh")"
echo "$second"
grep -q "done - 0 applied" <<< "$second" || { echo "smoke-stack: second migration run was not a no-op" >&2; exit 1; }

echo "smoke-stack: creating the restricted app login"
app_pw="$(grep -E '^CARTOONA_APP_DB_PASSWORD=' "$work/.env.docker" | cut -d= -f2-)"
PSQL="$root/scripts/db/psql-docker.sh" DATABASE_URL="$owner_url" CARTOONA_APP_DB_PASSWORD="$app_pw" \
  "$root/scripts/db/app-login-role.sh" >/dev/null
app_pw=""

echo "smoke-stack: starting backend, then frontend (no build, no pull)"
dc up -d --no-deps --no-build --pull never --wait --wait-timeout 180 backend
dc up -d --no-deps --no-build --pull never --wait --wait-timeout 180 frontend

failed=0
probe() { # name url expected-substring
  local body
  if body="$(curl -fsS --max-time 10 "$2" 2>/dev/null)" && grep -q "$3" <<< "$body"; then
    echo "smoke-stack: $1 pass"
  else
    echo "::error::smoke-stack: $1 FAILED"; failed=1
  fi
}
for _ in $(seq 1 30); do curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:4000/ready 2>/dev/null && break; sleep 2; done
probe backend_health http://127.0.0.1:4000/health '"ok"'
probe backend_ready http://127.0.0.1:4000/ready '"ready"'
probe frontend_health http://127.0.0.1:3000/api/health '"ok"'
probe creation_pricing http://127.0.0.1:3000/api/creation-pricing '"prices"'

freeze="$(dc exec -T frontend printenv CARTOONA_WRITE_FREEZE | tr -d '\r' || true)"
if [ "$freeze" = 1 ]; then echo "smoke-stack: write_freeze on"; else echo "::error::smoke-stack: write freeze not ON in the frontend"; failed=1; fi

for svc in frontend backend; do
  bindings="$(docker port "$(dc ps -q "$svc")" | sed 's/^.* -> //' | sort -u | tr '\n' ' ')"
  if grep -qvE '^127\.0\.0\.1:' <<< "$(tr ' ' '\n' <<< "$bindings" | sed '/^$/d')"; then
    echo "::error::smoke-stack: $svc is published beyond loopback: $bindings"; failed=1
  else
    echo "smoke-stack: ${svc}_published_on $bindings"
  fi
done

# The frontend container must hold no database credential (compose blanks them).
for v in DATABASE_URL BACKEND_DATABASE_URL POSTGRES_PASSWORD CARTOONA_APP_DB_PASSWORD; do
  if [ -n "$(dc exec -T frontend printenv "$v" 2>/dev/null | tr -d '\r' || true)" ]; then
    echo "::error::smoke-stack: frontend container holds $v"; failed=1
  fi
done

[ "$failed" = 0 ] && echo "smoke-stack: OK"
exit "$failed"
