#!/usr/bin/env bash
# psql, run inside the compose `postgres` container - for hosts without a psql
# client. Arguments and stdin are passed straight through.
#
# Inside the container, address the database by its compose name
# (host=postgres port=5432). A PGPASSWORD exported on the host is forwarded;
# otherwise the container's own password is used.
#
# CARTOONA_PG_CONTAINER may name the container directly (saves a lookup per
# call); by default it is resolved from `docker compose`.
set -euo pipefail

container="${CARTOONA_PG_CONTAINER:-}"
if [ -z "$container" ]; then
  container="$(cd "$(dirname "$0")/../.." && docker compose ps -q postgres)"
fi
[ -n "$container" ] || { echo "psql-docker: the compose 'postgres' service is not running (docker compose up -d postgres)" >&2; exit 2; }

if [ -n "${PGPASSWORD:-}" ]; then
  exec docker exec -i -e PGPASSWORD "$container" psql "$@"
fi
exec docker exec -i "$container" psql "$@"
