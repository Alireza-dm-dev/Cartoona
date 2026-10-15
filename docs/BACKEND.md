# Backend (V0.1.40)

A Fastify API in `backend/`, running as its own container next to the Next.js
frontend and the local PostgreSQL 17. It reuses the V0.1.39 data-access layer
(`lib/db`, `lib/repositories`) directly. There is no second pool and no copied
SQL.

> **Status: side by side, no traffic.** The frontend still serves every page
> and API route from Supabase (database, Auth, Storage) and never calls the
> backend. `/api/creation-pricing` and every other Next route are unchanged.
> The backend serves liveness, readiness and one public read so the stack can
> be exercised end to end. Routes move over domain by domain later.

## Architecture

```
            today                                   target (later versions)
Browser ──> Next.js (frontend) ──> Supabase         Browser ──> Next.js (frontend / BFF)
                                                                   │ server-to-server, compose network
            Fastify (backend) ──> PostgreSQL 17                    v
            (side by side, unused by the frontend)              Fastify (backend) ──> PostgreSQL 17
```

| Layer | Where | Knows about |
|---|---|---|
| HTTP | `backend/src/app.ts`, `routes/`, `plugins/`, `errors/` | Fastify |
| Data access | `lib/db/*`, `lib/repositories/*` | `pg` only. No Fastify, Next.js or Supabase (enforced by tests) |
| Observability | `lib/observability/logger.ts`, `request-id.ts` | nothing; shared with the frontend |

```
backend/
  src/
    app.ts          buildBackendApp(deps): the app, never listening
    server.ts       config -> app -> listen; SIGTERM/SIGINT -> graceful close
    config.ts       BACKEND_PORT / BACKEND_HOST / DATABASE_URL validation
    routes/         health.ts (/health, /ready), creation-pricing.ts (/v1/creation-pricing)
    plugins/        observability.ts (request id, completion logs, nosniff)
    errors/         error-handler.ts (central mapping, 404)
    auth/           principal.ts (AuthPrincipal / AuthAdapter: types only)
  build.mjs         esbuild bundle -> backend/dist/server.cjs (gitignored)
  healthcheck.mjs   container liveness probe
  Dockerfile        + Dockerfile.dockerignore (deny by default)
  tsconfig.json     backend-scoped typecheck
```

`buildBackendApp({ db, closeDb })` takes its database as a lazy getter.
Building the app or serving `/health` opens no connection. Tests inject a
fake, or use the real pool against local PostgreSQL. The backend never runs
migrations.

## Endpoints

| Route | Purpose | Responses |
|---|---|---|
| `GET /health` | **Liveness.** The process serves HTTP. No database, no env, no dependency. | 200 `{"status":"ok"}` |
| `GET /ready` | **Readiness.** `SELECT 1` succeeds **and** the session is a restricted `cartoona_app` login. The role check passes once and is then cached; the ping runs every time. | 200 `{"status":"ready"}`, 503 `{"status":"unavailable"}` |
| `GET /v1/creation-pricing` | Public price catalog from PostgreSQL (`getActiveCreationPrices`). Same contract as the Next route `GET /api/creation-pricing`. | 200 `{"prices":{…}}` with `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`; 503 `{"error":"<Persian message>","code":"CREATION_PRICING_UNAVAILABLE"}` with `no-store` for a DB failure or an invalid or empty catalog |
| anything else | | 404 `{"error":"not_found"}` |

Every response carries `X-Request-Id` and `X-Content-Type-Options: nosniff`.
Health, readiness and error responses are `Cache-Control: no-store`.

The Docker healthcheck probes `/health`, never `/ready`. A database outage must
not get a healthy backend restarted. An orchestrator or load balancer should
gate traffic on `/ready`.

## Logging and errors

The backend uses the frontend's allow-listed JSON logger, so both processes
emit the same lines. Fastify's own pino logger is off.

- **`REQUEST_COMPLETED`**, one per request: `requestId`, `method`, `route`
  (the **template**, e.g. `GET /v1/creation-pricing`, never the URL or query),
  `status`, `durationMs`. Levels: 5xx is `error`, 503 is `warn`, and anything
  else is `info`. An unmatched route logs `reason: route_not_found` with no
  path.
- **Request id:** a well-formed incoming `X-Request-Id` (8–64 characters of
  `[A-Za-z0-9._-]`) is reused. Anything else is replaced by a fresh UUID.
  Fastify's built-in header trust is off.
- **Never logged:** URLs, query strings, headers, cookies, tokens, request
  bodies, the database URL or password, SQL parameters, raw database messages,
  or user data. The logger drops anything outside its allow-list in any case.

| Failure | Status | Body |
|---|---|---|
| Validation or malformed request (Fastify 4xx) | that 4xx | `{"error":"invalid_request"}` |
| `DbError` unavailable, timeout, serialization or deadlock; `DbConfigError` | 503 | `{"error":"service_unavailable"}` |
| Anything else, including other `DbError` kinds | 500 | `{"error":"internal_error"}` |

No stack, message, SQLSTATE or constraint name ever reaches a response.
`/v1/creation-pricing` maps its own failures to the Next route's 503 body, so
the contract is identical.

## Restricted database login

| Credential | Used by | Rights |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` (owner) | migrations (`scripts/db/migrate-local.sh`), `app-login-role.sh`, psql | everything; **never given to the backend** |
| `cartoona_app_login` via `BACKEND_DATABASE_URL` | the backend's `DATABASE_URL` | member of `cartoona_app`: SELECT on the 7 read tables, nothing else |

The backend refuses to be ready on an over-privileged connection. `/ready`
returns 503 (logged as `READINESS_FAILED db_role_<reason>`) when the session
is a superuser, has CREATEROLE, CREATEDB, BYPASSRLS or REPLICATION, owns any
table in `public`, or is not a member of `cartoona_app`.

Provision it once per environment, after migrations:

```bash
openssl rand -hex 32        # hex: safe inside a URL (base64 '/' and '+' are not)
# put it in .env.docker as CARTOONA_APP_DB_PASSWORD and inside BACKEND_DATABASE_URL, then:
set -a; source .env.docker; set +a
DATABASE_URL="$LOCAL_DATABASE_URL" scripts/db/migrate-local.sh
DATABASE_URL="$LOCAL_DATABASE_URL" scripts/db/app-login-role.sh      # creates cartoona_app_login
```

Without a host `psql`, add `PSQL=scripts/db/psql-docker.sh` and use
`DATABASE_URL=postgresql://cartoona@postgres:5432/cartoona` (the container's
own password applies). Re-running the script rotates the password.

Verified locally with the backend's own credentials:

- **Allowed:** SELECT on `users`, `parent_profiles`, `creation_pricing`,
  `parent_welcome_credits`, `candy_wallets`, `orders` and
  `order_status_history`.
- **Refused:**
  - CREATE TABLE, DROP TABLE and ALTER TABLE;
  - reading `schema_migrations` or any ungranted table;
  - INSERT, UPDATE and DELETE;
  - executing `create_parent_request_trusted` or `update_order_status_trusted`;
  - disabling triggers, `SET session_replication_role`, and CREATE ROLE.

## Containers and ports

| Service | Host port | Container | Notes |
|---|---|---|---|
| `frontend` | `3000` | `0.0.0.0:3000` | unchanged apart from the service name (was `app`) |
| `backend` | **`127.0.0.1:4000`** only | `0.0.0.0:4000` | loopback publish is for local curl and debugging; other containers use `http://backend:4000` |
| `postgres` | `127.0.0.1:5433` | `5432` | |

- The frontend has **no** `depends_on` and no reference to the backend.
- The backend `depends_on: postgres (service_healthy)`.
- The backend receives **no** `env_file`, only the variables listed in
  `compose.yml`. It never sees the frontend's Supabase secrets or the owner
  password.

**Image** (`backend/Dockerfile`, context = repository root):

- **build stage:** `npm ci` from the lockfile, then esbuild bundles `server.ts`
  plus `lib/*`, `fastify` and `pg` into one `server.cjs`.
- **runtime stage:** `node:24-bookworm-slim`, user `backend` (uid 1001), and
  exactly two files, `server.cjs` and `healthcheck.mjs`. It has no
  node_modules, source, tests, `.git` or env files.
- **`backend/Dockerfile.dockerignore`:** denies everything except the
  manifests, `tsconfig.json`, `types/`, `lib/` and `backend/{src,build.mjs,healthcheck.mjs}`.
- **The root `.dockerignore`:** now excludes `backend/` from the frontend image.
- **Process:** `node server.cjs` runs as PID 1 with no `init` and no shell.
  SIGTERM closes the listener, finishes in-flight requests, ends the pool and
  exits 0, with an 8s hard deadline.

## Commands

```bash
# Local, no Docker (needs DATABASE_URL to a restricted role on localhost:5433)
npm run backend:dev          # esbuild watch + restart, binds 127.0.0.1:4000
npm run backend:build        # -> backend/dist/server.cjs
npm run backend:start        # node backend/dist/server.cjs (BACKEND_HOST defaults to 0.0.0.0)
npm run backend:typecheck

# Docker
docker compose --env-file .env.docker up --build -d --remove-orphans
docker compose ps                         # frontend, backend, postgres: healthy
curl http://localhost:4000/health
curl http://localhost:4000/ready
curl http://localhost:4000/v1/creation-pricing
docker compose logs -f backend
docker compose stop backend               # graceful: SIGTERM -> exit 0
```

`npm run dev`, `npm run build` and `npm start` are unchanged.

## CORS and server-to-server

CORS is **not enabled**: no `Access-Control-*` header is ever sent, and
preflights get a 404. No browser calls the backend. The intended flow is:

```
Browser -> Next.js (frontend / BFF) -> http://backend:4000 (compose network) -> PostgreSQL
```

The Next server calls the backend server-to-server, so the backend never has
to trust a browser origin, cookie or user-supplied identity. If browser-direct
calls are ever needed, add an explicit origin allow-list (never `*`) at that
point.

## Authentication boundary (not implemented)

`backend/src/auth/principal.ts` declares the boundary only. No backend route
is authenticated yet.

```
request -> AuthAdapter.verify()  -> AuthPrincipal { userId, role }  -> service/repository({ parentProfileId, ... })
           (provider-specific)      (verified, provider-neutral)       (explicit ids, no session lookups)
```

- A principal comes only from an adapter that verified a credential. A user
  id, role or profile id sent by the browser is never trusted.
- `userId` is the plain `public.users.id`. During migration, a Supabase-backed
  adapter maps the Supabase user to it through `user_identities`.
- Repositories already take explicit actor ids (V0.1.39); routes pass the
  principal's ids down.

## Local timings (informational)

Warm, keep-alive, 200 sequential requests each, from the Mac to Docker
Desktop. These are **not production estimates**.

| Endpoint | median | p90 |
|---|---|---|
| `/health` | 2.14 ms | 3.79 ms |
| `/ready` | 2.48 ms | 2.84 ms |
| `/v1/creation-pricing` | 2.45 ms | 3.37 ms |

## Tests

| File | Database | Covers |
|---|---|---|
| `tests/unit/backend-app.test.ts` | fake | build without listening; /health without DB; /ready 200/503 incl. unsafe roles; pricing contract; safe DB errors; request ids; logs; 404/500/400/413; no CORS; config |
| `tests/unit/backend-container.test.ts` | none | Dockerfile (base, non-root, PID 1, 0.0.0.0, two files), dockerignore, compose (loopback, restricted URL, no env_file), frontend independence, import boundaries, scripts |
| `tests/unit/backend-db.test.ts` | opt-in `CARTOONA_PLAIN_PG=docker` | the real pool as a script-provisioned login role: /ready, live pricing, refusal of non-member and owning roles, unreachable DB, and the role's denied privileges |

## Before the first real route cuts over

1. **Identity:** an `AuthAdapter` that verifies the caller (Supabase Auth
   first), plus a mapping from the Supabase user id to `users.id` through
   `user_identities` or matching UUIDs from the data copy.
2. **Data:** the domain's data in PostgreSQL, through the copy procedure in
   PLAIN_POSTGRES.md or dual writes. The local database holds only the seeded
   reference data today.
3. **Frontend to backend client:** a server-only client in the Next app for
   `http://backend:4000`, with a timeout, request-id propagation and a
   fallback policy. Add `depends_on` or retry only when a route needs it.
4. **Grants:** EXECUTE on the `*_trusted` functions a write route needs, in a
   new migration.
5. **Deployment:** where the backend runs outside local compose, how it is
   reached privately, and how `BACKEND_DATABASE_URL` is provisioned.
