# Docker (V0.1.35)

Run Cartoona in a production-like container. **Only the web app runs in
Docker.** Supabase — or whichever backend provider replaces it — stays
external; see [Backend boundary](#backend-boundary).

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
# NEXT_PUBLIC_* must also be present at BUILD time (see section 9), so export
# them for the build; Compose reads them for the build args.
set -a; source .env.docker; set +a

docker compose up --build -d
```

Then open <http://localhost:3000>.

If you do not need the browser-side Supabase client (for example, you only want
to confirm the container serves pages), plain `docker compose up --build` works
with no exported variables at all.

## 4. Check status

```bash
docker compose ps
```

`STATUS` should reach `Up … (healthy)` within roughly a minute (30s
`start_period` plus one 30s interval).

## 5. View logs

```bash
docker compose logs -f app
docker compose logs --tail=100 app
```

Application logs are the V0.1.30 structured JSON logger writing to
stdout/stderr. Nothing is written to a log file inside the container.

## 6. Stop

```bash
docker compose down
```

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
docker compose exec app node healthcheck.mjs      # the container's own probe
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)"
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

## Backend boundary

Docker currently runs **only the Cartoona web app**. Supabase remains an
external, networked service.

Not present, and deliberately so until the backend-portability decision is
made: a PostgreSQL service, a Supabase CLI container, an auth emulator, a
storage emulator. The compose file therefore stays provider-neutral — swapping
backends should mean changing environment variables, not deleting services.

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
