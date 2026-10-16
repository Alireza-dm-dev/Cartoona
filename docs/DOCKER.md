# Docker (V0.1.35; PostgreSQL V0.1.37; backend V0.1.40)

Run Cartoona in production-like containers. The stack has three services:

| Service | Image | Port (host) | Role |
|---|---|---|---|
| `frontend` | `cartoona-app:local` (built here) | `3000` | The Next.js web app. Named `app` before V0.1.40. |
| `backend` | `cartoona-backend:local` (built here) | `127.0.0.1:4000` | Fastify API. The frontend's **server** calls it for `GET /api/creation-pricing` only (V0.1.41). See [BACKEND.md](BACKEND.md). |
| `postgres` | `postgres:17-bookworm` | `127.0.0.1:5433` | Local PostgreSQL 17 with the plain schema. Only the backend uses it. |

> **Upgrading from before V0.1.40:** the `app` service is now `frontend`. Run
> `docker compose up -d --remove-orphans` once, or the old `cartoona-app-1`
> container keeps holding port 3000.

**Cartoona's application data still comes from Supabase**, with one exception:
`GET /api/creation-pricing` is served through the `backend` from the local
`postgres` (V0.1.41, [ROUTE_CUTOVER.md](ROUTE_CUTOVER.md)). Nothing in the
frontend connects to `postgres` itself. It is infrastructure for the upcoming
migration (V0.1.38+). See [Local PostgreSQL](#local-postgresql) and
[Backend boundary](#backend-boundary).

Normal day-to-day development is unchanged and does **not** use Docker:

```bash
npm run dev            # http://localhost:3000, hot reload, .env.local
```

Docker gives you the prod-like path instead: a real `next build`, standalone
server, `NODE_ENV=production`, non-root user, no dev server, no hot reload.

---

## 1. Prerequisites

- Docker Engine 24+ with the Compose v2 plugin (`docker compose version`).
  Compose 2.24+ is needed for the `env_file: { required: false }` syntax.
- No local Node install is required to run the container — the image builds and
  runs Node 24 itself.
- Credentials for an existing Supabase project (the container connects out to
  it; nothing is provisioned locally).

## 2. Create the local env file

```bash
cp .env.docker.example .env.docker
# then fill in real values in .env.docker
```

`.env.docker` is gitignored and is never copied into the image — Compose passes
it to the running container. The template contains placeholders only.

## 3. Build and start

```bash
# NEXT_PUBLIC_* (build args) and POSTGRES_* (database service) are read by
# Compose itself, so export the file first.
set -a; source .env.docker; set +a

docker compose up --build -d
```

`docker compose --env-file .env.docker up --build -d` is equivalent, with no
need to export.

Then open <http://localhost:3000>.

If you do not need the browser-side Supabase client (for example, you only want
to confirm the container serves pages), plain `docker compose up --build` works
with no exported variables at all.

## 4. Check status

```bash
docker compose ps
```

`STATUS` should reach `Up … (healthy)` within roughly a minute for `frontend`
(30s `start_period` plus one 30s interval), and within about 15s for `backend`. `postgres` is usually healthy within
about 30s on first start, while it initialises its volume, and faster after that.

## 5. View logs

```bash
docker compose logs -f frontend
docker compose logs --tail=100 frontend
docker compose logs -f backend
docker compose logs -f postgres
```

Frontend and backend logs are the same V0.1.30 structured JSON logger writing
to stdout/stderr. Nothing is written to a log file inside the container.

## 6. Stop

```bash
docker compose down        # stops and removes containers — KEEPS database data
docker compose down -v     # ALSO DELETES the local database volume
```

Only `-v` deletes data; see [Data persistence](#data-persistence).

## 7. Rebuild

```bash
docker compose build                 # rebuild, reusing cached layers
docker compose build --no-cache      # full rebuild from the base image
docker compose up --build -d         # rebuild and restart in one step
```

A dependency change (`package.json` / `package-lock.json`) invalidates the
`deps` layer; a source change invalidates only the `builder` layer.

## 8. Healthcheck

The app exposes `GET /api/health`, which returns:

```json
{ "status": "ok" }
```

It reports **process liveness only** — no Supabase call, no database check, no
env values, no versions, no project refs. That is deliberate: Docker's
healthcheck answers "is this web process alive?", and a backend blip must not
restart a healthy container or tie the probe to one provider.

Verify from the host:

```bash
curl -i http://localhost:3000/api/health          # expect 200
docker compose exec frontend node healthcheck.mjs      # the container's own probe
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q frontend)"
curl -i http://localhost:4000/health              # backend liveness, expect 200
curl -i http://localhost:4000/ready               # backend readiness (PostgreSQL + restricted role)
```

The probe (`docker/healthcheck.mjs`) runs the image's own Node binary, so the
runtime image needs no `curl` or `wget`.

## 9. Environment variables

Two distinct phases, because `next build` **inlines** `NEXT_PUBLIC_*` values
into the browser bundle:

| Variable | Build-time | Runtime | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | yes | Inlined into client JS; also read by server code |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | yes | Same |
| `NEXT_PUBLIC_SITE_URL` | yes | yes | Same |
| `SUPABASE_SECRET_KEY` | **no** | yes | Secret — runtime only, never a build arg |
| `SUPABASE_PROJECT_REF` | no | yes | |
| `RATE_LIMIT_HASH_SECRET` | no | yes | Secret — runtime only |
| `RATE_LIMIT_TRUSTED_IP_HEADER` | no | yes | Only behind a proxy you control |
| `RATE_LIMIT_DISABLED` | no | yes | Leave unset for prod-like runs |
| `LOG_LEVEL` | no | yes | `debug`/`info`/`warn`/`error` |
| `POSTGRES_DB` | — | `postgres` service | Default `cartoona` |
| `POSTGRES_USER` | — | `postgres` service | Default `cartoona` |
| `POSTGRES_PASSWORD` | — | `postgres` service | Secret. No default: left empty, the database refuses to initialise |
| `DATABASE_URL` | no | `lib/db` (V0.1.39, no route uses it yet) | `postgresql://cartoona:<password>@postgres:5432/cartoona`, for a backend inside the compose network. Before any route uses it, point it at an app login role, not the owner ([POSTGRES_DATA_ACCESS.md](POSTGRES_DATA_ACCESS.md)) |
| `LOCAL_DATABASE_URL` | — | host tools | `postgresql://cartoona:<password>@localhost:5433/cartoona`, for psql and migrations on this Mac |
| `BACKEND_INTERNAL_URL` | no | set by compose, **not** from `.env.docker` | `http://backend:4000`. Server-side only, never `NEXT_PUBLIC_*`. For Next.js on the Mac: `http://127.0.0.1:4000` in `.env.local` |
| `BACKEND_REQUEST_TIMEOUT_MS` | no | frontend (optional) | Default `3000`, range 250–15000. One attempt per request |
| `CARTOONA_APP_DB_PASSWORD` | — | `scripts/db/app-login-role.sh` | Secret. The backend login role's password; `openssl rand -hex 32` |
| `BACKEND_DATABASE_URL` | — | `backend` service (as its `DATABASE_URL`) | `postgresql://cartoona_app_login:<app password>@postgres:5432/cartoona`. A restricted role, **never the owner** |

The `POSTGRES_*` and `BACKEND_DATABASE_URL` values are **interpolated by
Compose** into the `postgres` and `backend` services. The `backend` and
`postgres` containers have no `env_file`, so they never receive the frontend's
Supabase secrets, and the owner password stays out of the backend. The
**frontend** does get `.env.docker` as its `env_file`, which also contains the
database variables, so `compose.yml` blanks every one of them
(`POSTGRES_*`, `DATABASE_URL`, `LOCAL_DATABASE_URL`, `CARTOONA_APP_DB_PASSWORD`,
`BACKEND_DATABASE_URL`) in the frontend's `environment:`, which wins over
`env_file`. A static test checks the template against that list, so a new
database variable cannot be added without blanking it. Verify with
`docker compose exec frontend env | grep -E 'POSTGRES|DATABASE'` (all empty), and is why `.env.docker` must be exported
or passed with `--env-file`. Use a URL-safe password (`openssl rand -hex 24`) so
it can go into the URLs unescaped.

Rules:

- **No secret is ever a build arg.** Build args are visible in image history.
  Only the three `NEXT_PUBLIC_*` values are passed to the build, and they are
  public by definition.
- The image contains **no env file**. `.dockerignore` keeps `.env` and
  `.env.local` out of the build context entirely.
- Building with empty `NEXT_PUBLIC_*` values succeeds, which is why
  `docker compose up --build` works before you have filled anything in. Two
  consequences, though, so prefer a build with the values exported: the
  browser-side Supabase client reports a missing-configuration error, and a few
  public pages (`/pricing`, `/faq`, …) are prerendered as static instead of
  dynamic — their header is then permanently the signed-out one, because the
  session could not be read at build time.
- `docker build` never contacts a backend: every authenticated page is
  `force-dynamic`, so nothing is prerendered against Supabase. Do not "fix" a
  build failure by passing production credentials into the build.
- Dev-only switches (`CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION`,
  `DEV_PARENT_AUTH_*`) and the destructive-test variables (`CARTOONA_TEST_*`)
  belong in `.env.local`, never in a container.

## Local PostgreSQL

Status: **used by the backend only.** The service runs, persists data and is
health-checked. The `backend` reads it as a restricted login role; the
frontend never connects to it and holds no credential for it. The frontend
still starts and serves every page (except the pricing data) without this
database. See [POSTGRES_DATA_ACCESS.md](POSTGRES_DATA_ACCESS.md) and
[BACKEND.md](BACKEND.md).

| | Value |
|---|---|
| Image | `postgres:17-bookworm`, the same major version as the Supabase project (`supabase/config.toml`) |
| From containers on the compose network | `postgres:5432` |
| From this Mac | `localhost:5433`, bound to `127.0.0.1` only |
| Database / user | `cartoona` / `cartoona` |
| Volume | `cartoona_postgres_data` (named volume, not a bind mount) |

**Why 5433 and loopback:** 5433 avoids clashing with a PostgreSQL installed
natively on 5432. The port is published as `127.0.0.1:5433`, so it is reachable
from this Mac but not from other machines on the network.

**Authentication:** `scram-sha-256` for every connection, including the Unix
socket inside the container. The image's default `trust` for local sockets is
overridden. There is no passwordless superuser: with `POSTGRES_PASSWORD` empty,
the image refuses to initialise.

**Startup independence:** `frontend` has no `depends_on` at all, on purpose.
A missing password, an unhealthy database or a failing backend never stops the
web app from starting, and every page that does not need the pricing data
stays up. `GET /api/creation-pricing` simply answers its public 503 until the
backend is ready (one attempt, 3 s bound, no Supabase fallback). Only `backend`
waits for a healthy `postgres`.

**Healthcheck:** `pg_isready` over TCP every 5s (timeout 5s, 10 retries, 10s
start period). TCP rather than the socket, so the probe cannot report healthy
while the image's first-run initialisation server is still running.

### Commands

```bash
docker compose up -d                                   # all services
docker compose up -d postgres                          # database only
docker compose ps
docker compose logs -f postgres
docker compose exec postgres psql -U cartoona -d cartoona
docker compose restart postgres
docker compose down                                    # keeps data
docker compose down -v                                 # DELETES data
```

`exec … psql` authenticates with the container's own password, so it does not
prompt. From the Mac, with a local `psql`:

```bash
psql "$LOCAL_DATABASE_URL" -c "select version();"
```

### Data persistence

Data lives in the named volume `cartoona_postgres_data`, outside the repository,
so no database file can reach Git.

| Command | Containers | Database data |
|---|---|---|
| `docker compose restart postgres` | restarted | **kept** |
| `docker compose down` | removed | **kept** |
| `docker compose up -d` after `down` | recreated | **kept**, reattached |
| `docker compose down -v` | removed | **DELETED** |
| `docker volume rm cartoona_postgres_data` | — | **DELETED** |

`POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` are applied only when the
volume is first initialised. Changing them later in `.env.docker` does not change
an existing database. To start over with new values, use `docker compose down -v`
(this destroys local data).

### Not yet portable from Supabase

The 45 migrations in `supabase/migrations` assume Supabase-provided schemas and
roles: `auth.users`, `auth.uid()`, `auth.jwt()`, `auth.sessions`,
`auth.identities`, the `storage.buckets` and `storage.objects` tables, the
`storage.foldername()` function, the
`authenticated`/`anon`/`service_role` roles, and `extensions.gen_random_bytes`
(pgcrypto). They do **not** apply to this plain PostgreSQL as-is.

V0.1.38 adds a separate, Supabase-independent baseline for this database in
`database/migrations/`, applied with `scripts/db/migrate-local.sh`. It is not
used by the app yet. See [PLAIN_POSTGRES.md](PLAIN_POSTGRES.md).

## Backend boundary

Supabase remains the frontend's only backend: database, auth and storage. The
`backend` service (V0.1.40) serves liveness, readiness and a public pricing
read from the local `postgres`; since V0.1.41 the frontend's server calls that
pricing read for `GET /api/creation-pricing` and nothing else. The local `postgres` service is not a Supabase
replacement: it has no auth or storage schema, and no production data. See
[BACKEND.md](BACKEND.md).

Still deliberately absent: a Supabase CLI container, an auth emulator and a
storage emulator. Swapping backends should mean changing environment variables,
not deleting services.

## Image architecture

Three stages in `Dockerfile`, of which only the last ships:

| Stage | Base | Does |
|---|---|---|
| `deps` | `node:24-bookworm-slim` | `npm ci` from the lockfile |
| `builder` | `node:24-bookworm-slim` | `npm run build` (Next standalone output) |
| `runner` | `node:24-bookworm-slim` | Serves `node server.js` as user `nextjs` |

The runtime image carries only `.next/standalone` (which already contains the
traced production dependencies and `server.js`), `.next/static`, `public` and
the healthcheck script — no source tree, no dev dependencies, no tests, no
builder `node_modules`, no `.git`.

Other properties: `output: "standalone"` in `next.config.ts`; non-root user
`nextjs` (uid 1001) owning every copied file; `HOSTNAME=0.0.0.0` so the
published port reaches the app; `node server.js` as PID 1 so `docker stop`'s
SIGTERM reaches Next directly; Debian slim rather than Alpine because `sharp`
ships prebuilt glibc binaries.
