# Route cutover: `GET /api/creation-pricing` (V0.1.41)

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

## Next

The identity chain for authenticated routes exists since V0.1.42
([AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md)): the Next server verifies the
Supabase session, signs a short-lived assertion bound to the backend method
and path, and Fastify resolves it through `user_identities` to a Cartoona user
and role. The proof route `GET /api/auth/backend-me` exercises it end to end.
Since V0.1.43 it also carries the provider-verified sign-in time, and the
backend enforces Cartoona's session policy: a 30-day lifetime and
`users.sessions_not_before`. The Supabase session-lifetime RPC is gone.
**No business route uses it yet.** The first candidate is the parent orders
list. It still needs real data in PostgreSQL. See [BACKEND.md](BACKEND.md#before-the-first-authenticated-route-cuts-over).
