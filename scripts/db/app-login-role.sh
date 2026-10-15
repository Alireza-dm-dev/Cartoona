#!/usr/bin/env bash
# Create (or re-password) a LOGIN role for the application on a LOCAL plain
# PostgreSQL, as a member of the `cartoona_app` group role (V0.1.39).
#
#   CARTOONA_APP_DB_PASSWORD="$(openssl rand -hex 32)" \
#   DATABASE_URL=postgresql://cartoona:<owner-password>@localhost:5433/cartoona \
#     scripts/db/app-login-role.sh [role]
#
# DATABASE_URL names the OWNER connection used to manage the role, under the
# same rules as migrate-local.sh (checked by it: local hosts only, never
# Supabase). PSQL=scripts/db/psql-docker.sh works here too. The app itself then
# connects as postgresql://<role>:<password>@<host>/<db>.
#
# role defaults to cartoona_app_login and must match cartoona_app_<a-z0-9_>.
# The password must be 24-128 characters of [A-Za-z0-9._~+/=-]. Prefer hex
# (openssl rand -hex 32): it is also safe inside a connection URL, which a
# base64 value with '/' or '+' is not. It is sent to psql on stdin, never on
# a command line, and is never printed - not even inside a psql error.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL_BIN="${PSQL:-psql}"

fail() { echo "app-login-role: REFUSED - $*" >&2; exit 2; }

[ "$#" -le 1 ] || fail "usage: app-login-role.sh [role]"
role="${1:-cartoona_app_login}"
[[ "$role" =~ ^cartoona_app_[a-z0-9_]{1,40}$ ]] || fail "role must match cartoona_app_<lower_snake> (got an invalid name)."

pw="${CARTOONA_APP_DB_PASSWORD:-}"
[ -n "$pw" ] || fail "CARTOONA_APP_DB_PASSWORD is not set."
[[ "$pw" =~ ^[A-Za-z0-9._~+/=-]{24,128}$ ]] \
  || fail "CARTOONA_APP_DB_PASSWORD must be 24-128 characters of [A-Za-z0-9._~+/=-] (e.g. openssl rand -hex 32)."

# Target validation is migrate-local's: one rule set, one place.
"$ROOT/scripts/db/migrate-local.sh" --check >/dev/null

re='^postgres(ql)?://([^:@/?#]+)(:[^@]*)?@(\[::1\]|[^:/?#@,\[]+)(:([0-9]+))?/([^/?#]+)$'
[[ "$DATABASE_URL" =~ $re ]] || fail "DATABASE_URL could not be parsed."
DB_USER="${BASH_REMATCH[2]}"
DB_PASSWORD="${BASH_REMATCH[3]#:}"
DB_HOST="${BASH_REMATCH[4]}"
DB_PORT="${BASH_REMATCH[6]:-5432}"
DB_NAME="${BASH_REMATCH[7]}"

if [ -n "$DB_PASSWORD" ]; then export PGPASSWORD="$DB_PASSWORD"; fi
CONN="host=${DB_HOST//[\[\]]/} port=$DB_PORT dbname=$DB_NAME user=$DB_USER"

# psql variables are interpolated client-side with proper quoting (:'pw',
# :"role"); the charset checks above keep \set unambiguous.
sql="\\set ON_ERROR_STOP on
\\set VERBOSITY terse
\\set role $role
\\set pw $pw
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cartoona_app') THEN
    RAISE EXCEPTION 'cartoona_app does not exist: apply database/migrations (0009) first';
  END IF;
END \$\$;
SELECT format('CREATE ROLE %I', :'role')
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'role') \\gexec
ALTER ROLE :\"role\" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'pw';
GRANT cartoona_app TO :\"role\";
"

set +e
err="$(printf '%s' "$sql" | "$PSQL_BIN" -X -q -At -d "$CONN" -f - 2>&1 >/dev/null)"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  # Literal (not pattern) replacement: the password never reaches the terminal.
  echo "app-login-role: FAILED - ${err//"$pw"/***}" >&2
  exit 1
fi

echo "app-login-role: $role ready on ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}, member of cartoona_app (password not shown)"
