# Route cutovers

Routes served through the Fastify backend instead of Supabase:

| Release | Route | Kind |
|---|---|---|
| V0.1.41 | `GET /api/creation-pricing` | public read |
| V0.1.45 | `GET /api/parent/orders` + the `/dashboard/orders` first page | **authenticated** read, the parent orders **LIST** only ([below](#v0145-parent-orders-list)) |

Everything else (order detail, final media, gallery, profile, candy balance,
welcome credits, billing, referrals, coupons, request submission and every
write) still runs on Supabase. A static guard (`route-cutover-static.test.ts`)
fails if any other route or page reaches the backend, and lists the backend's
exact routes (all GET).

## V0.1.41: `GET /api/creation-pricing`

The first route served through the Fastify backend instead of Supabase.

```
Browser ──> Next.js  GET /api/creation-pricing        (BFF; same URL, same contract)
              │  server-to-server, one attempt, 3 s bound, X-Request-Id forwarded
              v
            Fastify  GET /v1/creation-pricing         (http://backend:4000, compose network)
              │  restricted login role (cartoona_app_login)
              v
            PostgreSQL 17  public.creation_pricing
```

The browser still calls only `/api/creation-pricing`. It never calls Fastify, never
sees `BACKEND_INTERNAL_URL`, and the UI code (`lib/pricing/use-creation-pricing.ts`,
the creation pages) is unchanged.

## Why this route first

Public, read-only, no Auth, no Storage, no writes, one small table, and the
contract is fully specified by an existing route. A wrong answer costs a
temporary 503 on a price display, not money or data. It exercises everything a
later route needs: the server-to-server client, request-id propagation,
timeouts, the failure policy, the restricted database role and Docker wiring.

## What changed

| | Before | After |
|---|---|---|
| Data source | Supabase `creation_pricing` via the cookie-bound server client (PostgREST) | PostgreSQL via Fastify |
| Timeout | Supabase client's own fetch timeout | `BACKEND_REQUEST_TIMEOUT_MS`, default 3000, one attempt |
| Validation | in the route (blank/duplicate key, non-positive-integer cost, empty) | the same rules in `lib/repositories/creation-pricing.ts` (backend) **and** `lib/pricing/creation-prices.ts` (Next, on the payload) |
| Request id | none on this route | `withObservability` + forwarded to Fastify, one id end to end |
| Rendering | dynamic only because `cookies()` was read | explicit `dynamic = "force-dynamic"` |
| Fallback | n/a | **none** |

Unchanged, and owned by the Next route (not forwarded from Fastify):

- `200 { "prices": { "<pricing_key>": <candy_cost>, … } }` with
  `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` and
  `X-Content-Type-Options: nosniff`.
- `503 { "error": "قیمت‌ها در حال حاضر در دسترس نیستند.", "code": "CREATION_PRICING_UNAVAILABLE" }`
  with `Cache-Control: no-store`.
- Added: an `X-Request-Id` response header.

The Fastify endpoint (`backend/src/routes/creation-pricing.ts`) already served
that contract; it needed no change. The Next route additionally rebuilds the
catalog from validated entries (≤ 100 entries, non-blank keys ≤ 100 chars,
positive safe-integer costs) instead of relaying the backend's JSON.

## Failure policy: the public 503, no fallback

Any of these returns the 503 above, after exactly one attempt:

- `BACKEND_INTERNAL_URL` missing or invalid (no network call is made);
- connection refused / reset / DNS failure / redirect;
- no answer within the timeout (covers connect, headers and body);
- a non-2xx status from the backend (including its own 503);
- a 2xx whose body is not JSON, is too large, or fails validation.

It **never** reads Supabase or any other source, never retries, and never
echoes the backend address, an exception, a status text or a response body.
A backend outage is meant to be visible.

## Operational consequences — read before deploying

1. **Every environment that serves this branch now needs a reachable backend.**
   Without one, the creation pages cannot price a request (they show their
   "prices unavailable" state). This cutover is wired for local/Docker only;
   there is no production backend or production PostgreSQL yet.
2. **The PostgreSQL catalog is a seed copy, not a synced one.** It comes from
   `database/migrations/0008_reference_data.sql`. A price edited in Supabase
   no longer changes the site, and there is no admin screen that edits prices
   (they were edited in the database directly). Until the data copy, edit the
   price in PostgreSQL.
3. `npm run dev` on the Mac needs the backend running
   (`npm run backend:dev`) and `BACKEND_INTERNAL_URL=http://127.0.0.1:4000`
   in `.env.local`, or the pricing route answers 503.
4. `tests/e2e/live-price-change.spec.ts` (Playwright) is skipped: it changed a
   price in Supabase, which this route no longer reads. The equivalent proof is
   `tests/unit/creation-pricing-cutover-db.test.ts`.

## Frontend credential boundary

`env_file: .env.docker` hands the frontend the whole file, which also holds the
database owner password, `DATABASE_URL`, the backend's app-role password and
`BACKEND_DATABASE_URL`. Until V0.1.41 these reached the frontend container.
`compose.yml` now blanks all seven in the frontend's `environment:` (which
takes precedence), and a static test fails if the template gains a database
variable that is not blanked.

| | Frontend | Backend | Browser |
|---|---|---|---|
| Database credentials | none (verified empty) | restricted `cartoona_app_login` URL only | never |
| Backend address | `http://backend:4000` | n/a | never (not `NEXT_PUBLIC_*`, absent from `.next/static`) |
| Owner password | none | none | never |

## Docker and startup

- `frontend` has no `depends_on: backend`, on purpose: the web process and
  every page that does not need pricing start and stay healthy while the
  backend is down, and the route answers its 503 until the backend is ready.
- `backend` `depends_on: postgres (healthy)`.

## Verified locally (Docker, 2026-10-16)

- Price set to 4242 **only** in PostgreSQL → `GET :3000/api/creation-pricing`
  returned 4242; restored to 12 → 12. (Automated: the same test in
  `creation-pricing-cutover-db.test.ts`.)
- Backend stopped → 503 in 0.38 s. Backend frozen (`docker pause`, accepts the
  connection, never answers) → 503 at 3.09 s. In both, the frontend stayed
  healthy and `/`, `/login`, `/create-image` and `/api/health` returned 200.
- One `X-Request-Id` appears in the Next, backend-client and Fastify log lines.

Local timings, 300 warm requests each, interleaved, from the Mac to Docker
Desktop (**not production estimates**):

| Path | median | p90 |
|---|---|---|
| Fastify direct `:4000/v1/creation-pricing` | 2.54 ms | 4.09 ms |
| Next `:3000/api/creation-pricing` (→ Fastify → PostgreSQL) | 4.72 ms | 8.74 ms |

## Rolling this route back

Revert the commit. The old route is in git history; nothing else depends on the
new one. There is deliberately no runtime switch, because a silent fallback is
exactly what this cutover rules out.

## V0.1.45: parent orders LIST

**Migrated:** `GET /api/parent/orders` (load more) **and** the first page that
`/dashboard/orders` renders on the server. The page never called the API for
its first page; it ran the same Supabase query itself. Moving only the API
would have served page 1 from Supabase and pages 2+ from PostgreSQL, so both
now share one loader (`lib/parent/orders/backend-orders.ts`). The browser
still talks only to Next: same URL, same `{ orders, nextCursor }`, same UI.

**Not migrated:** order detail (`/dashboard/orders/[orderId]`), final media,
gallery, every other dashboard page, and every write. No write path exists on
the backend.

```
Browser ──> Next  GET /api/parent/orders?cursor=&limit=     (or the /dashboard/orders server render)
              │  cursor/limit validated (400 before any auth work)
              │  verifySupabaseIdentity: getSession (cookie) + getUser(token)   1 provider round trip, 4 s bound
              │  signed v2 assertion bound to GET /v1/parent/orders; one attempt, 3 s bound, X-Request-Id forwarded
              v
            Fastify  GET /v1/parent/orders
              │  requireAuth   assertion -> user_identities + users (role, deleted, sessions_not_before)
              │  requireRole("parent")
              │  findParentProfileIdByUserId(principal.userId)
              │  getParentOrdersPage(profile, cursor, limit)   WHERE parent_id = $1, delivered_at inline
              v
            PostgreSQL 17   (cartoona_app_login: SELECT only; no grant added)
```

### Contract

| Situation | Fastify `/v1/parent/orders` | Next `/api/parent/orders` |
|---|---|---|
| page | 200 `{ orders, nextCursor }` | 200 the same body (re-validated field by field) |
| bad cursor/limit; unknown parameter (Fastify) | 400 `invalid_request` | 400 `code: invalid_request` |
| no / rejected session | 401 `unauthenticated` | 401 `code: unauthenticated` |
| older than 30 days | 401 `session_expired` | 401 `code: session_expired` + local sign-out |
| before `sessions_not_before` | 401 `session_invalidated` | 401 `code: session_invalidated` + local sign-out |
| identity provider down/slow | n/a | 503 `code: auth_unavailable`, no sign-out |
| verified, not linked | 403 `identity_not_linked` | 403 `code: identity_not_linked` |
| admin, super_admin, deleted | 403 `forbidden` | 403 `code: forbidden` |
| parent without a profile | 404 `parent_profile_not_found` | **200 `{ orders: [], nextCursor: null }`**, unchanged from before |
| database down | 503 `service_unavailable` | 503 `code: service_unavailable` |
| backend down, timeout, 5xx, malformed body, or our own assertion rejected | n/a | 503 `code: service_unavailable`, no sign-out |

Every Next body has a Persian `error` and a stable `code`. Both layers send
`Cache-Control: no-store`, and the Next route is `force-dynamic`. A list
order has seven fields (`id`, `requestType`, `createdAt`, `displayTitle`,
`status`, `candyCost`, `completedAt`). `child_name` was never part of the
list and still is not. Pre-cutover, a database failure was a 500; it is now a
503, and a `limit` outside 1..50 is now a 400 instead of being clamped. The
browser sends neither.

**The dashboard page:** a signed-out, expired or invalidated session
redirects to `/login`. An auth or backend outage shows the existing retryable
error state. A missing profile, or an admin account (which middleware lets
into `/dashboard`), shows the existing no-profile state, as before.

### Identity

The caller comes only from `requireAuth`. `X-User-Id`, `X-Role`, cookies,
bearer tokens and a `parentProfileId` in the query are never read. Next does
not forward them, and Fastify answers 400 to any query parameter other than
`cursor`/`limit`. The profile is resolved on the backend from
`principal.userId`. The ownership boundary is the repository's `WHERE
parent_id = $1`, and it is proven with two parents whose orders share the same
timestamps, including a cursor replayed across parents. The assertion binds
method and path, not the query string: a query can only page within the
caller's own data.

### Removed

`lib/parent/orders/queries.ts`, the Supabase `getParentOrdersPage`. It made
an `orders` PostgREST query plus the `get_parent_orders_delivered_at` RPC, and
it had no other caller. The list surfaces no longer use
`resolveParentRequestContext`, which is kept for order detail and
welcome-credits. The RPC itself stays in the Supabase database, because
historical migrations are never edited.

### Round trips

| | Before (Supabase) | After |
|---|---|---|
| `/api/parent/orders` | `getUser` → [`users.role` ‖ `parent_profiles`] → `orders` → `get_parent_orders_delivered_at`: **5 Supabase requests, 4 sequential stages** | `getUser` (1 provider request) → 1 backend call → 3 sequential local DB queries (identity, profile, page with delivered_at inline) |
| `/dashboard/orders` first page | middleware (`getUser` + `users.role`) + page `getUser` → `parent_profiles` → `orders` → RPC | middleware (unchanged) + page `getUser` → 1 backend call (3 DB queries) |

**Remaining duplication:** on the page, middleware and the page each verify
the session with the provider (2 provider calls). Removing one would mean
trusting middleware state in the page, which needs a signed request-context
hand-off. That redesign is out of scope here. The API route has no middleware
in front of it, so it verifies exactly once.

### Verified locally (2026-10-18/19)

- `parent-orders-cutover-db.test.ts` (opt-in, 19 tests): copied data from
  `supabase-source-fixture.sql` + `parent-orders-extra.sql`, through the V0.1.44
  copy, the stub provider (real `@supabase/ssr`), the real Next handler, and a
  listening Fastify on a script-provisioned login role. It covers every page,
  cursors, timestamps to the microsecond, completion dates, cross-parent
  isolation, forgery, every failure row above, and the page loader.
- **Docker** (frontend + backend + postgres, all healthy). A scratch override
  aimed only the frontend's server-side Supabase URL at the local stub, with a
  separately tagged image. In headless Chromium, `/dashboard/orders` returned
  200 with 20 cards rendered by the server from PostgreSQL. "Load more" went
  through `/api/parent/orders` (200, `no-store`), loaded the remaining 10 and
  showed the end-of-list message. The browser made requests to
  `localhost:3000` only (all others blocked; none attempted). The page holds
  no backend address or assertion. One request id appeared in both the Next
  and Fastify logs. The frontend held no DB credential, the backend no
  Supabase variable, and the internal auth secret appeared in neither the
  browser bundle nor the logs. The backend stayed published on
  `127.0.0.1:4000` only.

Warm local timings, first page of 20 (localhost, **not production estimates**):

| Path | median | p90 |
|---|---|---|
| Fastify directly (signed assertion), in-process test | 4.3 ms | 7.1 ms |
| Next handler → Fastify → PostgreSQL, in-process test (incl. stub provider) | 6.9 ms | 10.3 ms |
| Docker: real Next server → Fastify → PostgreSQL (incl. stub provider) | 7.9 ms | 10.8 ms |

### Test infrastructure: `hookTimeout` 60 s (decision, 2026-10-20)

`vitest.config.ts` raises `hookTimeout` from 10 s to 60 s. Audit result:

- With the default 10 s, a full run with `CARTOONA_PLAIN_PG=docker` failed
  intermittently (2 failed `afterAll` hooks in one run, none in the next), always
  in the `DROP DATABASE ... WITH (force)` teardown of the opt-in suites, which run in
  parallel against one cluster. No test assertion failed.
- No hook hangs: after the timed-out runs the cluster held only `cartoona`
  (no scratch databases or roles left), and the 60 s run passed 2322 tests.
- A genuinely hung hook still fails: a probe `afterAll` that never resolves failed with
  "Hook timed out" (probe removed). Cleanup stays deterministic and a broken
  teardown is still reported.
- The default `npm test` run (no PostgreSQL) never reaches these hooks.

A per-hook timeout was considered but rejected: it would touch about 14 hooks in 9
pre-existing suites outside this change. Revisit if a teardown ever approaches 60 s;
that would be a real problem, not load.

### Production status

**Not deployable.** The cutover is blocked by four open items:

- the V0.1.43 `amr` verification on a real Supabase project;
- a rehearsal of the data copy on a real `pg_dump` export;
- a production deployment of the backend and PostgreSQL;
- the storage migration (order detail and gallery need signed URLs).

## Next

V0.1.46 (parent account reads) follows the same pattern: one shared loader per
surface, `requireAuth` + `requireRole("parent")`, the profile resolved on the
backend, and SELECT grants only. Writes need non-GET client support, a
one-time nonce against assertion replay, and EXECUTE grants first
([BACKEND.md](BACKEND.md#before-the-first-authenticated-route-cuts-over)).
