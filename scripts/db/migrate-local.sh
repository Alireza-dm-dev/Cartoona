#!/usr/bin/env bash
# Apply database/migrations/*.sql, in order, to a LOCAL plain PostgreSQL (V0.1.38).
#
#   DATABASE_URL=postgresql://cartoona:<password>@localhost:5433/cartoona scripts/db/migrate-local.sh
#
# Without a host psql, run psql inside the compose container instead and
# address the database by its compose name (the container's own password is
# used, so the URL needs none):
#
#   PSQL=scripts/db/psql-docker.sh \
#   DATABASE_URL=postgresql://cartoona@postgres:5432/cartoona scripts/db/migrate-local.sh
#
# Options:  --check   validate and print the target, then exit without connecting.
#
# Safety (fails closed): the target must be named explicitly by DATABASE_URL,
# point at a loopback or compose-internal host, carry no query-string overrides,
# and not be shadowed by PGHOST/PGDATABASE/PGSERVICE. Any Supabase host or known
# Cartoona Supabase project ref is refused outright. This script never reads
# .env files, and never prints the password.
#
# Each file runs in its own transaction together with its schema_migrations
# record, so a failing file leaves nothing behind. An applied file whose
# content later changed stops the run: write a new migration instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATIONS_DIR="${CARTOONA_MIGRATIONS_DIR:-$ROOT/database/migrations}"
PSQL_BIN="${PSQL:-psql}"

fail() { echo "migrate-local: REFUSED - $*" >&2; exit 2; }

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

# ── Target: explicit, unambiguous ────────────────────────────────────────────
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set. Name the local database explicitly."

for var in PGHOST PGHOSTADDR PGPORT PGDATABASE PGSERVICE; do
  if [ -n "${!var:-}" ]; then
    fail "$var is set; it could redirect psql away from DATABASE_URL. Unset it."
  fi
done

lower_url="$(printf '%s' "$DATABASE_URL" | tr '[:upper:]' '[:lower:]')"

# Known Cartoona Supabase projects (production, migration-test, disposable),
# plus whatever project the Supabase CLI in this checkout is linked to.
FORBIDDEN_REFS="oucyhmrnzahlhqjfqcge guhhlshjvmiwwmixiulk bkctpxclggiqfllbjbre"
if [ -f "$ROOT/supabase/.temp/project-ref" ]; then
  FORBIDDEN_REFS="$FORBIDDEN_REFS $(tr -d '[:space:]' < "$ROOT/supabase/.temp/project-ref")"
fi
for ref in $FORBIDDEN_REFS; do
  case "$lower_url" in
    *"$ref"*) fail "DATABASE_URL names a Cartoona Supabase project ($ref). This runner is for local PostgreSQL only." ;;
  esac
done
case "$lower_url" in
  *supabase.co*|*supabase.com*|*supabase.net*|*pooler.*) fail "DATABASE_URL points at a hosted Supabase endpoint. This runner is for local PostgreSQL only." ;;
esac

# postgres[ql]://user[:password]@host[:port]/database - nothing else.
re='^postgres(ql)?://([^:@/?#]+)(:[^@]*)?@(\[::1\]|[^:/?#@,\[]+)(:([0-9]+))?/([^/?#]+)$'
if [[ ! "$DATABASE_URL" =~ $re ]]; then
  case "$DATABASE_URL" in
    *\?*) fail "DATABASE_URL has query parameters; they can override the host or database. Remove them." ;;
    *,*)  fail "DATABASE_URL lists several hosts. Name exactly one." ;;
  esac
  fail "DATABASE_URL must look like postgresql://user[:password]@host[:port]/database."
fi
DB_USER="${BASH_REMATCH[2]}"
DB_PASSWORD="${BASH_REMATCH[3]#:}"
DB_HOST="${BASH_REMATCH[4]}"
DB_PORT="${BASH_REMATCH[6]:-5432}"
DB_NAME="${BASH_REMATCH[7]}"

case "$DB_HOST" in
  localhost|127.0.0.1|"[::1]"|postgres) ;;
  *) fail "host '$DB_HOST' is not local. Allowed: localhost, 127.0.0.1, [::1], or the compose service 'postgres'." ;;
esac
case "$DB_NAME" in
  postgres|template0|template1) fail "'$DB_NAME' is a maintenance database. Name the application or test database." ;;
esac

echo "migrate-local: target ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} (password not shown)"
[ "$CHECK_ONLY" = 1 ] && { echo "migrate-local: --check only, nothing applied"; exit 0; }

# ── Apply ────────────────────────────────────────────────────────────────────
command -v "$PSQL_BIN" >/dev/null 2>&1 || [ -x "$PSQL_BIN" ] \
  || fail "psql not found ($PSQL_BIN). Install it, or set PSQL=scripts/db/psql-docker.sh."

# The password travels in PGPASSWORD, never on a command line.
if [ -n "$DB_PASSWORD" ]; then export PGPASSWORD="$DB_PASSWORD"; fi
CONN="host=${DB_HOST//[\[\]]/} port=$DB_PORT dbname=$DB_NAME user=$DB_USER"

run_psql() { "$PSQL_BIN" -X -q -At -v ON_ERROR_STOP=1 -d "$CONN" "$@"; }

run_psql -c "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)" >/dev/null

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

applied=0
skipped=0
# The list is read on fd 3: psql (and docker exec -i) would otherwise consume
# stdin and silently end the loop after the first file.
while IFS= read -r file <&3; do
  version="$(basename "$file" .sql)"
  [[ "$version" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] || fail "migration file name '$version.sql' must be NNNN_lower_snake.sql"
  checksum="$(sha "$file")"
  recorded="$(run_psql -c "SELECT checksum FROM public.schema_migrations WHERE version = '$version'")"
  if [ -n "$recorded" ]; then
    [ "$recorded" = "$checksum" ] || fail "$version was already applied but its file has changed. Never edit an applied migration; add a new one."
    skipped=$((skipped + 1))
    continue
  fi
  echo "migrate-local: applying $version"
  { cat "$file"; printf "\nINSERT INTO public.schema_migrations (version, checksum) VALUES ('%s', '%s');\n" "$version" "$checksum"; } \
    | run_psql --single-transaction -f - >/dev/null
  applied=$((applied + 1))
done 3< <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f | LC_ALL=C sort)

echo "migrate-local: done - $applied applied, $skipped already up to date"
