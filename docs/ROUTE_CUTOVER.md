# Route cutovers

Routes served through the Fastify backend instead of Supabase:

| Release | Route | Kind |
|---|---|---|
| V0.1.41 | `GET /api/creation-pricing` | public read |
| V0.1.45 | `GET /api/parent/orders` + the `/dashboard/orders` first page | **authenticated** read, the parent orders **LIST** only ([below](#v0145-parent-orders-list)) |
| V0.1.46 | `GET /api/parent/welcome-credits`, `GET /api/parent/account-summary` (new), the public header's parent name | **authenticated** reads: welcome credits, candy balance, profile name ([below](#v0146-parent-account-reads)) |
| V0.1.47 | none (backend-only `PATCH /v1/parent/profile`) | write-security foundation; **no Next.js route cut over** ([below](#v0147-write-security-foundation)) |

### Migration status

| Surface | Data | Status |
|---|---|---|
| creation pricing | `creation_pricing` | **PostgreSQL** (V0.1.41) |
| parent orders list (page 1 + load more) | `orders`, `order_status_history` | **PostgreSQL** (V0.1.45) |
| parent profile name (public header) | `parent_profiles.full_name` | **PostgreSQL** (V0.1.46) |
| candy balance (billing) | `candy_wallets.balance` | **PostgreSQL** (V0.1.46) |
| welcome image credits (billing, creation review) | `parent_welcome_credits` | **PostgreSQL** (V0.1.46) |
| billing purchase history | `candy_purchases`, `payment_attempts`, `coupon_redemptions`, `coupons` | Supabase (old path) |
| candy package catalog | `candy_packages` | Supabase (old path) |
| consent gate (middleware, `/complete-request`) | `parent_profiles.consent_granted` | Supabase (old path) |
| referral summary | RPC `get_current_parent_referral_summary` | Supabase (old path) |
| order detail, final media, gallery | orders + Storage | Supabase (old path) |
| parent display-name write | `parent_profiles.full_name` | **PostgreSQL, backend only** (V0.1.47): `PATCH /v1/parent/profile`; no Next route or UI calls it |
| every product write (requests, purchases, coupons, referrals, profile creation, password, consent, admin) | | Supabase (old path) |
| identity / session | Supabase Auth | Supabase Auth (provider; by design until replaced) |

Everything marked "old path" still runs on Supabase. A static guard
(`route-cutover-static.test.ts`) fails if any other route or page reaches the
backend, and lists the backend's exact routes (GETs plus the one V0.1.47
PATCH); `write-security-static.test.ts` fails if any Next write handler calls
the backend.

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
- No hook hangs: the hooks are slow, not stuck, and the 60 s run passed 2322
  tests. **Correction (2026-10-21):** a timed-out hook is cut off mid-teardown.
  After the 10 s run the scratch databases were gone, but three roles from the
  two cut-off hooks (`cartoona_app_a…`, `_b…`, `_o…`) were still in the cluster.
  They were found and dropped during V0.1.46. This strengthens the decision:
  at 10 s, cleanup was not just reported late, it was left incomplete.
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

## V0.1.46: parent account reads

### Audit (before any change)

| # | Read path | Surface | Supabase calls before | Auth / profile | Page render bypasses an API? | Storage | Writes in the same endpoint | Class |
|---|---|---|---|---|---|---|---|---|
| 1 | welcome credits | `GET /api/parent/welcome-credits` (creation review, client fetch) | `getUser`, `users.role` ‖ `parent_profiles` + lifetime, `parent_welcome_credits` | `resolveParentRequestContext({ verify: "full" })` | no (client only) | no | no | **A** |
| 2 | candy balance + welcome credits | `GET /api/candy-purchases` (billing page, client fetch on load and after each purchase step) | `getUser`, `users.role`, lifetime, `parent_profiles`, `parent_welcome_credits`, `candy_wallets`, then the history reads | inline in the route | no (client only) | no | `POST` in the same file (separate handler) | **A** for balance/credits |
| 3 | billing purchase history | same `GET /api/candy-purchases` | `candy_purchases`, `payment_attempts`, `coupon_redemptions`, `coupons` (admin client), `candy_packages` | same | no | no | payment state, coupons | **D**: payment/coupon state, an admin-client read, not an account read |
| 4 | parent profile name | public header (`getPublicHeaderAccount`: marketing layout, homepage, creation layout) | `getUser`, `users.role`, `parent_profiles.full_name` | inline; no lifetime check | server render only; the homepage resolved it **twice** (layout + page) | no | no | **A** |
| 5 | settings / "profile" | `/dashboard/settings` | none from the database: `getUser().user_metadata.password_set` (Auth metadata); the profile card is a TODO with no data | n/a | n/a | no | password form posts elsewhere | **D**: no database read exists; Auth metadata stays with the provider |
| 6 | consent flag | middleware (`/complete-request`) + `/complete-request` page | `parent_profiles.consent_granted` | middleware | yes (both read it) | no | no | **D**: an access gate inside middleware; moving the page alone would split one value across two databases |
| 7 | referral summary | `GET /api/referrals` | RPC `get_current_parent_referral_summary` (SECURITY DEFINER aggregate) | inline | no | no | the page also binds codes (write) | **D**: not requested, porting an aggregate RPC |
| 8 | candy package catalog | `GET /api/candy-packages` | `candy_packages` | none (public) | no | no | no | **D**: public catalog, not an account read |
| 9 | order detail, gallery, final media | `ParentRequestContext` and others | orders + Storage | various | yes | **yes** | no | **C** |
| 10 | complete-signup, password, consent, purchases, coupons, referrals bind, requests | POST routes | | | | some | **yes** | **B** |

No dashboard page renders an account value on the server and then refreshes
it through an API, so the V0.1.45 page-1 trap does not occur here. The
equivalent risk was row 2: the billing page reads the balance on load and
again after every purchase step. Both reads now use the same route.

### Scope

**Migrated:** welcome image credits (row 1), the candy balance and welcome
credits on billing (row 2), and the parent profile name (row 4). **Not
migrated:** rows 3 and 5–10. The settings page has no profile data to move
(its profile card is an unbuilt TODO), so the only profile value the parent UI
shows is the header greeting.

### Flows

```
Before
  creation review  ─> /api/parent/welcome-credits ─> getUser ─> users.role ‖ parent_profiles (+ lifetime) ─> parent_welcome_credits      [Supabase]
  billing page     ─> /api/candy-purchases (GET)   ─> getUser ─> users.role ─> lifetime ─> parent_profiles ─> parent_welcome_credits
                                                      ─> candy_wallets ─> candy_purchases ─> payment_attempts ─> coupon_redemptions ...  [Supabase]
  public header    ─> getUser ─> users.role ─> parent_profiles.full_name                                                         [Supabase]

After
  creation review  ─> Next /api/parent/welcome-credits ─┐
  billing page     ─> Next /api/parent/account-summary ─┤  verifySupabaseIdentity (1 provider call, 4 s bound)  ONCE per request
  public header    ─> getPublicHeaderAccount ───────────┘  signed v2 assertion per backend path; one attempt each, 3 s bound
                          v
                    Fastify  GET /v1/parent/welcome-credits | /v1/parent/candy-balance | /v1/parent/profile
                          │  requireAuth (user_identities + users: role, deleted, sessions_not_before)
                          │  requireRole("parent")
                          │  findParentProfileIdByUserId(principal.userId)   (profile route: getParentProfileDisplay(userId))
                          │  getWelcomeImageCreditsRemaining | getCandyBalance | full_name
                          v
                    PostgreSQL 17   (cartoona_app_login: SELECT only; no grant added)

  billing page     ─> /api/candy-purchases (GET) ─> purchase history only, still Supabase
```

The billing page now makes three parallel requests: `/api/candy-packages`,
`/api/candy-purchases` (history, Supabase) and `/api/parent/account-summary`
(balance and credits, PostgreSQL). Its first load and every refresh after a
purchase step use the same three (`lib/candy-purchases/billing-client.ts`), so
the displayed balance always has one source. Purchase creation, completion and
coupons still POST to the Supabase routes.

**Consistency until writes move.** The balance and credits are now read from
PostgreSQL. Purchases (which credit the wallet) and request submission (which
spends credits and candy) still write to Supabase. On one running system the two would drift
apart: a completed purchase would not change the PostgreSQL balance. This is the same condition
the orders list has had since V0.1.45. It is acceptable only because none of
this is deployed. Production needs either all of these writes moved before
the switch or a final copy at the cutover freeze
([DATA_MIGRATION.md](DATA_MIGRATION.md)).

> **Do NOT deploy this branch** until either (a) the related writes (candy
> purchases and completion, request submission, coupons) also write to
> PostgreSQL, or (b) a final production data copy under a write freeze is part
> of the cutover. Deploying earlier makes balances and credits shown to
> parents diverge from what Supabase records.

### Contracts

| Situation | Fastify (`/v1/parent/...`) | `/api/parent/welcome-credits` | `/api/parent/account-summary` | public header |
|---|---|---|---|---|
| value | 200 `{ welcomeImageCreditsRemaining }` / `{ balance }` / `{ fullName }` | 200 `{ welcomeImageCreditsRemaining }` | 200 `{ wallet: { balance }, welcomeImageCreditsRemaining? }` | `{ displayName, initials }` |
| zero / empty | credits `max(granted − used, 0)`, no row → 0; no wallet row → balance 0; no name → `fullName: null` | 0 | balance 0; credits 0 (the note hides itself) | "حساب والد" |
| any query parameter | 400 `invalid_request` | ignored (never forwarded) | ignored | n/a |
| no / rejected session | 401 `unauthenticated` | 401 `unauthenticated` | 401 `unauthenticated` | anonymous |
| older than 30 days / before `sessions_not_before` | 401 `session_expired` / `session_invalidated` | 401 `PARENT_SESSION_EXPIRED` + local sign-out (body unchanged) | same | anonymous, nothing signed out |
| identity provider down/slow | n/a | 503 `SESSION_CHECK_UNAVAILABLE` (body unchanged), no sign-out | same | anonymous |
| verified, not linked | 403 `identity_not_linked` | 403 `identity_not_linked` | 403 `identity_not_linked` | anonymous |
| admin, super_admin, deleted | 403 `forbidden` | 403 `forbidden` | 403 `forbidden` | anonymous |
| parent without a profile | 404 `parent_profile_not_found` | **200 `{ welcomeImageCreditsRemaining: 0 }`** (unchanged) | **400 "پروفایل والد یافت نشد."** (billing's existing answer) | "حساب والد" (unchanged) |
| database down | 503 `service_unavailable` | 503 `service_unavailable` | 503 `service_unavailable` | anonymous |
| backend down/slow/malformed, or our assertion rejected | n/a | 503 `service_unavailable`, no sign-out | same | anonymous |

All Fastify and Next responses are `Cache-Control: no-store`; both Next routes
are `force-dynamic`. Persian messages are the ones these values were served
with before.

**Deliberate contract changes:**

1. **`GET /api/candy-purchases` no longer returns `wallet` or
   `welcomeImageCreditsRemaining`.** They moved, with the same names and shapes, to
   `GET /api/parent/account-summary`. The only consumer, the billing page,
   merges the two. `ParentCandyBillingResponse` is unchanged.
2. **A balance that cannot be read is now a 503**, which shows the billing
   page's retry card. Before, a failed `candy_wallets` read was ignored and
   shown as a balance of **0**.
3. **Welcome credits: a database failure is a 503**, where it was a 500. A
   failed credits read inside the account summary still only omits the field,
   as before.
4. **Error bodies gain a stable `code`** where they had none (the 401/403
   answers). The Persian `error` strings are unchanged.
5. **The public header is anonymous for an expired or invalidated session.**
   Before, it greeted the parent until the dashboard signed them out, because
   it never checked the session lifetime. It still never signs anyone out.
6. **The header is anonymous when the backend is unavailable.** Before, it
   depended on Supabase being available instead.

### Identity

The caller comes only from `requireAuth`. None of the three backend routes
takes a parameter: any query string, including `parentProfileId`, is a 400. They read no header,
body or cookie for identity, and the Next side forwards none (`X-User-Id`,
`X-Role`, `X-Parent-Profile-Id`, a forged `X-Cartoona-Internal-Auth`,
cookies). Each read resolves the profile from `principal.userId`, and every
query is parameterised on that id. Proven on copied data with three parents
whose names, balances and credits all differ.

### Shared verification (request-local)

`lib/parent/backend-caller.ts` holds `verifyParentCaller()`, the step V0.1.45
had inside the orders loader, and `mapBackendRejection()`. The orders and
account loaders share both. A verified caller is passed explicitly to every
backend read made for the same request:

- `/api/parent/account-summary` verifies the session **once**, then reads the
  balance and the credits **in parallel**, each with its own assertion.
- The public header uses React `cache()` for the default call. The homepage
  (layout + page) therefore resolves the account **once per server render**
  instead of twice. `cache` is scoped to one render: nothing is shared across
  requests or visitors, and middleware state is never trusted.

### Removed

- `readWelcomeImageCredits` (the Supabase reader in
  `lib/credits/welcome-image-credits.ts`). Its two callers were migrated.
- The `parent_welcome_credits` and `candy_wallets` reads in `GET
  /api/candy-purchases`.
- `getParentAccountSummary(supabase)` (header: `users.role` +
  `parent_profiles.full_name` through Supabase). `toParentAccountSummary`
  keeps the display rule.
- `resolveParentRequestContext` is now used only by the order detail page.

Kept, because non-migrated code still uses them: `parent_profiles` reads in
middleware, `/complete-request` and the purchase/coupon/referral routes.

### Round trips and remaining duplicate auth

| | Before (Supabase) | After |
|---|---|---|
| creation review credits | `getUser` → [`users.role` ‖ `parent_profiles`] → `parent_welcome_credits`: 4 Supabase requests, 3 sequential stages | 1 provider request → 1 backend call → 3 local DB queries (identity, profile id, credits) |
| billing account values | inside `/api/candy-purchases`: `getUser` → `users.role` → `parent_profiles` → `parent_welcome_credits` → `candy_wallets` (then the history) | `/api/parent/account-summary` in parallel with the history: 1 provider request → 2 parallel backend calls → 3 DB queries each |
| public header | `getUser` → `users.role` → `parent_profiles`: 3 sequential; **twice** on the homepage | 1 provider request → 1 backend call → 2 DB queries (identity, profile); once per render |

**Sequential auth calls after V0.1.46, per surface:**

- **`/dashboard/billing` navigation:** middleware `getUser` (1 provider call),
  then `users.role` (Supabase). The page itself does no auth. In the browser,
  three requests run in parallel. `/api/candy-purchases` makes 1 provider call
  plus its Supabase reads, and `/api/parent/account-summary` makes 1 provider
  call plus 2 backend calls. That is **3 provider calls per billing load**
  (V0.1.45: 2). Two of them run in parallel, so the sequential depth is unchanged.
  The extra call disappears when the purchase history moves.
- **creation review (creation routes):** the layout's header lookup is 1
  provider call and 1 backend call. The client then fetches welcome credits:
  1 provider call and 1 backend call.
- **homepage / marketing pages:** 1 provider call and 1 backend call (was 2×3
  Supabase requests on the homepage).
- **`/dashboard/orders`:** unchanged from V0.1.45 (middleware + page each
  verify; 2 provider calls).

**Middleware → page hand-off: not implemented.** Middleware verifies with
Supabase (`getUser` + `users.role`) and the dashboard pages verify again.
Removing one verification would need a signed, request-scoped hand-off. That
would mean middleware minting an internal assertion that the page trusts,
bound to the request id, and middleware does not know that id today. It
would also mean moving middleware's role read off Supabase. That is a
middleware rewrite with a security boundary. It was assessed and left out:
the account surfaces gain nothing from it (billing renders on the client; the
header runs on pages without middleware).

### Verified locally (2026-10-21)

- `parent-account-cutover-db.test.ts` (opt-in, 19 tests). Data is copied from
  `supabase-source-fixture.sql` + `parent-orders-extra.sql` +
  `parent-account-extra.sql` (a third parent signed up through the real
  triggers) through the V0.1.44 copy. The chain is the stub provider (real
  `@supabase/ssr`), the real Next handlers and header loader, and a listening
  Fastify on a script-provisioned login role. Coverage:
  - Each parent's name, balance and credits equal both the copied target and the
    source.
  - The three parents are pairwise distinct on every surface.
  - Forged identity headers and query values are ignored.
  - admin, super_admin and deleted accounts get 403; unlinked gets 403
    `identity_not_linked`; a parent without a profile gets each surface's
    unchanged answer.
  - Expired and invalidated sessions get 401 with the cookies cleared (the
    header clears nothing).
  - Provider, backend, database and malformed-response outages get 503 with
    no sign-out.
  - The account summary makes exactly 1 provider call and 6 DB queries.
- **Docker** (frontend + backend + postgres, all healthy). Setup:
  - Copied data from the same three fixtures sat in a scratch database with its
    own script-provisioned login role.
  - A scratch override aimed the backend at that database and the frontend at
    the local stub provider, with a separately tagged frontend image (the stub
    also served empty `candy_packages`/`candy_purchases`, which are still
    Supabase reads).

  Results in headless Chromium:
  - **Parent C:** `/dashboard/billing` showed balance ۰ and the note
    "اعتبار رایگان ساخت تصویر: ۳".
  - **Parent A:** ۳۴۸ and no note (0 credits). Both match the copied database.
  - `/api/parent/account-summary` returned 200 `no-store`.
  - The homepage header showed each parent's copied name. One homepage render made
    **one** `GET /v1/parent/profile` (48 calls for 45 homepage loads plus the
    browser runs; it was two lookups per render before).
  - The browser made requests to `localhost:3000` only, and the pages contained
    no backend address, internal path or assertion.
  - One request id covered the Next route and both of its Fastify reads.

  Security checks on the containers:
  - The frontend had every database variable blank and no copy of the
    scratch role's password.
  - The backend had no Supabase variable.
  - The internal auth secret, assertions, subjects, names and the database password
    appeared in neither the browser bundle nor either container's logs.
  - The backend stayed published on `127.0.0.1:4000` only.

  On the first load after `compose up`, both backend reads hit the 3 s client
  bound and billing showed its retry card (503, no sign-out). The backend
  logged neither request. It did not recur in two retries, a backend restart
  (first request 110–150 ms) or a forced recreate of both containers (first
  request 143 ms).

  **Startup audit (2026-10-21).** Ten further clean cycles (`compose down`, then
  `up -d` five times, `up --build -d` twice, and three runs polling
  account-summary every 250 ms from the first frontend response until the
  backend answered) produced no `BACKEND_TIMEOUT`. They did show the expected,
  by-design window: the frontend has no `depends_on: backend`, and the backend
  waits for PostgreSQL to be healthy, so for the first seconds the frontend
  answers while the backend is not listening yet. In that window every
  backend read fails fast (4–50 ms, `BACKEND_UNAVAILABLE`, i.e. connection
  refused) and billing shows its retry card; once the backend is up the first
  request takes 80–260 ms. A 3 s timeout needs a connection that is accepted
  and then never answered, which no cycle produced. The anomaly is therefore
  recorded as a **non-reproducible startup transient**: no retry was added and
  the 3 s bound was not raised.

Warm local timings (localhost, **not production estimates**):

| Path | median | p90 |
|---|---|---|
| Fastify directly, in-process test: profile / candy-balance / welcome-credits | 3.1 / 3.7 / 4.0 ms | 3.6 / 5.3 / 5.1 ms |
| Fastify directly, Docker (host → `127.0.0.1:4000`): profile / candy-balance / welcome-credits | 3.3 / 3.3 / 3.6 ms | 4.9 / 5.7 / 5.7 ms |
| Next handler → Fastify → PostgreSQL, in-process (incl. stub provider): welcome-credits | 5.2 ms | 6.8 ms |
| same: account-summary (2 parallel reads) | 5.3 ms | 6.1 ms |
| same: public header lookup | 5.0 ms | 6.1 ms |
| Docker, real Next server: `/api/parent/welcome-credits` | 7.1 ms | 11.2 ms |
| Docker, real Next server: `/api/parent/account-summary` | 7.7 ms | 14.3 ms |
| Docker, real Next server: `/dashboard/billing` HTML (middleware + shell; data loads in the browser) | 7.1 ms | 9.6 ms |
| Docker, real Next server: `/` homepage (header lookup + CMS reads against the stub) | 14.7 ms | 29.7 ms |

Structurally the old flows were 3–5 sequential Supabase requests over the
internet per surface (and the header ran twice on the homepage). The new ones
are 1 provider request plus 1 (or 2 parallel) local backend calls of 2–3
queries each. The provider round trip is the part a localhost measurement
cannot show.

### Production status

**Not deployable**, for the same four reasons as V0.1.45: the `amr`
verification, a real `pg_dump` rehearsal, the backend/PostgreSQL deployment,
and the storage migration. In addition, the read/write split above
(balance and credits read from PostgreSQL while purchases and requests write
to Supabase) is a **fifth blocker**: do NOT deploy before the writes move or a
final copy under a write freeze closes it.

## V0.1.47: write security foundation

### Write-path audit (before any change)

Every authenticated write in the app, all on Supabase. "CSRF" is the
browser → Next exposure: all rely on the `SameSite=Lax` session cookie;
"Origin" means the route also validates `Origin` itself.

| Write | Route | Auth | Supabase DB/RPC | Idempotent | Money | Storage | Retry sensitivity | First-cutover fit |
|---|---|---|---|---|---|---|---|---|
| parent display name | none (settings card is a TODO) | n/a | n/a | n/a | no | no | n/a | **preferred, but does not exist** |
| consent grant | POST `/api/parent-consent` | getUser + `users.role` + session lifetime | `parent_profiles` read/insert/update (`ensureParentProfile`) | yes (monotonic) | no | no | low | **no**: `consent_granted` is read from Supabase by middleware, `/login` (browser client), `/complete-request`, `POST /api/requests` and the dev route; a PG-only write makes middleware loop back to `/parent-consent` |
| signup completion | POST `/api/parent/complete-signup` | getUser + role | `parent_profiles` insert (`ensureParentProfile`), triggers create wallet/credits/referral code | yes | indirect (wallet, credits) | no | low | no: creates the profile the provider just made a user for; needs identity linking (signup move) |
| password change | POST `/api/parent/password` | getUser, Origin | Supabase Auth `updateUser` | n/a | no | no | — | **never**: provider-owned credential |
| logout | POST `/api/logout` | cookie | Supabase Auth `signOut` | yes | no | no | — | never: provider session |
| referral bind | POST `/api/referrals/bind` | getUser + role, Origin; DB-side rate limit in the RPC | RPC `bind_current_parent_referral_code` | yes (one binding) | **yes** (referral rewards) | no | medium | no: reward-bearing |
| coupon validate | POST `/api/coupons/validate` | getUser + role | RPC `validate_coupon_for_purchase_trusted` (admin client) | read-only | quote only | no | none | not a write |
| candy purchase create | POST `/api/candy-purchases` | getUser + role, rate limit | `candy_purchases`, `payment_attempts`, `coupons` | no | **yes** | no | high | excluded |
| purchase coupon apply | POST `/api/candy-purchases/[id]/coupon` | same | RPC `apply_coupon_to_purchase_trusted` | per purchase | **yes** | no | high | excluded |
| purchase completion | POST `/api/candy-purchases/[id]/complete` | same | RPC `complete_candy_purchase_trusted`, credits wallet | guarded | **yes** | no | high | excluded |
| request submission | POST `/api/requests` | getUser + role + consent | RPC `create_parent_request_trusted`; uploads | submission key | **yes** (candy/credit debit) | **yes** | high | excluded |
| final-media link | POST `/api/parent/orders/[orderId]/final-media` | getUser | read + signed URL | read-only | no | **yes** | none | not a DB write |
| admin order status | PATCH `/api/admin/requests/[id]/status` | admin | RPC `update_order_status_trusted` | `expectedUpdatedAt` guard | indirect | no | medium | excluded (fulfilment) |
| admin final media | POST/PATCH `/api/admin/requests/[id]/final-media[/…]` | admin | RPCs `record_` / `approve_` / `supersede_final_media_trusted` | no | no | **yes** | high | excluded (media) |
| admin coupons | POST/PATCH `/api/admin/coupons[/id]` | admin | `coupons` (`expected_updated_at`) | optimistic | **yes** | no | medium | excluded |
| admin referral settings | PATCH `/api/admin/referrals/settings` | admin, Origin | RPC `update_admin_referral_program_settings` | `expected_updated_at` guard | **yes** (reward size) | no | low | excluded |
| homepage CMS | PUT `/api/admin/homepage`, `/hero-layout`; POST/DELETE `/media/[slot]` | admin | `homepage_*` (+ trusted RPC) | yes | no | media: **yes** | low | no: its reads are still Supabase, so a PG-only write would not show |
| examples CMS | POST/PATCH/DELETE `/api/admin/examples[/…]`, PUT `/media`, PATCH `/publish` | admin | `examples` | partly | no | **yes** | medium | excluded (media, destructive) |
| dev auth | POST `/api/dev/parent-auth` | dev only | profile insert | — | no | no | — | never (dev tooling) |

**Decision (with the product owner, 2026-10-21): foundation only.** No
existing write can move alone without either touching money/media or
creating a functional read/write split worse than drift (consent). V0.1.47
therefore builds the complete write chain and proves it with a backend-only
`PATCH /v1/parent/profile` (the display-name update the product will need,
with no UI yet), and cuts over **no** Next.js route. Nothing user-facing was
added.

### What was built

| Piece | Where |
|---|---|
| v3 write assertion (nonce + body digest), v2 limited to GET/HEAD | `lib/identity/assertion.ts` |
| nonce table + `consume_internal_write_nonce()` (EXECUTE only) | `database/migrations/0012_internal_write_nonces.sql`, `lib/repositories/write-nonces.ts` |
| `requireWriteAuth(deps, ...roles)`: v3, digest over received bytes, identity, session, role, nonce last | `backend/src/plugins/auth.ts`; raw-body JSON parser in `backend/src/app.ts` |
| `backendWriteJson` (POST/PUT/PATCH/DELETE; one attempt; `outcomeUnknown`) | `lib/backend/client.ts`, `lib/backend/errors.ts` |
| proof write `PATCH /v1/parent/profile` + name rules | `backend/src/routes/parent-account.ts`, `lib/parent/profile-name.ts`, `lib/repositories/parent-profiles.ts` |
| column-level grant | `database/migrations/0013_parent_profile_name_update_grant.sql` |
| data-copy pin re-audited to 0001–0013 | `scripts/db/data-copy/mapping.ts`, [DATA_MIGRATION.md](DATA_MIGRATION.md) |

Design, threat model, order of checks, replay vs retry, uncertain timeouts
and the CSRF boundary: [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md#write-security-v0147).

### Verified locally (2026-10-21)

- **Real PostgreSQL** (`write-security-db.test.ts`, 38 tests, as a
  script-provisioned login role):
  - **Nonce function:** first use true and reuse false. Over 10 rounds of
    20 truly concurrent connections, each round produced exactly one true.
  - **Held race:** with the holder uncommitted, 5 waiters were observed in
    `pg_stat_activity` on a Lock wait and all got false when the holder
    committed. When the holder rolled back, exactly one waiter won.
  - **Bounds and purge:** an expiry out of range is 22023. Rows expired for
    more than 10 minutes are purged; recent ones stay.
  - **Privileges:** the role cannot SELECT, INSERT, UPDATE, DELETE or
    TRUNCATE the nonce table. It cannot update consent, `user_id` or
    `referral_code`, and cannot insert or delete profiles. It can UPDATE
    exactly `full_name` and `updated_at`.
  - **Route over HTTP:** 25 concurrent requests carrying one assertion gave
    exactly one 200, 24 × 409 and one UPDATE. Admin, super_admin and deleted
    accounts got 403; `sessions_not_before` gave 401; an unlinked identity
    403; a parent without a profile 404. Forged `X-User-Id`, `X-Role`,
    `X-Parent-Profile-Id` and body ids changed nothing. A tampered body, a
    rebound path or method, v2 used for a write, or no assertion all gave
    401 with no nonce stored. A v3 assertion on GET was 401.
  - **Uncertain timeout:** the response was delayed 1.5 s after commit. The
    Next client timed out in about 250 ms after one fetch (`timeout`,
    `outcomeUnknown`). The row had changed exactly once, resending that
    request gave 409, and a new user retry with the same value gave 200
    with the same end state.
  - **Read-after-write:** the new name came back through Fastify
    `GET /v1/parent/profile` and through the Next public header (stub
    provider → Fastify → PostgreSQL).
- **Docker** (fresh images built with empty `NEXT_PUBLIC_*` values, backend on
  a scratch database migrated to 0013, frontend Supabase variables blanked,
  no provider contacted):
  - **Health:** all three services were healthy.
  - **Write sequence:** a host → `127.0.0.1:4000` signed PATCH returned 200
    and was read back. Replaying it gave 409. Twenty concurrent requests with
    one assertion gave 1 × 200 and 19 × 409. A user retry gave 200.
  - **Refusals:** a tampered body, v2 used for a write, and no assertion gave
    401; admin gave 403; a body `parentProfileId` gave 400. The other parent
    was unchanged.
  - **Isolation:** the frontend had every database variable empty and the
    backend no Supabase variable. The backend ran as the scratch login role
    and was published on loopback only.
  - **Leaks:** the secret, the database password, the assertion payload,
    its signature and its nonce appeared in neither the browser bundle nor
    any container log.
  - **Role privileges:** UPDATE on `full_name` and `updated_at` only, nothing
    on the nonce table, and EXECUTE on the function.
- The main local `cartoona` database was not touched (still at 0011). Run
  `scripts/db/migrate-local.sh` against it before using the Docker backend
  with writes.

Local timings (localhost, **not production estimates**):

| Path | median | p90 |
|---|---|---|
| Fastify PATCH direct (v3 verify, identity, nonce, UPDATE), test process | 4.6 ms | 5.7 ms |
| Next client → Fastify → PostgreSQL write, test process | 5.0 ms | 6.6 ms |
| nonce consumption alone (one function call) | 0.8 ms | 1.4 ms |
| write then read-after-write (`GET /v1/parent/profile`) | 8.6 ms | 10.7 ms |
| Docker: host → Fastify PATCH | 4.8 ms | 6.3 ms |

The nonce adds one statement (under 1 ms locally) to every write. The
sequential depth of a write is: provider session check (Next), then one
backend call doing identity → nonce → write.

### Production status

**Not deployable**, unchanged from V0.1.46: the `amr` verification, a real
`pg_dump` rehearsal, the backend/PostgreSQL deployment, the storage migration,
and the read/write split (balance, credits and orders read from PostgreSQL
while purchases and requests write to Supabase). V0.1.47 does not reduce that
split: its one write has no product caller. **Do NOT deploy this branch**
before those writes move or a final copy under a write freeze closes it.

## Next

V0.1.48 (write paths cutover) can now build on the foundation. Before the
first BFF write:

- a shared CSRF check for migrated write routes (Origin / `Sec-Fetch-Site`
  plus a required JSON content type), see
  [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md#csrf-browser--next);
- the "could not confirm" UX for `outcomeUnknown`;
- for each write, its READS moved in the same release (consent is the
  example: its middleware, login, complete-request and requests-gate reads);
- EXECUTE grants on the `*_trusted` functions each write needs, one
  migration per cutover;
- a rollback / reverse-sync plan for the first write that lands only in
  PostgreSQL.

The purchase history, request submission and purchase completion are the
writes that close the V0.1.46 read/write split.
