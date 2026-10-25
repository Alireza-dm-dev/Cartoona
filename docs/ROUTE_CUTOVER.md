# Route cutovers

Routes served through the Fastify backend instead of Supabase:

| Release | Route | Kind |
|---|---|---|
| V0.1.41 | `GET /api/creation-pricing` | public read |
| V0.1.45 | `GET /api/parent/orders` + the `/dashboard/orders` first page | **authenticated** read, the parent orders **LIST** only ([below](#v0145-parent-orders-list)) |
| V0.1.46 | `GET /api/parent/welcome-credits`, `GET /api/parent/account-summary` (new), the public header's parent name | **authenticated** reads: welcome credits, candy balance, profile name ([below](#v0146-parent-account-reads)) |
| V0.1.47 | none (backend-only `PATCH /v1/parent/profile`) | write-security foundation; **no Next.js route cut over** ([below](#v0147-write-security-foundation)) |
| V0.1.51 | `GET`/`POST /api/candy-purchases`, `/api/candy-packages`, `/api/coupons/validate`, `/api/candy-purchases/[id]/coupon`, new `/pay`, `/api/payments/webhooks/[provider]`, `/api/payments/return/[provider]`, `/api/admin/coupons[/id]` + pages; `/complete` removed | **purchases, payments, coupons**: one wallet database ([below](#v0151-candy-purchases-and-payments-on-postgresql)) |
| V0.1.50 | `POST /api/requests` (+ new `GET /api/requests/by-submission-key`) | **the first financial write**: request submission as one PostgreSQL transaction ([below](#v0150-transactional-parent-request-submission)) |
| V0.1.48 | `POST`/`GET /api/parent-consent`; the consent gates of `/parent-consent`, `/complete-request`, `POST /api/requests`, `/login` and the dev auth route | **the first browser-facing WRITE** (consent) + every consent read; shared CSRF guard ([below](#v0148-parent-consent-read--write)) |

### Migration status

| Surface | Data | Status |
|---|---|---|
| creation pricing | `creation_pricing` | **PostgreSQL** (V0.1.41) |
| parent orders list (page 1 + load more) | `orders`, `order_status_history` | **PostgreSQL** (V0.1.45) |
| parent profile name (public header) | `parent_profiles.full_name` | **PostgreSQL** (V0.1.46) |
| candy balance (billing) | `candy_wallets.balance` | **PostgreSQL** (V0.1.46) |
| welcome image credits (billing, creation review) | `parent_welcome_credits` | **PostgreSQL** (V0.1.46) |
| billing purchase history | `candy_purchases`, `payment_attempts`, `coupon_redemptions`, `coupons` | **PostgreSQL** (V0.1.51) |
| candy package catalog | `candy_packages` | **PostgreSQL** (V0.1.51) |
| purchase creation, coupons, payment attempts, provider-verified credit | 0017 functions | **PostgreSQL** (V0.1.51) |
| consent read (`/parent-consent`, `/complete-request`, `/login`, dev route) | `parent_profiles.consent_granted[_at]` | **PostgreSQL** (V0.1.48); middleware no longer checks consent |
| consent write (`POST /api/parent-consent`) | `record_parent_consent_trusted` | **PostgreSQL** (V0.1.48), CSRF guard + v3 |
| request submission: consent gate | `parent_profiles.consent_granted` | **PostgreSQL** (V0.1.48) |
| request submission: creation, welcome-credit/candy spend, ledger | `create_parent_request_trusted` | **PostgreSQL** (V0.1.50), one transaction; uploads stay Supabase Storage |
| referral summary | RPC `get_current_parent_referral_summary` | Supabase (old path) |
| order detail, final media, gallery | orders + Storage | Supabase (old path) |
| parent display-name write | `parent_profiles.full_name` | **PostgreSQL, backend only** (V0.1.47): `PATCH /v1/parent/profile`; no Next route or UI calls it |
| every other product write (request creation, candy purchases, coupons, referrals, profile creation, password, order/media, admin) | | Supabase (old path) |
| identity / session | Supabase Auth | Supabase Auth (provider; by design until replaced) |

Everything marked "old path" still runs on Supabase. A static guard
(`route-cutover-static.test.ts`) fails if any other route or page reaches the
backend, and lists the backend's exact routes; `write-security-static.test.ts`
fails if any Next write handler other than `POST /api/parent-consent` calls
the backend; `consent-cutover-static.test.ts` fails on any runtime Supabase
consent access or a migrated money/media/Storage/request write.

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
| request submission | POST `/api/requests` | getUser + role + consent | RPC `create_parent_request_trusted`; uploads | submission key | **yes** (candy/credit debit) | **yes** | high | **migrated in V0.1.50** (PostgreSQL function; uploads stay Storage) |
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

## V0.1.48: parent consent read + write

The whole consent domain moves from Supabase's database to PostgreSQL in one
release: the write and **every** read that gates on it. It is the first
browser-facing write on the new architecture, and it comes with the shared
browser → Next CSRF guard
([AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md#csrf-browser--next)).

### Consent audit (before any change)

Every runtime use of `consent_granted` / `consent_granted_at` / the consent
flow on `1a39211`:

| File | Read / write | Source | Auth checks | When not consented | When unavailable |
|---|---|---|---|---|---|
| `middleware.ts` step 6 (`/complete-request` only) | read | Supabase `parent_profiles` (cookie client, PostgREST) | `getUser`, `users.role`, 30-day lifetime | redirect `/parent-consent` | read error → redirect `/parent-consent` |
| `app/(auth)/complete-request/page.tsx` | read | Supabase | `getUser`, role (admins → `/admin`), lifetime | redirect `/parent-consent` | redirect `/parent-consent` |
| `app/(auth)/login/page.tsx` (SMS verify + password login) | read | Supabase from the **browser** client | the session just created | `resolveSuccessfulLoginDestination(from, false)` → `/parent-consent` (unless `from` names a non-dashboard parent path) | error ignored → treated as not consented |
| `app/api/dev/parent-auth/route.ts` (magic-link + password sessions) | read | Supabase (the new session's client) | role parent | `next: "/parent-consent"` | treated as not consented |
| `app/api/requests/route.ts` | read | Supabase | `getUser`, rate limit, role, lifetime | 403 (no profile / not consented) | error ignored → 403 "profile not found" |
| Supabase RPC `create_parent_request_trusted` (called by the route above) | read | Supabase DB, inside the RPC | service_role only | `request_consent_required` → 403 | — |
| `app/api/parent-consent/route.ts` + `lib/parent/ensure-parent-profile.ts` (`grant`) | **write** (update, or INSERT a consented profile if none) | Supabase user client (RLS insert-own, column grants) | `getUser`, role, lifetime; no CSRF check (SameSite only) | — | 500 "Failed to record consent" |
| `app/api/parent/complete-signup/route.ts` (`ensureParentProfile`, `preserve`) | write (`consent_granted: false` on insert) | Supabase | `getUser`, role | — | 500 |
| `app/api/dev/parent-auth/route.ts` signup | write (`consent_granted: false`) | Supabase admin client | dev only | — | 500 |
| `app/(auth)/parent-consent/page.tsx` | none (client page, POST only) | — | middleware: signed in, role (admins → `/admin`), lifetime | the form, always (also for a consented parent) | — |
| `components/…` (orders/gallery "no profile" states, signup, draft card, creation review) | none: links and copy | — | — | — | — |
| `lib/requests/request-rpc-error.ts`, `lib/admin/requests/queries.ts`, `types/database.ts` | none (message map, a `false` placeholder, generated types) | — | — | — | — |

The RPC row is the one that is easy to miss: moving every Next read would
still have left Supabase's own copy of the column gating request creation. A
parent who consents after the cutover would pass the new gate and then be
refused by the RPC.

### Consent semantics (unchanged except where noted)

- **Owner:** `parent_profiles` (one row per user, `user_id` UNIQUE).
- **Columns:** `consent_granted boolean NOT NULL DEFAULT false`,
  `consent_granted_at timestamptz NULL`. Nothing else.
- **One-way.** Nothing in the product revokes consent: the route only accepts
  `{ consentGranted: true }`, and the old helper "only ever moved [it]
  forward". V0.1.48 makes this a database rule (`record_parent_consent_trusted`
  can only set `false → true`).
- **Time:** stamped on the first grant; a repeated grant keeps it. (The old
  route answered with a *fresh* `new Date()` on every call even when nothing
  changed; it now answers with the stored time.)
- **New / existing profile:** created un-consented (column defaults).
- **Missing profile:** every gate treats it as not consented (unchanged). The
  old write **created** a consented profile; the new write does not
  (403 `no_parent_profile`, decided with the product owner): the app role has
  no INSERT, and an insert would also fire the wallet and welcome-credit
  triggers. See blocker 6 below.
- **What requires consent:** `/complete-request` and `POST /api/requests`.
  The dashboard does not (its pages show their own "no profile" states).

### What changed

| Piece | Where |
|---|---|
| `getParentConsentState`, `recordParentConsent` | `lib/repositories/parent-profiles.ts` |
| `record_parent_consent_trusted(uuid)` + EXECUTE grant | `database/migrations/0014_parent_consent_write.sql` |
| `GET` / `POST /v1/parent/consent` | `backend/src/routes/parent-consent.ts` |
| shared CSRF guard | `lib/security/csrf.ts` |
| the one consent loader (read, write, outcomeUnknown recovery) | `lib/parent/consent/backend-consent.ts`, `consent-response.ts`, `consent-client.ts` (browser) |
| Next route `POST` (cut over) + `GET` (new) | `app/api/parent-consent/route.ts` |
| `/parent-consent` (server page + client form) | `app/(auth)/parent-consent/page.tsx`, `parent-consent-form.tsx` |
| gates moved | `app/(auth)/complete-request/page.tsx`, `app/api/requests/route.ts`, `app/(auth)/login/page.tsx`, `app/api/dev/parent-auth/route.ts`; middleware step removed |
| no consent columns written to Supabase on profile creation | `lib/parent/ensure-parent-profile.ts`, `complete-signup`, dev signup |
| Supabase RPC without its consent clause | `supabase/migrations/20261022100000_request_rpc_consent_gate_moved.sql` |
| `CARTOONA_APP_ORIGIN` | `compose.yml`, `.env.example`, `.env.docker.example` |

### Middleware / gating decision

Middleware compiles to the **Edge** runtime (verified in the build's
middleware manifest; Next 16 keeps Edge for the deprecated `middleware`
convention, only `proxy.ts` is Node-only). Reading consent through the
backend needs a signed assertion (`node:crypto`, the internal secret), and
middleware must not connect to PostgreSQL. Options considered:

| Option | Verdict |
|---|---|
| middleware calls Fastify | rejected: the signer and secret would have to run in Edge; a backend round trip on every protected navigation |
| migrate to `proxy.ts` (Node) and call Fastify there | rejected for V0.1.48: a framework migration of the whole auth middleware, out of scope |
| **remove the step; the Node-runtime page is the gate** | **chosen**: the step only ever covered `/complete-request`, whose page already re-checked consent. Redirects are preserved (not consented → `/parent-consent`) |

Middleware keeps everything else (signed in, role, admins → `/admin`, 30-day
lifetime).

### Temporary mixed request flow (V0.1.48, by design)

```
POST /api/requests
  Supabase Auth (getUser)                        identity provider
  rate limit, Supabase users.role, lifetime     Supabase (unchanged)
  CONSENT GATE  ->  loadParentConsent()          PostgreSQL (V0.1.48)
  Supabase parent_profiles.id, Storage upload,
  create_parent_request_trusted RPC, debit       Supabase (unchanged; NOT migrated)
```

Request submission is **not** migrated. Only its consent decision moved, and
Supabase's RPC no longer second-guesses it with the stale column
(`20261022100000`: the function recreated with exactly the consent clause
removed; a static test diffs it against `20260926100000`). The plain
PostgreSQL copy of the function (0005) keeps its consent check: there the
column is authoritative. A consent outage is a 503 `consent_unavailable`,
never "consent required".

### outcomeUnknown and replay

- The BFF sends the write once. If the answer is lost after it may have been
  received (timeout, reset, 5xx, unreadable 2xx, or 409 meaning its own nonce
  was already consumed), it re-reads consent with a new READ assertion:
  granted → 200 (logged `CONSENT_CONFIRMED_AFTER_UNCERTAIN_WRITE`), otherwise 503
  `consent_outcome_unknown`.
- The page shows **«نتوانستیم تأیید کنیم که رضایت شما ثبت شده است یا نه. لطفاً
  وضعیت را بررسی کنید و در صورت نیاز دوباره تلاش کنید.»** and a "check status"
  button (GET `/api/parent-consent`): granted → continue; not granted → the
  parent may submit again (new request → new nonce; safe, one-way grant, first
  time kept); unknown → stays uncertain. A browser → Next network failure is
  treated the same way. Never "failed", never a sign-out, never an automatic
  re-send.
- Replaying the same v3 assertion → 409 `replayed_request`, no second write.

### Rollback boundary: the first PostgreSQL-only write

Until V0.1.48 every cutover was read-only: rolling back meant redeploying the
previous release. Consent changes made after this cutover exist **only** in
PostgreSQL; Supabase's column freezes at its cutover value. Rolling the app
back to a release that reads consent from Supabase would show those parents
as **not consented** (they would be sent to `/parent-consent` and could not
submit requests), and the old RPC (consent clause back) would refuse them.

Plan (nothing is deployed; production is blocked anyway):

1. **Preferred: roll forward, keep consent on PostgreSQL.** A defect in
   V0.1.48 is fixed with a new release; consent reads stay on PostgreSQL. No
   data moves.
2. **If the app must go back to a Supabase-consent release**, first push
   PostgreSQL's consent forward into Supabase, then deploy the old app, then
   (only then) re-apply the 20260926100000 RPC definition. One statement per
   direction is enough, because consent is one-way:

   ```sql
   -- run with a service-role connection against Supabase, values exported from PostgreSQL:
   --   COPY (SELECT user_id, consent_granted_at FROM public.parent_profiles
   --         WHERE consent_granted) TO STDOUT
   UPDATE public.parent_profiles s
   SET consent_granted = true, consent_granted_at = x.consent_granted_at
   FROM (VALUES (...)) AS x(user_id, consent_granted_at)
   WHERE s.user_id = x.user_id::uuid AND s.consent_granted = false;
   ```

   It only ever sets `false → true` (no revocation exists), so re-running it
   is harmless. Profiles that exist only in PostgreSQL cannot exist (profile
   creation is still Supabase-only).
3. **Order matters on the way forward too:** apply
   `20261022100000_request_rpc_consent_gate_moved.sql` to Supabase together
   with (or before) the V0.1.48 app. Applied first it is harmless: the old app
   checks consent before calling the RPC.

No reverse-sync tool is built in V0.1.48; step 2 is a one-time operator
action, to be scripted when a production rollout is scheduled.

### Docker startup window

The frontend still has no `depends_on: backend` (deliberate since V0.1.41:
public pages must not depend on the backend). Re-checked for a real browser
write: for the few seconds the backend is not ready, `/parent-consent` shows
its retry notice, and a submit that was already on screen gets 503
`consent_outcome_unknown` → "could not confirm" + "check status". No false
success, no sign-out, no replay. Proven in the browser (below). No compose
change beyond `CARTOONA_APP_ORIGIN`.

### Verified locally (2026-10-22)

- **Real PostgreSQL** (`consent-cutover-db.test.ts`, 49 tests: Supabase-shaped
  source with un-consented parents → copy → 0001–0014 target → listening
  Fastify as a script-provisioned login role → the real Next route handlers,
  pages and gates with the stub provider):
  - **Copy:** every copied `(consent_granted, consent_granted_at)` equals the
    source; false/NULL stays false/NULL; a microsecond grant time is exact.
  - **Read-after-write through every gate:** before, parent D read
    `{consentGranted:false}`, page `form`, `/complete-request` →
    `/parent-consent`, request gate 403, `/login` → `/parent-consent`. After
    one browser-shaped POST (CSRF passed, v3, PostgreSQL changed, stored time
    returned): `true`, page forwards, `/complete-request` renders, request gate
    passed (400 for the deliberately missing draft, not 403), `/login` →
    `/dashboard/orders`. Only D's row changed.
  - **No loop:** complete-request → parent-consent → complete-request →
    parent-consent = render, forward, render, forward.
  - **outcomeUnknown:** answer delayed after commit → Next timed out, re-read,
    200 success, exactly one write. Commit delayed past the timeout → 503
    `consent_outcome_unknown` (Persian "could not confirm"), no sign-out; the
    late commit then read back as granted; resending the captured signed
    request → 409, still one write; a user retry → 200, same stored time.
  - **Replay:** 20 concurrent copies of one assertion → 1 × 200, 19 × 409.
  - **Isolation:** forged `X-User-Id` / `X-Role` / `X-Parent-Profile-Id` /
    assertion header, ids in the body (422), a hostile query, wrong-path,
    tampered body, v2 on the write → no other parent changed.
  - **Auth cases:** admin, super_admin, deleted → 403 `forbidden`; unlinked →
    403 `identity_not_linked`; no profile → GET false, POST 403
    `no_parent_profile`, nothing created; 31-day session → 401 + sign-out;
    `sessions_not_before` → 401 + sign-out; provider down → 503, no sign-out.
  - **Outage:** database down → GET 503 (not false), POST 503
    `consent_outcome_unknown`, `/parent-consent` retry notice,
    `/complete-request` retry alert, request gate 503 `consent_unavailable`,
    no sign-out. Backend unreachable (the Docker startup window) → same.
  - **Privileges:** the role can read consent, execute the function and
    consume a nonce; it cannot UPDATE `consent_granted`, `consent_granted_at`,
    `referral_code`, `user_id`, `created_at`, INSERT/DELETE profiles, touch the
    nonce table, or execute `complete_candy_purchase_trusted`,
    `create_parent_request_trusted`, `record_final_media_trusted` (all 42501).
    The function returns nothing (and changes nothing) for admin, deleted,
    unlinked and profile-less users, keeps an existing grant time, rejects
    NULL (22023), and 10 concurrent grants wrote one time.
- **Unit / in-process** (no database): `csrf.test.ts` (45: the full CSRF
  matrix), `backend-parent-consent.test.ts` (31: Fastify routes, versions,
  body, roles, replay, outages), `parent-consent-route.test.ts` (45: CSRF
  before auth, body rules, outcome mapping, outcomeUnknown recovery, GET),
  `consent-cutover-static.test.ts` (27 guards).
- **Docker + headless Chromium** (proof-tagged images built with the stub
  provider URL; backend on a scratch copy as a scratch login role; stub
  Supabase Auth on the host; nothing hosted contacted), 27/27 checks:
  - **Hostile writes first:** a page on another origin (`127.0.0.1:8099`)
    sent a `no-cors` fetch and a `text/plain` form post → 415, 415; a JSON
    POST carrying the parent's cookie with `Origin: https://evil.example`
    and a forged `X-Forwarded-Host` → 403; `Sec-Fetch-Site: cross-site` →
    403. PostgreSQL unchanged.
  - **Real flow:** the parent saw the consent form, ticked it, submitted
    (the browser itself sent `Origin: http://localhost:3000`,
    `Sec-Fetch-Site: same-origin`, `application/json`) → 200 → landed on
    `/dashboard/orders`; PostgreSQL consented.
  - **No loop:** `/parent-consent` → `/dashboard/orders` (forwarded),
    `/complete-request` renders, `/dashboard` → `/dashboard/orders`, twice
    over. The `/login` source (`GET /api/parent-consent`) said granted. A
    second grant kept the first time.
  - **Browser contacted Next only:** 232 requests, all `localhost:3000`
    (no `:4000`, no provider). **No leak:** the 232 responses contained no
    backend URL, `/v1/` path, assertion header, secret, database password,
    role or consent column name.
  - **Replay** against the Docker backend: same signed write twice → 200, 409.
  - **Startup window / outage in the browser** (parent E): form loaded, then
    the backend was stopped; submit → 503 `consent_outcome_unknown`, the
    Persian "could not confirm" text and a "check status" button, still on
    the page, session cookie kept, nothing written. Backend started → "check
    status" → "not saved yet, you may confirm again" → user retry → 200 →
    portal; PostgreSQL consented.
  - **Containers:** frontend had every database variable empty; backend had
    no Supabase variable and ran as the scratch login role; the secret, the
    database password, assertion tokens and nonces appeared in no container
    log.
- **Supabase RPC migration** applied cleanly on top of the full historical
  chain in every source build (DB suites and the proof); its function body
  differs from 20260926100000 only by the consent clause (static diff test).
- The main local `cartoona` database was migrated 0011 → 0014
  (`migrate-local.sh`: 3 applied). Proof databases, roles, containers and
  images were removed afterwards.

Local timings (**not production estimates**):

| Path | test process (median / p90) | Docker, host → containers (median / p90) |
|---|---|---|
| consent GET, Fastify direct (v2, identity + SELECT) | 2.9 / 5.0 ms | 3.5 / 6.1 ms |
| consent GET, Next → provider → Fastify → PostgreSQL | 5.0 / 7.3 ms | 6.9 / 9.5 ms |
| consent POST, Fastify direct (v3, identity, nonce, function) | 4.0 / 6.1 ms | 4.3 / 5.9 ms |
| consent POST through Next (CSRF, provider, v3 → Fastify → PostgreSQL) | 6.7 / 12.7 ms | 8.5 / 14.1 ms |
| POST through Next + verification GET through Next | 11.2 / 19.2 ms | 16.0 / 21.4 ms |

(The test-process column is from an isolated run; under the full parallel
suite the same numbers were roughly 2× higher.) Sequential depth of one
browser consent write: CSRF check (no I/O) → provider session verification
(1 round trip; 2 if the access token must be refreshed) → one backend call:
identity SELECT → nonce function → consent function (3 sequential
statements). The verification read after an uncertain outcome adds one
backend call (identity SELECT → consent SELECT).

### Production status

**Not deployable.** Unchanged blockers: the real `amr` claim shape, a real
`pg_dump` rehearsal, backend/PostgreSQL deployment, the storage migration, and
the V0.1.46 read/write split (balance, credits, orders read PostgreSQL while
purchases and requests write Supabase). V0.1.48 closes the split **for consent
only**. New for deployment: `CARTOONA_APP_ORIGIN` must be set (production
fails closed without it), and the Supabase migration `20261022100000` must
ship with the app. Blocker 6 (accounts created after the copy have no
PostgreSQL identity/profile) now also means such parents cannot grant consent.

## V0.1.49: PostgreSQL identity provisioning + shared CSRF adoption

Closes blocker 6: an account created in Supabase AFTER the V0.1.44 copy had
no PostgreSQL user, identity or profile, so every migrated route (consent,
account reads, orders) answered `identity_not_linked`. Supabase Auth itself
is NOT replaced. No financial, request, media or order write moved.

### Account-creation audit (before any change)

| step | where | writes | transactional with |
|---|---|---|---|
| phone OTP signup | browser `signInWithOtp({ phone })` (`shouldCreateUser` default) → `verifyOtp` | Supabase Auth: `auth.users` (phone, no email, **no password**), session | - |
| app user | Supabase trigger `on_auth_user_created` → `handle_new_user()` | `public.users(id = auth uid, email = NEW.email (NULL for phone), role 'parent')` | the `auth.users` insert (inside Supabase Auth) |
| parent profile | `POST /api/parent/complete-signup` → `ensureParentProfile` (user client, RLS insert-own) | `parent_profiles(user_id)`, full_name NULL, consent default false | its own statement |
| referral code | Supabase `BEFORE INSERT` trigger `assign_parent_referral_code` | `parent_profiles.referral_code` (server-generated; any supplied value ignored) | the profile insert |
| wallet | `AFTER INSERT` trigger `ensure_parent_candy_wallet` | `candy_wallets(parent_id, 0)` `ON CONFLICT DO NOTHING` | the profile insert |
| welcome credits | `AFTER INSERT` trigger `grant_parent_welcome_image_credits` | `parent_welcome_credits(3, 0)` `ON CONFLICT DO NOTHING` (parent, not deleted) | the profile insert |
| dev signup | `/api/dev/parent-auth` `signup_verify_code` | admin `createUser` (dev email, no password) → trigger `public.users`; admin profile insert (same triggers); magic-link session | none; profile failure → best-effort `deleteUser` |
| password | never at signup; later `POST /api/parent/password` → `supabase.auth.updateUser` | Supabase Auth only | - |
| role | always `parent` (trigger); admins are promoted by hand | - | - |
| referral binding | later, `POST /api/referrals/bind` → Supabase RPC | - | - |
| auth callback | none (OTP and magic link need no redirect callback) | - | - |

Retries: `ensureParentProfile` is idempotent (read, insert, a 23505 re-read).
Auth succeeded + profile failed: the auth user and `public.users` exist, no
profile; the OTP is consumed; login works but (since V0.1.48) consent showed
"profile not found". All of this is Supabase-only; nothing reached PostgreSQL.

### Design

One canonical operation, one transaction: `provision_supabase_parent_identity(subject)`
(migration 0015) behind `POST /v1/auth/provision` (`requireProvisioningAuth`),
called by the Next bootstrap `POST /api/parent/account-setup`. Semantics,
conflict table, outcomes and privilege: [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md#identity-mapping-and-bootstrap),
[POSTGRES_DATA_ACCESS.md](POSTGRES_DATA_ACCESS.md). It relies on the
existing profile triggers (the same ones that made every copied row) instead
of re-implementing wallet / credits / referral code.

Where it runs, and why there: one explicit bootstrap after Supabase sign-in,
before any migrated parent page - `/signup` (after the code, and after the
Supabase-side complete-signup, which stays because requests and purchases
still write to Supabase), `/login` (every successful sign-in: one extra
round trip, ~6 ms locally for an existing account), and the retry card on
`/parent-consent`. Rejected alternatives: provisioning inside GET reads
(hidden writes on reads, every read would need a write assertion) and inside
middleware (Edge runtime cannot sign). Migrated routes keep failing safely
without it (403 `identity_not_linked`, the setup card).

`ensureParentProfile` is NOT replaced: post-cutover users therefore have a
Supabase profile AND a PostgreSQL profile with different ids, referral codes
and wallets (blocker 5, the read/write split; see "Next").

### Shared CSRF adoption

| route | method | old check | class | now |
|---|---|---|---|---|
| `/api/parent/password` | POST | `startsWith("application/json")`; Origin optional (missing = allowed), any localhost port, `NEXT_PUBLIC_SITE_URL` | A: same-origin browser `fetch`, session cookie | `rejectUnsafeBrowserWrite` first |
| `/api/referrals/bind` | POST | same | A | same |
| `/api/admin/referrals/settings` | PATCH | same (after the length check) | A: admin browser `fetch` | same |
| `/api/parent/account-setup` (new) | POST | - | A | same |

No class B route: all four are cookie-authenticated browser writes; none is
server-to-server. Preserved: 415 / 403 messages (identical Persian text, now
with a `code`), JSON handling, size limits, role checks, Supabase Auth for
the password (no password reaches Fastify or PostgreSQL; the route logs
nothing), referral writes on Supabase. Newly refused: missing Origin, any
localhost port other than the configured ones, `Sec-Fetch-Site` other than
same-origin, `application/json` with parameters other than utf-8 charset;
production without `CARTOONA_APP_ORIGIN` → 503.

`CARTOONA_APP_ORIGIN` rules (tests/unit/csrf-config.test.ts): production +
unset/empty → every guarded write 503; outside production + unset → exactly
`http://localhost:3000` and `http://127.0.0.1:3000`; an explicit value
replaces the defaults; comma-separated, each entry trimmed; **no
normalization**: a trailing slash, a default port (`:443`/`:80`), an
uppercase host, a path, query or credentials, or an empty list entry makes
the whole value invalid → 503; never read from Host / X-Forwarded-* / Referer.

### V0.1.49 rollback implications

After V0.1.49, new accounts may exist ONLY in PostgreSQL business tables
(Auth stays in Supabase). Their Supabase side has `public.users` and, when
complete-signup succeeded, a profile - but consent (V0.1.48) and everything
PostgreSQL-only is missing there. Before rolling the application back to a
Supabase-DB-dependent release, production must either:

1. reverse-sync newly provisioned accounts (users, identity-derived users.id,
   profile defaults, consent) into Supabase, reusing the Supabase profile
   where it exists (profile ids differ; ids must not be invented); or
2. keep a PostgreSQL-backed bootstrap/read path in the rolled-back release.

No bidirectional sync is built. The copy tool must not be re-run into a live
target (it refuses with `validation_failed`, proven).

### Verified locally (2026-10-23)

- `tests/unit/provisioning-db.test.ts` (43, real PostgreSQL, login role):
  created / existing / profile_created / identity_backfilled; three conflict
  shapes refused with no write; admin, super_admin, deleted refused; copied
  parents byte-identical after provisioning (incl. a non-null
  `sessions_not_before`); injected failure after the profile insert rolls
  back all five tables, Fastify answers a safe 503, a retry succeeds; 20
  concurrent same-subject calls via SQL (1 created + 19 existing), via
  Fastify (20 × 200) and via the Next BFF (20 × 200), one of everything; 9
  direct writes denied (42501); copied-vs-provisioned row shape identical;
  new user end to end (403s before → bootstrap → requireAuth resolves
  users.id = subject → balance 0 / 3 credits → consent → re-login no-op);
  BFF CSRF / 422 identity fields / 401 / 403 / 409; PostgreSQL down and
  backend unreachable → 503 `account_setup_incomplete`, still signed in, no
  rows, retry works; response lost after commit → one write, confirmed by a
  read, ready.
- `tests/unit/backend-auth-provision.test.ts` (36), `provisioning-static`
  (21), `legacy-csrf-routes` (30), `csrf-config` (24).
- **Docker + headless Chromium** (frontend, backend, postgres; stub Supabase
  Auth; scratch copied DB 0001–0015, NODE_ENV=production): new subject →
  setup card → real bootstrap click → 1/1/1/1/1 rows → account summary,
  header → consent → `/dashboard/orders`; re-login with a new session and a
  copied parent: byte-identical rows; hostile page (no-cors fetch,
  text/plain form) and hostile/missing-Origin JSON to password, referral
  bind, admin settings and bootstrap all refused, nothing changed; browser
  talked to Next only; no secret, DB password, backend URL, assertion or
  connection URL in 170 responses or in container logs. 71/71 checks.
  Docker Hub was unreachable from this machine, so the proof images were
  built FROM the existing local images (same Node 24 bookworm base, user,
  CMD) with this tree's bundle / standalone build.
- Timings (local, loaded laptop; not a production estimate): provisioning
  via Fastify first median 4.0 ms (p90 5.2), idempotent 3.7 ms (p90 4.6);
  Next bootstrap first 5.5 ms (p90 6.4), existing account 6.0 ms (p90 7.1);
  20 concurrent same-subject calls 58 ms wall; in Docker the bootstrap for an
  existing account took 51–117 ms and setup card → consent form 1.4 s.

### Production status

**Not deployable.** Unchanged: the `amr` check against real Supabase tokens
(provisioning does not solve it), a real `pg_dump` rehearsal, backend
deployment, storage, and the read/write split. New for deployment: migration
0015 ships with the app; `CARTOONA_APP_ORIGIN` now also gates the three
legacy routes.

## V0.1.50: transactional parent request submission

`POST /api/requests` no longer reads or writes a Supabase database table or
RPC. Order, request rows, the welcome-credit-or-candy spend and the ledger are
**one PostgreSQL transaction** (`create_parent_request_trusted`, migration 0005,
now executable by the app role through migration 0016), reached through
`POST /v1/parent/requests` (v3 assertion). Supabase keeps Auth and Storage
(bytes are not migrated) and, read-only, the optional gallery metadata.

### Request-flow audit (before any change)

Old flow of `POST /api/requests`, in order: content-type + `Content-Length`
cap, `auth.getUser`, rate limit (in-memory, per user, 5/min + 30/h),
`users.role` (Supabase), `checkParentSessionLifetime` (Supabase), consent
(PostgreSQL since V0.1.48), `parent_profiles.id` (Supabase), multipart parse,
draft validation, submission key, **idempotency fast path** (`orders` by
profile + key, Supabase), `characters` name→id (Supabase), Storage upload or
gallery copy (`media_assets` read, Supabase), `create_parent_request_trusted`
RPC (Supabase, service role), orphan cleanup, response.

| | image | video | drawing animation |
|---|---|---|---|
| required input | character, child name optional | character, story, duration choice, `charactersSpeak` (explicit bool) | file, title, movement, duration |
| tables changed | `orders`, [`media_assets`], welcome-credit usage + `parent_welcome_credits` **or** `candy_wallets` + `candy_transactions` | `orders`, `video_requests`, [`media_assets`], `candy_wallets`, `candy_transactions` | `orders`, `drawing_animation_requests`, `media_assets`, `candy_wallets`, `candy_transactions` |
| price | `image.default` (+ `image.reference_file` with a file) = 12 / 15 | `video.{short,medium,long}` (+ `video.reference_file`) = 40/60/90 (+5) | `drawing_animation.{short,medium,long}` = 35/50/75 |
| welcome credit | **yes, first**, then candy | never | never |
| status | `pending_review`; no status-history row on creation | same | same |
| idempotency | `UNIQUE (parent_id, submission_key)` + fast path + re-check after the wallet lock + `ON CONFLICT DO NOTHING` | same | same |
| locking | wallet `FOR UPDATE`, then the credit row `FOR UPDATE` (fixed order) | wallet | wallet |
| storage dependency | optional reference file | optional reference file | required file |
| errors | `INSUFFICIENT_CANDIES` 402, `request_*` 422, `request_consent_required` 403, pricing 503, wallet 409 | same | same |

Error contract kept: every code and status above is unchanged (the 402 product
message, the 422 shape messages, 503 pricing). New codes are only the
recovery ones below.

### Supabase RPC vs plain PostgreSQL function: parity result

Method: the body of `public.create_parent_request_trusted` from
`supabase/migrations/20261022100000_request_rpc_consent_gate_moved.sql`
(the latest Supabase definition) and from `database/migrations/0005` were
stripped of comments and whitespace and diffed. Migrations 0006-0015 do not
touch the function (grep: only 0005 defines it). The ONLY differences:

| | Supabase RPC | plain function |
|---|---|---|
| signature | 16 args | same + `p_file_mime_type text DEFAULT NULL` (appended) |
| consent clause | removed in V0.1.48 (consent moved) | **kept**: `parent_profiles.consent_granted` here IS the authoritative column, so the database re-checks it |
| source-file MIME | read from `storage.objects` | passed in by the backend; the allow-list and the `<user>/<order>/` prefix are still enforced in the function |

Everything else is identical: profile ownership, admin/parent role, type
validation, pricing lookup (fail closed), welcome-credit-first with the
credit row locked after the wallet, candy fallback, no overdraft (also a CHECK),
order insert `ON CONFLICT`, request rows, ledger key `order_debit:<order>`,
usage row, returned columns. Timestamps come from column defaults in both.
No drift was found, so **no function change was needed**; migration 0016 only
adds privileges (below). One pre-existing mismatch was fixed on the Next side:
the function raises `request_character_invalid` (and `request_script_required`,
`request_script_too_long`, `request_style_too_long`) which `request-rpc-error.ts`
had no message for (they fell to the generic text).

### What changed

- **Migration 0016**: `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE` on the request function to
  `cartoona_app`, and `GRANT SELECT ON characters`. No function body, table or
  write privilege changed. The app role still cannot INSERT/UPDATE `orders`,
  `video_requests`, `drawing_animation_requests`, `media_assets`,
  `candy_wallets`, `candy_transactions`, `parent_welcome_credits`,
  `parent_welcome_credit_usages`, `order_status_history`, `characters`,
  `creation_pricing`, and cannot execute `complete_candy_purchase_trusted`,
  `update_order_status_trusted`, `record_final_media_trusted`,
  `create_payment_attempt_trusted` ... (17 privilege probes, all `42501`; the
  SECURITY DEFINER EXECUTE list of the role is exactly nonce, request,
  provisioning, consent).
- **Fastify** (`backend/src/routes/parent-requests.ts`): `POST /v1/parent/requests`
  (`requireWriteAuth(deps, "parent")`, body limit 64 KiB: Persian text is
  2 bytes per character and two 5000-character fields exceed the global
  16 KiB) and `GET /v1/parent/requests/by-submission-key` (v2, parent only).
- **Repository** (`lib/repositories/parent-requests.ts`): the one write is the
  function call; reads are the caller's order by `(parent_id, submission_key)`
  and `characters` by name.
- **Next**: `app/api/requests/route.ts` rewritten; new
  `app/api/requests/by-submission-key/route.ts`; `lib/requests/backend-request*.ts`;
  `lib/security/csrf.ts` gained a multipart variant (same Origin and
  Sec-Fetch-Site rules; the type alone proves nothing for multipart).
- **Client**: `lib/requests/submission-attempt.ts` (persisted submission key),
  `complete-creation-request.tsx` (uncertain state, status check), success now
  goes to `/dashboard/orders` (see "Read-after-write").

New flow:

```
browser (multipart: draft, submissionKey, file | sourceAssetId)
 -> rejectUnsafeBrowserWrite(multipart)      Origin, Sec-Fetch-Site
 -> verifyParentCaller                       Supabase Auth only; subject = the actor
 -> rate limit (per subject)
 -> consent read  (v2, PostgreSQL)           cheap gate BEFORE any upload; the function re-checks
 -> idempotency lookup by key (v2)           a retry never re-uploads
 -> Supabase STORAGE upload / copy           bytes NOT migrated
 -> POST /v1/parent/requests (v3: digest + nonce)
 -> profile from the assertion -> character name -> create_parent_request_trusted
```

### Request body trust model

Public contract unchanged (draft, submissionKey, file | sourceAssetId). Next →
Fastify body, each field classified:

| field | class |
|---|---|
| `type`, `title`, `description`, `character` (name), `durationKey`, `durationChoice`, `videoScript`, `videoStyle`, `animationStyle`, `charactersSpeak`, `childName` | **A** trusted user input (validated by the draft parser, the route's shape check and the function) |
| `submissionKey` | **A** (UUID only; scoped to the parent in the database) |
| `orderId` | **B** server-derived (minted by the BFF: the storage key embeds it; route and function require the file key to start with `<caller>/<orderId>/`) |
| price / `candy_cost`, credit use, `payment_source`, order status, balance | **C** pricing/database-derived: **not in the body** |
| user id, profile id, wallet, role | **D** identity-derived: **not in the body** (assertion → `user_identities` → `parent_profiles`) |
| `file.path`, `file.mimeType`, `file.originalFilename` | **E** storage-derived (set from the object the BFF just wrote or copied; MIME is the allow-listed upload type, or the gallery row's) |

The route requires EXACTLY these keys: any extra key (`parentProfileId`,
`userId`, `role`, `walletId`, `candyCost`, `price`, `paymentSource`, `status`,
`balance`, `creditAmount`, `parent_id`) is `400 invalid_request`; headers
(`X-User-Id`, `X-Role`, ...) are never read.

### Consent

PostgreSQL only. The BFF reads consent before uploading anything (an
un-consented parent stores nothing); the function checks
`consent_granted` again inside the write transaction, so the UI and the BFF
are not the only guards (proved: an un-consented parent posting straight to
Fastify gets `403 request_consent_required` and nothing is written).

### Idempotency, outcome unknown, recovery

Two different protections, kept apart:

| | protects against | answer |
|---|---|---|
| nonce (v3 assertion) | the SAME assertion arriving twice (transport replay) | `409 replayed_request`, before the handler |
| submission key | a legitimate retry: NEW assertion, NEW nonce, SAME key | the original order, `replayed: true`, no second charge |

The BFF sends the write ONCE. If the answer is lost (timeout, reset, 5xx,
unreadable 2xx, or `409 replayed_request`, which can only mean this request
arrived before) it asks the backend by key with a fresh v2 read:

| lookup | BFF answer | UI |
|---|---|---|
| found | `200` success (the order a replay would return) | redirect |
| absent | `503 request_not_created` | "not registered yet, retry is safe (one charge only)" |
| cannot ask | `503 request_outcome_unknown` | "نتوانستیم تأیید کنیم که درخواست ثبت شده است یا نه." + "check status" |

The uploaded object is **kept** on both 503s (the order may exist and own it)
and removed only on definite refusals and on a lost submission race. "Absent"
is not proof: a write still in flight can commit after the lookup. That is
why the retry is safe by construction (same key), proved with a held write
that commits after the "absent" answer, after which the retry replays.
`GET /api/requests/by-submission-key` (+ `GET /v1/parent/requests/by-submission-key`)
returns the minimum (`found`, order id, type, status, cost, payment source)
for the CALLER's own order only; another parent's key is `found: false`,
identical to an unused key.

### Submission-key audit (historical P1) and fix

Audit of `complete-creation-request.tsx` before V0.1.50: the key lived in a
React ref, minted on the first click, and was reset to `null` by **file
selection, file removal and gallery selection**. Consequences: (1) after a lost
answer, re-selecting the file (which the page requires for any draft with a
reference file) and clicking again minted a NEW key = a second charge;
(2) a reload or navigating away and back lost the key; (3) a second tab had
its own.

Fix: the key belongs to the draft, not the file, and is persisted
(`localStorage`, record `{key, draftHash, uncertain}`, written BEFORE the first
send). It is forgotten only when the outcome is known: a confirmed order, or a
refusal that proves nothing was created (any 4xx of ours). Lost answers keep
it and mark it `uncertain`; a different draft cannot mint a competing key
while an uncertain attempt exists (it must resolve it by lookup first); a
failure before `fetch` sends nothing and forgets the key. `crypto.randomUUID`
only exists in secure contexts, so keys use `mintSubmissionKey` (falls back to
`getRandomValues`): over plain http the old code threw before sending and the
UI called it a network failure. Regression tests: `submission-attempt.test.ts`,
the browser proof (reload while uncertain keeps the key: replay, one charge).

### Storage boundary and what still reads Supabase

Storage stays Supabase: the BFF uploads/copies with the parent's own session
(bucket policies unchanged) and sends only the key, MIME type and file name to
Fastify. PostgreSQL never reads `storage.objects` (the function takes the MIME
as input). Remaining Supabase dependencies of the request path:

| | dependency | note |
|---|---|---|
| Auth | session verification (`getUser`) | unchanged, by design |
| Storage | upload, copy, remove in `parent-uploads` | bytes not migrated |
| gallery source | `parent_profiles.id` + `media_assets` READ in `resolveOwnedSourceAsset` | read-only, only when a gallery file is chosen; needs the Supabase profile |
| `/dashboard/*` middleware | `users.role` read | unrelated to the request route; the submit itself makes none |

### Consequences of a PostgreSQL-only order (known, deliberate, V0.1.51)

A request created now exists **only in PostgreSQL**. Everything that still
reads orders from Supabase cannot see it:

- **order detail page** `/dashboard/orders/[orderId]`, final media and the
  parent gallery (media rows) read Supabase. The success redirect therefore
  goes to `/dashboard/orders` (PostgreSQL list), not to the detail page; links
  from that list to the detail of a NEW order will 404 until detail reads move;
- **admin fulfilment** (request list/detail, status updates, final media,
  coupons' redemption joins) reads and writes Supabase: new requests are not
  visible to admins;
- (**resolved in V0.1.51**, see below) **candy purchases/payments** still credit the **Supabase** wallet, while
  requests now debit the **PostgreSQL** wallet. A parent who buys candy does
  not see it in the balance requests spend. The billing page already showed
  the PostgreSQL balance (V0.1.46).

These are the next blockers, not regressions to patch with dual writes: the
branch was not deployable before and still is not.

### Supabase request RPC migration

`supabase/migrations/20261022100000_request_rpc_consent_gate_moved.sql`
(V0.1.48) removed the stale consent clause from the Supabase RPC. After this
release nothing calls that RPC (a static test: no application code names
`create_parent_request_trusted` outside the repository). The migration is
**transitional compatibility only**: it is committed history and stays, and
should ship with (or before) the app only if an old Supabase writer could ever
run again (rollback, below). If the RPC is never used after cutover it has no
runtime effect either way; the Supabase function itself can be dropped in a
later cleanup migration once rollback to the old writer is off the table.
Future production ordering: Supabase migrations (this one) → data copy →
PostgreSQL migrations 0001-0016 → app. Nothing here changes it.

### Signup still creates a Supabase profile: re-audit

`complete-signup` still writes the Supabase `parent_profiles` row (whose
triggers also create a wallet and welcome credits there). After V0.1.50 the
request path no longer needs it. Remaining runtime consumers of those Supabase
records (grep over `app`, `lib`, `components`):

| consumer | needs |
|---|---|
| candy purchase create / complete / coupon (`app/api/candy-purchases/**`, `app/api/coupons/validate`) | profile id; **credits the Supabase wallet** |
| referrals bind / summary / dashboard (RPCs) | profile, referral code |
| order detail, final media, gallery (`ParentRequestContext`, `final-media-queries`, `gallery/queries`, `source-asset`) | profile id for ownership filters |
| admin request views | `orders` ⋈ `parent_profiles` ⋈ `users` |
| `ensureParentProfile` (dev auth route, signup) | creates it |

Nothing reads the Supabase **wallet balance** or **welcome credits** for a
request or for the billing display any more (balance and credits come from
PostgreSQL since V0.1.46/V0.1.50); the Supabase wallet is only credited by
purchases and read by purchase completion. The duplicate-account state is
therefore reduced to: two profile ids and referral codes (referrals), and a
Supabase wallet/credit row that is stale by construction. It cannot be
eliminated until purchases, referrals, detail/gallery/final media and admin
views move: Five consumer groups remain (the table above). Signup creation
is deliberately NOT removed.

### Rollback

Once a request/charge exists only in PostgreSQL, re-enabling the old Supabase
writer would double-spend: its wallet and credits are stale. Rules:

1. **Preferred (A): PostgreSQL stays the source of truth for requests even
   during rollback.** Roll back the app artifacts, not the data path: the
   previous release (V0.1.49) writes requests to Supabase and MUST NOT be run
   against this data. Keep the request route on PostgreSQL and roll back other
   things only.
2. **(B) only with a reverse sync** of orders + request rows, wallet balances,
   credit usage and ledger into Supabase BEFORE the old writer is enabled. No
   such tool exists; it is a production prerequisite if (A) is not acceptable.
3. The old Supabase writer must never be re-enabled against stale balances.
4. A bad deploy of THIS release is fixed forward (the function is idempotent
   per key; a half-finished request does not exist).

### Data copy interaction

The migration pin (`scripts/db/data-copy/mapping.ts`) lists 0016 (privileges
only; no mapping change). Proved with the same assertions on both
populations: a copied parent and a V0.1.49-provisioned parent starting from
the same balance/credits produce identical outcomes for 4 images, a
file image, a video and a drawing (`request-cutover-db.test.ts`).

### Migration matrix

| Surface | Source of truth after V0.1.50 |
|---|---|
| Auth (session, password, OTP) | **Supabase** |
| Identity provisioning | **PostgreSQL** (V0.1.49) |
| Consent | **PostgreSQL** (V0.1.48) |
| Creation pricing | **PostgreSQL** (V0.1.41) |
| Orders list | **PostgreSQL** (V0.1.45) |
| Account reads (balance, welcome credits, name) | **PostgreSQL** (V0.1.46) |
| **Request submission** | **PostgreSQL** (V0.1.50) |
| **Welcome-credit spend by requests** | **PostgreSQL** (V0.1.50) |
| **Candy debit by requests** | **PostgreSQL** (V0.1.50) |
| Candy purchase / payment / coupons | **Supabase** (credits the Supabase wallet: split, see above) |
| Storage (uploads, final media bytes) | **Supabase** |
| Order detail, final media, gallery | Supabase (reads) |
| Admin fulfilment, admin coupons/homepage/referrals | Supabase |
| Referrals (bind, summary) | Supabase |
| Profile name write | PostgreSQL (backend only, no UI) |

Drift that remains: two profiles / referral codes / wallets per post-cutover
parent (Supabase copies are stale); requests invisible to Supabase-backed
readers (detail, gallery, admin); purchases not reflected in the balance
requests spend; `users.email` NULL for provisioned parents.

### Verified locally (2026-10-24)

**Totals** (opt-in PostgreSQL suites on, `CARTOONA_PLAIN_PG=docker`): 105 files
passed, **3083 tests passed**, 34 skipped (the opt-in suites that need a
disposable Supabase project; unchanged), 0 failed. `npm run lint`: 0 errors
(31 pre-existing warnings). `npx next build`, `npm run backend:typecheck`,
`npm run backend:build`, `git diff --check`: clean.

New and changed suites:

| suite | tests | proves |
|---|---|---|
| `request-cutover-db.test.ts` (real PostgreSQL 17 + Fastify + Next routes + stub Auth/Storage) | 75 | privileges (17 forbidden probes, EXECUTE list), strict body and auth, each request type's rows and cost, welcome credits first (3 then candy), exact-cost / one-short / concurrent candy (12 videos for a balance of 3 x cost + 1 -> exactly 3), credit concurrency (8 for 3), same-key replay, 20 concurrent identical submissions -> 1 order / 1 charge, same assertion twice -> 409, per-parent keys, atomic rollback at 5 stages + a CHECK failure, recovery lookup and cross-parent probing, the whole Next chain with **zero Supabase database calls** (only Auth + Storage), read-after-write, CSRF, not consented / unprovisioned / insufficient candy, duplicate clicks, backend unreachable, write committed but answer lost -> success by lookup, write still in flight -> `request_not_created` then replay, answer AND lookup lost -> `request_outcome_unknown`, copied vs provisioned parent identical outcomes, timings |
| `submission-attempt.test.ts` | 27 | key stability (retry, reload, file re-selection, draft edit while uncertain), when the key may be forgotten, secure-context fallback, status check |
| `backend-request.test.ts` | 24 | the BFF decision table with a mocked backend, validators fail closed |
| `request-cutover-static.test.ts` | 24 | no Supabase DB/RPC in `POST /api/requests`, v3 + parent route, exact body keys, repository has no other write, request function named nowhere else, Storage separate, purchases unmigrated, 0016 grants only |
| ported | | `observability-routes`, `rate-limit-routes`, `request-upload-size-guard`, `welcome-image-credits` (route sections), the static guards, the DB suites' pins (16 migrations, role privileges) |

**Docker / headless browser proof** (real `Dockerfile`s tagged `proof050`,
frontend + backend containers, local PostgreSQL 17 scratch database migrated
through 0016 and populated by the real copy tool, stub Supabase Auth +
Storage on the host, Chromium talking ONLY to Next): **48/48 checks passed.**
New parent: password sign-in -> account provisioning (profile, wallet, 3
credits) -> consent -> `/complete-request` -> submit -> one welcome credit,
no candy, one order, object under `<user>/<order>/`, zero Supabase database
calls during the submit, the PostgreSQL orders list and account summary show
it. Copied parent: same behaviour; image credit-funded, video 40 candy, 100 ->
60. Failure matrix in the browser: insufficient candy (402 message, link, draft
kept, upload removed), not consented (redirect, direct POST 403, nothing
uploaded), double click (ONE POST, one order, one charge), backend
unreachable before submit (retryable 503, no charge, nothing uploaded; the
retry succeeds with one charge), response lost after commit (success by
recovery), response AND lookup lost ("could not confirm" text; the "check
status" button and a RELOAD + resubmit both finish with exactly one charge),
replay of a v3 assertion (409), unprovisioned user (setup card, request
refused 403, retry provisions). The browser only contacted
`cartoona.test:3100` and the provider; no request carried an assertion; no
secret, DB password or backend address appeared in the console.

Not proven locally: real Supabase tokens (`amr`), a production `pg_dump`,
the real Storage service (a stub with the same API shape), production load.

Local timings, isolated run, 25 each, Docker, one machine (NOT production
estimates):

| path | median | p90 |
|---|---|---|
| Fastify direct, welcome-credit-funded image | 5.3 ms | 8.4 ms |
| Fastify direct, candy-funded image | 4.5 ms | 6.7 ms |
| Fastify direct, duplicate key (idempotent replay) | 3.8 ms | 5.0 ms |
| Fastify direct, by-submission-key lookup | 3.0 ms | 3.5 ms |
| Next -> Fastify -> PostgreSQL, candy image, no file | 16.0 ms | 23.5 ms |
| Next -> Fastify -> PostgreSQL, candy image + stub-storage upload | 17.6 ms | 21.6 ms |
| Next recovery lookup (timeout recovery) | 5.8 ms | 10.9 ms |

(Inside the full parallel suite the same numbers are roughly 4-5x higher: the
machine is loaded by other suites. The Next path adds the provider check and two
backend reads - consent and the idempotency lookup - before the one write.)

### Production status

**Not deployable.** Unchanged blockers: the `amr` check against real Supabase
tokens, a real `pg_dump` rehearsal (the local Supabase-shaped fixture proves
logic, not production compatibility), backend deployment, Storage. New
deployment prerequisites: migration 0016 ships with the app; the order-detail,
gallery, admin-fulfilment and purchase/payment cutovers above must land
before any user can use the request flow end to end; the rollback rules above
must be agreed.

## V0.1.51: candy purchases and payments on PostgreSQL

From V0.1.51 the candy wallet has ONE authoritative database: PostgreSQL.
Purchases are created, priced, discounted and credited there; requests
(V0.1.50) debit it; the account summary (V0.1.46) reads it. The external
payment provider stays external: it runs checkout and proves payment; it
never writes Cartoona state.

### Purchase-flow audit (before any change)

| step | caller / auth | read or write | source of truth (before) | idempotency | money |
|---|---|---|---|---|---|
| `GET /api/candy-packages` | browser, Supabase session (RLS) | read | Supabase `candy_packages` | - | - |
| `GET /api/candy-purchases` | browser, session; role + lifetime + profile from Supabase | read | Supabase purchases, attempts, redemptions, coupon names | - | - |
| `POST /api/candy-purchases` `{package_id}` | browser, session | **direct INSERT** (RLS) | Supabase `candy_purchases`, snapshot from the package row | none (each POST = one pending purchase) | none |
| `POST /api/coupons/validate` | browser, session | read (RPC) | Supabase `validate_coupon_for_purchase_trusted` | - | - |
| `POST /api/candy-purchases/[id]/coupon` | browser, session | write (RPC, service role) | Supabase `apply_coupon_to_purchase_trusted` | `(purchase_id, idempotency_key)` | price only |
| `POST /api/candy-purchases/[id]/complete` | browser, session; **dev only** (`CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION`, never production) | write (RPC) | Supabase `complete_candy_purchase_trusted`: purchase paid + wallet credit + ledger `purchase_credit:<id>` | already-paid returns current state | **wallet credit** |
| payment session / callback / webhook | - | - | **did not exist**: no provider code, no route | - | - |

Findings that shaped the release:

1. **No payment provider existed.** In production no purchase could ever
   become paid; the only crediting path was a parent-triggered development
   simulation. The schema already had the provider-neutral pieces
   (`payment_attempts`, `payment_webhook_events`, unique verified-attempt and
   provider-transaction indexes) and `docs/PAYMENT_PROVIDER_ARCHITECTURE.md`
   §8-§11 specified the flow; nothing called them.
2. **Coupon apply and validate never worked** (Supabase too):
   `apply_coupon_to_purchase_trusted`, `validate_coupon_for_purchase_trusted`,
   `create_payment_attempt_trusted` and `record_payment_attempt_session_trusted`
   raise `42702 column reference ... is ambiguous` at run time (their RETURNS
   TABLE names collide with the columns they read). Supabase migration
   20260925100000 fixed exactly this for `create/update_coupon_trusted` and
   missed these four. Proved on a scratch database before any change.
3. **Coupon usage limits could be exceeded concurrently**: apply counted
   redemptions without locking the coupon. With the pre-V0.1.51 body (plus
   the 42702 fix) 12 concurrent applications against a global limit of 3
   succeeded 7-10 times in each of 4 runs.
4. **The attempt charged the pre-coupon price**: `create_payment_attempt_trusted`
   requested `price_amount`, not `final_price_amount` (doc §8.2 rule 4).
5. Coupon redemptions were never promoted `reserved -> redeemed` (the column
   comment says "redeemed = paid+verified"; no code did it).
6. Purchase coupons cannot stay in Supabase while purchases move: apply
   writes the redemption AND the purchase price in one transaction, and the
   limits count redemptions. So coupon definitions, the admin coupon CRUD
   and redemptions moved too.

### State machine (existing statuses, no new ones)

| transition | trigger | allowed from | idempotency | wallet | coupon | provider ref |
|---|---|---|---|---|---|---|
| (new) -> `pending` | parent creates | - | none (a pending purchase moves nothing) | - | - | - |
| `pending` -> `pending` + coupon | parent applies | `pending`, no attempt | `(purchase, key)` | - | `reserved` | - |
| attempt `created` -> `awaiting_payment` | parent pays | purchase `pending`/`failed`/`expired` | `(purchase, key)`; `failed`/`expired` purchase -> `pending` | - | frozen (no apply once an attempt exists) | session id stored |
| `pending` -> `paid` | **provider-verified** success | `pending`, `failed`, `expired` (money was taken) | event id unique; purchase lock; `purchase_credit:<id>` unique; one verified attempt per purchase | **+candy_amount once** | `reserved` -> `redeemed` | transaction id (unique per provider), amount = `final_price_amount`, currency |
| `pending` -> `failed` | provider-verified failure of the CURRENT attempt | `pending` | event id unique | - | stays `reserved` (retry allowed) | session id |
| `paid` -> anything | never (a late failure is `already_paid`) | - | - | - | - | - |
| `cancelled` | no code path sets it today (unchanged) | - | - | - | - | - |

Refunds: none exist (no `refunded` status, no reversal); nothing invented. A
second capture for an already-paid purchase (two attempts both paid) is
recorded `already_paid` and never credited: a manual refund case.

### Migration 0017

New: `create_candy_purchase_trusted` (pending purchase from the ACTIVE package
row), `confirm_payment_attempt_trusted` (event dedupe -> purchase and attempt
locks -> already-paid / cancelled / reused-transaction / amount / currency
checks -> attempt verified, purchase paid, wallet + ledger, coupon redeemed;
one transaction), `fail_payment_attempt_trusted`. Replaced:
`create_payment_attempt_trusted` (payable amount, zero refused), the four
42702 functions (`#variable_conflict use_column`, bodies verbatim),
`apply_coupon_to_purchase_trusted` (+ `FOR UPDATE` on the coupon). Grants:
EXECUTE on those nine functions (incl. `create/update_coupon_trusted`),
SELECT on `candy_packages`, `candy_purchases`, `coupons`,
`coupon_package_rules`, `coupon_redemptions`, and column-level SELECT
`(id, purchase_id, status)` on `payment_attempts`. **No** INSERT/UPDATE/DELETE
on any financial table; `complete_candy_purchase_trusted` (the simulation) is
not executable (16 privilege probes, all 42501). The Supabase originals are
not changed (history untouched; nothing calls them).

### Routes

Fastify (`backend/src/routes/candy-purchases.ts`, `payment-events.ts`, `admin-coupons.ts`):

| route | auth |
|---|---|
| `GET /v1/candy-packages` | public |
| `GET /v1/parent/candy-purchases` | v2 parent |
| `POST /v1/parent/candy-purchases` `{packageId}` | v3 parent |
| `GET /v1/parent/candy-purchases/:id/coupon-validation?code=` | v2 parent |
| `POST /v1/parent/candy-purchases/:id/coupon` `{code, idempotencyKey}` | v3 parent |
| `POST /v1/parent/candy-purchases/:id/payment-attempts` `{provider, idempotencyKey, checkoutExpiresAt}` | v3 parent |
| `POST .../payment-attempts/:attemptId/session` `{providerSessionId, checkoutUrl, checkoutExpiresAt}` | v3 parent (ownership checked in the route) |
| `POST /v1/payments/events` | **service assertion s1, svc `payments`** (no parent) |
| `GET/POST/PATCH /v1/admin/coupons[...]` | v2/v3, admin or super_admin |

Next: `/api/candy-packages`, `/api/candy-purchases` (GET/POST),
`/api/coupons/validate`, `/api/candy-purchases/[id]/coupon` keep their public
contracts; new `/api/candy-purchases/[id]/pay` `{idempotency_key}`,
`/api/payments/webhooks/[provider]` (provider signature only: no CSRF, no
cookie, no session), `/api/payments/return/[provider]?session=` (browser
return; the server asks the PROVIDER, never trusts the query);
`/api/candy-purchases/[id]/complete` is **removed**. Admin coupon pages and
API read/write PostgreSQL (role from `/v1/auth/me`, re-checked by every
backend route and by the functions).

Provider boundary: `lib/payments/providers/` (adapter interface;
`stub` adapter for local/test only, refused under `NODE_ENV=production`
with no override since V0.1.54). Provider
secrets stay in Next; the backend never sees them. With no provider
configured (production today) `pay` answers `503 PAYMENT_UNAVAILABLE`.

Service assertion (s1): `s1.<payload>.<mac>`, MAC context
`cartoona-internal-auth\ns1\n` (domain-separated from v2/v3), keys `v, svc,
iat, exp, rid, mth, pth, nce, bdg`, POST only, body digest, single-use nonce
(same store as v3). An identity token is refused on the service route and an
s1 token on every identity route.

### Ordering and outcome-unknown

`pay`: (1) attempt in PostgreSQL with OUR id (idempotent per key, amount = the
payable snapshot), (2) provider session referencing that attempt id,
(3) session recorded. A retry with the same key returns the stored checkout
URL; a lost record answer is resolved by the same key. Nothing here moves
money.

| case | what happens |
|---|---|
| A. browser did not get the pay answer | retry with the same key -> the same attempt / checkout URL |
| B. provider outcome unknown (user closed checkout, webhook late) | purchase stays `pending`; billing shows "در انتظار تأیید پرداخت" and re-reads; the webhook or the next return resolves it |
| C. confirmation committed, answer lost (Next -> Fastify) | the webhook answers 500, the provider retries, the retry is `duplicate_event` / `already_paid`: one credit |

Webhook vs callback: both reach the same function with different event ids;
the purchase lock serializes them; the second is `already_paid`.

### Idempotency keys

| action | key |
|---|---|
| create purchase | none by design (a pending purchase has no financial effect); the UI guards double clicks |
| apply coupon | client `idempotency_key`, unique per purchase |
| start payment | client `idempotency_key` per purchase pay action, unique per purchase |
| provider event | `(provider, provider_event_id)` unique in `payment_webhook_events`, written in the confirming transaction |
| return-route verification | deterministic `verify:<session>:<transaction>` |
| wallet credit | `purchase_credit:<purchase>` unique ledger key + purchase `paid` check + one verified attempt per purchase |
| provider transaction | `(provider, provider_transaction_id)` unique: one payment cannot fund two attempts |

### Copied data

Pin: 0017 (functions and grants only; no mapping change). A copied paid
purchase given a provider session and then a success event answers
`already_paid` and keeps exactly one `purchase_credit` row; a copied pending
purchase with a reserved WELCOME10 redemption is paid at the discounted price
and its redemption becomes `redeemed` (tested).

### Supabase profile: what still needs it

Purchases and coupons no longer need it. Remaining runtime consumers:
order detail + final media (`ParentRequestContext`, `final-media-queries`),
the gallery (`gallery/queries`, `source-asset`, also used by the request
route for gallery sources), admin request views + fulfilment, and the
referral RPCs; `ensureParentProfile` (signup, dev route) creates it. Four
consumer groups remain (purchases removed one); signup creation is NOT
removed. The Supabase wallet, welcome credits, purchases and coupon
redemptions are now stale by construction and read by nothing.

### Rollback (HARD rule)

After V0.1.51 every wallet movement is in PostgreSQL. **Never re-enable a
Supabase purchase or request writer against the stale Supabase balances.**
Preferred: frontend/backend artifacts may roll back, but financial writes stay
routed to PostgreSQL-compatible endpoints (i.e. roll back only to builds at or
after V0.1.51 for anything touching money). If that is impossible: a write
freeze (pay, purchase, request routes return 503) until forward recovery. No
dual write, no reverse sync tool exists.

### Still NOT migrated

Order detail, gallery, final media and admin fulfilment (a new request is in
the orders list only; success still redirects there), Storage bytes,
referrals, other admin writes (homepage, referral settings, request status).

### Migration matrix (after V0.1.51)

| Surface | Source of truth |
|---|---|
| Auth | Supabase |
| Identity provisioning | PostgreSQL |
| Consent | PostgreSQL |
| Account reads (balance, credits, name) | PostgreSQL |
| Orders list | PostgreSQL |
| Request submission | PostgreSQL |
| Candy request debit | PostgreSQL |
| **Candy purchase / payment state** | **PostgreSQL** |
| **Candy purchase wallet credit** | **PostgreSQL** (provider-verified events only) |
| **Purchase history, package catalog** | **PostgreSQL** |
| **Purchase coupons + admin coupon management** | **PostgreSQL** |
| Payment provider (checkout, proof) | external (stub only locally; none configured in production) |
| Order detail / gallery / final media | legacy (Supabase) |
| Admin fulfilment | legacy (Supabase) |
| Referrals | legacy (Supabase) |
| Storage | Supabase |

### Verified locally (2026-10-24)

**Totals** (`CARTOONA_PLAIN_PG=docker`): 108 files, **3179 passed**, 34
skipped (the opt-in suites that need a disposable Supabase project), 0 failed.
`npm run lint`: 0 errors (29 pre-existing warnings). `npx next build`,
`npm run backend:typecheck`, `npm run backend:build`, `git diff --check`:
clean. Repo-wide `tsc` still reports the known test-only type errors (e2e
specs, legacy-csrf-routes, parent-auth, pricing-calculation, test-env, the
`execFile` env typing in two plain-postgres tests); no runtime file has one.

| suite | tests | proves |
|---|---|---|
| `purchase-cutover-db.test.ts` (real PostgreSQL 17, copy, restricted role, Fastify, Next routes, stub Auth, stub provider) | 47 (x4 runs, all green) | 16 forbidden privilege probes + exact EXECUTE list; catalog/history from PostgreSQL; server-derived price, strict bodies, CSRF; coupon validate/apply idempotent; **global limit 3 under 10 concurrent -> 3**, per-parent 2 under 6 -> 2 (the pre-V0.1.51 body allowed 7-10 of 12); pay: post-coupon amount, our attempt id, same key resumes, zero price refused; webhook -> one credit; **same event x20 concurrent -> 1 processed + 19 duplicates**; **20 different events racing -> 1 credit**; return + webhook racing -> 1 credit; return alone confirms a lost webhook; decline -> failed -> retry pays once; late failure never regresses; amount/currency mismatch, unknown session, reused transaction credit nothing; forged/tampered/stale signatures 401; parent v3 on the event route 401; service token on parent routes 401; service assertion replay 409; DB down at confirmation -> 500 -> retry processed once; committed-but-lost -> 500 -> retry duplicate; purchase -> balance -> request -> balance for copied and provisioned parents, zero Supabase DB calls; copied paid purchase never re-credited; copied pending coupon purchase paid at the discount, coupon redeemed; admin coupon list/create/update (409 on stale), parent 403 |
| `purchase-cutover-static.test.ts` | 14 | no Supabase financial table/RPC access in Next; simulation gone; only the confirm function credits; event route service-only; only webhook/return deliver events, after provider verification; provider routes have no CSRF/session; stub refused in production; UI bodies carry no price/amount/owner; detail/gallery/admin fulfilment/Storage untouched |
| `payment-provider-stub.test.ts`, `service-assertion.test.ts` | 24 | adapter config + production refusal, signature/tamper/stale/unknown events, provider errors, deterministic verify ids; s1 round trip, binding/body/expiry, no interchange with v2/v3 |
| ported | | rate-limit routes, admin coupon `expectedUpdatedAt`, static guards (CSRF users, backend writes, backend client users, write auth incl. the service route), migration pins (17), schema parity (4 more intentionally changed bodies, 3 target-only functions) |

**Docker / headless browser proof** (real `Dockerfile`s tagged `proof051`,
frontend + backend containers on the compose network, scratch PostgreSQL 17
migrated through 0017 and populated by the real copy tool, stub Supabase Auth
and the stub payment provider on the host): **32/32 checks passed.** New
parent: password sign-in -> provisioning -> consent -> billing shows 0 ->
select package -> order -> "پرداخت" -> provider checkout shows exactly the
catalog price -> Pay -> back to billing with the success notice -> one credit,
balance = candy amount, history paid -> video request -> orders list ->
balance Y - 40, ledger reconciles. Copied parent: WELCOME10 applied in the UI,
the checkout shows the DISCOUNTED amount, X -> X+Y -> X+Y-Z, coupon redeemed.
Failure matrix: decline (failed, no credit, retry pays once), invalid and
exhausted coupons (existing messages, nothing reserved), parent on the admin
coupon API 403, webhook x5 (1 processed + 4 duplicates), double click on pay
(one credit), webhook dropped (the return confirms once; revisiting is a
duplicate), invalid signature 401, forged browser POST 401, forged return
query for an unpaid session (pending, no credit), backend container STOPPED
at confirmation (webhook 500, nothing credited; after restart the provider
retry is processed exactly once). The browser contacted only Next, the auth
stub and the provider's checkout page; no assertion header; no secret, DB
password, provider key or backend address in the console.

Local timings (Docker, one machine, 20 each, NOT production estimates):

| path | median | p90 |
|---|---|---|
| Next purchase creation (CSRF, provider, v3 -> Fastify -> PG) | 8.1 ms | 14.8 ms |
| provider confirmation transaction (service event -> confirm) | 3.9 ms | 6.5 ms |
| duplicate confirmation (already paid) | 4.1 ms | 6.1 ms |
| Next purchase history (PG) | 6.2 ms | 8.4 ms |
| Next account summary after purchases | 6.1 ms | 7.6 ms |
| full roundtrip: create + pay + webhook + request + summary | 37.4 ms | 46.5 ms |

### Production status

**Not deployable.** New: no real payment provider exists (an adapter must be
written and reviewed; until then production cannot be paid, as before);
migration 0017 ships with the app; the rollback rule above. Unchanged: the
`amr` check against real Supabase tokens, a real `pg_dump` rehearsal, backend
deployment, Storage, and V0.1.52 scope (order detail, gallery, final media,
admin fulfilment) before parents can use new requests end to end.

## V0.1.52: order detail, media metadata and admin fulfilment on PostgreSQL

From V0.1.52 a request is usable end to end on the new architecture: it is
created in PostgreSQL (V0.1.50), paid for in PostgreSQL (V0.1.51), shown on the
parent's detail page, fulfilled by an admin and delivered, **all from PostgreSQL
rows**. Supabase is Auth and Storage object **bytes** only.

### Order/media consumer audit (before any change)

| route / page | R/W | source before | Storage dependency | role | ownership rule | V0.1.52 |
|---|---|---|---|---|---|---|
| `/dashboard/orders/[orderId]` (page) | R | Supabase `orders`+`video_requests`+`drawing_animation_requests`+`media_assets`+RPC history | signs source files (`parent-uploads`) | parent | `parent_id` = profile from a Supabase profile read | **PostgreSQL** (backend), Storage signs only |
| `POST /api/parent/orders/[id]/final-media` | R+audit W | Supabase ownership + `media_assets`; admin-client INSERT into Supabase `audit_logs` | signs `final-deliverables` with the **session** (Storage RLS read Supabase `media_assets`) | parent | Supabase read | **PostgreSQL** authorization + PostgreSQL audit; service credential signs |
| `GET /api/parent/gallery`, `/dashboard/gallery` | R | Supabase `media_assets` join `orders` | batch-signs `parent-uploads` | parent | `orders.parent_id` | **PostgreSQL** keyset page, Storage signs the page |
| `POST /api/requests` (gallery source) | R | Supabase `resolveOwnedSourceAsset` | server-side `copy` | parent | `orders.parent_id` | **PostgreSQL** (`GET /v1/parent/gallery/:id`), Storage copies |
| `/admin/requests`, `/admin/requests/[id]` | R | Supabase joins (`parent_profiles`, `users`, `characters`, `media_assets`) | signs source + final | admin / super_admin | none (admins see all) | **PostgreSQL** |
| `PATCH /api/admin/requests/[id]/status` | W | admin-client RPC `update_order_status_trusted` **in Supabase** | none | admin | role from Supabase `users` | **PostgreSQL** (v3 + nonce) |
| `POST /api/admin/requests/[id]/final-media` | Storage W + DB W | admin-client upload + RPC `record_final_media_trusted` in Supabase | uploads bytes | admin | Supabase role | bytes -> Storage, **link -> PostgreSQL** |
| `PATCH .../final-media/[assetId]` | W | Supabase RPC approve/supersede | none | admin | Supabase role | **PostgreSQL** |

Staying on Supabase, on purpose (all documented below): the Edge middleware and
the admin layout role gate (`users.role`), referrals, homepage/example CMS,
`ensureParentProfile`/signup, the dev parent-auth route.

### Metadata vs bytes

| | PostgreSQL | Supabase Storage |
|---|---|---|
| a media row | id, order, `type`, `asset_role`, `delivery_status`, `parent_visible`, object **key** (`file_url`), MIME, size, filename, timestamps | the object |
| authorization | every statement (`orders.parent_id = <profile>`, role/status/visibility predicates) | **none**: not consulted, `storage.objects` is never read |
| a signed URL | never stored or returned by the backend | minted per request, 300 s, after PostgreSQL returned the key |
| a browser | gets ids + short-lived URLs | never names a key or bucket |

### Migration 0018

No state machine changes: `update_order_status_trusted`, `record_final_media_trusted`,
`approve_final_media_trusted`, `supersede_final_media_trusted` and
`get_order_status_history_admin_trusted` already existed in 0005 (a comment-stripped diff
against Supabase shows identical bodies). 0018 only:

- adds `record_final_media_access_audit_trusted(actor, order, asset, action)`: SECURITY
  DEFINER, empty `search_path`, refuses anything but the **owning** parent and the order's
  **current approved, parent-visible final**, action in (`final_media_view`,
  `final_media_download`), stores `{orderId}` only;
- `REVOKE ALL ... FROM PUBLIC` then `GRANT EXECUTE` on those six functions to `cartoona_app`;
- `GRANT SELECT` on `media_assets`, `video_requests`, `drawing_animation_requests`.

Still no INSERT/UPDATE/DELETE on `orders`, `order_status_history`, `media_assets` or
`audit_logs`. The data-copy target pin is 18 migrations.

### Routes

Backend (all `Cache-Control: no-store`; caller = `request.authPrincipal` only):

| route | auth | notes |
|---|---|---|
| `GET /v1/parent/orders/:orderId` | v2, parent | ownership first, then source media, parent-safe history, current final; 4 statements, independent of file count |
| `GET /v1/parent/orders/:orderId/final-media` | v2, parent | the key of the current approved final of an owned order; 404 otherwise |
| `POST /v1/parent/orders/:orderId/final-media/access` | v3, parent | `{assetId, action}` -> audit function |
| `GET /v1/parent/gallery?cursor&limit` | v2, parent | keyset `(created_at desc, id desc)`, 24 default / 48 max, source uploads only |
| `GET /v1/parent/gallery/:assetId` | v2, parent | an owned source asset (request re-use) |
| `GET /v1/admin/requests`, `/:id` | v2, admin/super_admin | queue (type/status/page), detail + media metadata + history (role re-checked in SQL) |
| `GET /v1/admin/requests/:id/upload-gate` | v2, admin | admin + order exists + status allows a final upload; asked **before** bytes are stored |
| `PATCH /v1/admin/requests/:id/status` | v3, admin | `{status, expectedUpdatedAt, internalNote, parentVisibleNote}` |
| `POST /v1/admin/requests/:id/final-media` | v3, admin | `{filePath, mimeType, byteSize, originalFilename}` -> record the link |
| `PATCH /v1/admin/requests/:id/final-media/:assetId` | v3, admin | `{action: approve \| supersede}` |

Next (BFF): `verifyParentCaller()` -> the loaders in `lib/parent/orders/backend-order-detail.ts`,
`lib/parent/backend-media.ts`, `lib/admin/requests/backend-requests.ts`. Every browser write
starts with the shared CSRF guard (JSON, or the multipart variant for the upload). Next never
decides a role: the backend refuses a parent on every admin route (403), the trusted functions
re-check in PostgreSQL, and the browser can send no actor id.

### Signed-URL authorization

1. The only authorization is a PostgreSQL row: owner (`orders.parent_id` = the profile resolved
   from the verified assertion) **and** `asset_role = 'final'`, `delivery_status = 'approved'`,
   `parent_visible = true`. Foreign, unknown, superseded, unapproved all answer the same 404.
2. The key signed is the one that row returned. No request field (body, query, header) can
   name an object; a static guard pins `signFinalDeliverable(authorized.path, ...)`.
3. Order in the route: authorize -> per-parent rate limit -> sign -> audit. A limited request
   mints nothing; a failed audit write is logged (ids only) and never fails the response.
4. **Why the service credential signs final deliverables:** the `final-deliverables` bucket
   policy read Supabase `media_assets`. PostgreSQL-created orders have no such row, so the
   policy would deny them. The policy is now irrelevant: PostgreSQL authorizes, then
   `lib/storage/final-deliverables.ts` (the only module using the service client for these
   paths, Storage calls only, never a table) signs. Source previews (`parent-uploads`) are
   path-prefix based and still signed with the caller's session client.

### Fulfilment state machine (unchanged, documented from the existing function)

`pending_review -> in_progress | rejected | cancelled`; `in_progress -> ready | rejected | cancelled`;
`ready -> delivered`; `delivered`, `rejected`, `cancelled` are terminal. `ready` requires at least
one approved parent-visible final; `rejected` requires an internal or parent-visible note; notes
are trimmed, empty -> NULL, <= 2000 chars. One statement: lock the order `FOR UPDATE`, compare
`expectedUpdatedAt`, validate, update the order and append **one** `order_status_history` row.
Parent-facing mapping (`status-mapping.ts`): `delivered` -> "ready", `rejected`/`cancelled` -> "closed".
Rejection and cancellation do **not** refund candies (existing behavior, no financial mutation in
this function; flagged below).

### History and idempotency

- Exactly one history row per real transition (proved: 12 parallel identical requests -> one write, one row).
- The same v3 assertion twice -> `409 replayed_request` (nonce) before the handler.
- A new assertion repeating a committed transition: a stale `expectedUpdatedAt` raises
  `request_status_conflict`; if the order's current status already equals the target the
  backend answers **200 `replayed: true`** with the current state and writes nothing. A current
  token with an unchanged status stays `409 request_status_unchanged`; a different target stays 409.
- A database failure on a write is a 503 the Next route reports as "result unknown, reload"
  (never "not saved").

### Final-media write boundary

The Next BFF is the only holder of the storage credential, so the order is: backend **gate**
(admin, order exists, status in pending_review/in_progress/ready) -> validate type/size ->
upload bytes -> backend **record** -> on a *definite* refusal remove the object, on an
*unknown* outcome keep it. The backend validates before the function runs: key exactly
`orders/<this order>/final/<uuid>.<ext>`, extension agrees with an allow-listed MIME
(png/jpeg/webp/mp4/webm), size within the type's cap (10 MiB image / 100 MiB video), exact body
keys; the function re-checks the prefix, status and role. The object-exists check the 0005 function
documents is satisfied by the upload having just succeeded (the backend holds no Storage client).
A new final starts `uploaded`, not visible; approval is explicit; `ready` needs an approved one.

### Storage failure semantics

Metadata is always shown. A signing failure degrades each preview to `signedUrl: null` (the
existing "unavailable" tile); the final-media route answers a retryable `500 SIGNING_FAILED`;
nobody is signed out; the audit row is written only after a URL was minted.

### Supabase profile / dependency map (item 24/26)

| need | Supabase | PostgreSQL |
|---|---|---|
| sign-in, token verification | **Auth** | identity link, role, session policy |
| object bytes, signed URLs, upload/copy/remove | **Storage** | keys + metadata |
| Edge middleware / admin layout role gate | `users.role` read (the one remaining business-shaped read on the order path) | authoritative role for every backend decision |
| order, media, history, fulfilment, wallet, purchases | - | **all** |
| referrals, homepage/example CMS, `ensureParentProfile`/signup, dev route | still Supabase | not migrated |

The unused `ParentRequestContext` (a Supabase profile/role reader) was deleted. Remaining
Supabase `parent_profiles`/`users` readers: referrals (3 routes), `complete-signup` +
`ensureParentProfile`, `/api/parent/password`, the admin layout / `requireAdmin` / example auth,
the dev route and the `/complete-request` page's role gate. Referrals were not migrated (not trivial:
the RPC set, the settings table and the admin pages).

### Rollback (HARD rule)

Never re-enable a Supabase order, request, fulfilment or financial writer: the Supabase
`orders`, `media_assets`, `order_status_history` and wallet rows are stale by construction and
would diverge from PostgreSQL. Roll back only to builds at or after V0.1.52 for anything
touching orders/media; otherwise freeze the affected routes (503) until forward recovery. No
dual write and no reverse sync exists. Migration 0018 is additive (a function and grants).

### Copied data

Historical orders, history (microsecond timestamps), source uploads and approved/superseded
finals read through the new path unchanged (proved with the copied fixture: delivered order with
three history rows and v1 superseded / v2 approved; a drawing animation with its upload; an
in-progress video cancelled by an admin on the new stack). Storage keys are untouched.

### Still NOT migrated

Storage bytes, referrals, other admin writes (homepage, examples, referral settings), signup profile
creation, the Edge role gate, a refund policy for rejected/cancelled orders, a real payment provider.

### Migration matrix (after V0.1.52)

| Surface | Source of truth |
|---|---|
| Auth | Supabase |
| Identity provisioning, consent, account reads, orders list | PostgreSQL |
| Request submission, candy debit | PostgreSQL |
| Candy purchase / payment / coupons | PostgreSQL |
| **Order detail** | **PostgreSQL** |
| **Gallery metadata, final-media metadata, signed-URL authorization** | **PostgreSQL** |
| **Admin queue, detail, status transitions, history** | **PostgreSQL** |
| **Final-media link, approve, supersede, access audit** | **PostgreSQL** |
| Payment provider (checkout, proof) | external (stub only locally) |
| Referrals | legacy (Supabase) |
| Homepage / examples CMS | legacy (Supabase) |
| Edge role gate, admin layout | Supabase `users.role` |
| Object bytes + signed URLs | Supabase Storage |

### Verified locally (2026-10-24)

**Totals** (`CARTOONA_PLAIN_PG=docker`): 112 files (109 passed, 3 skipped files), **3224 passed**, 34
skipped (the opt-in suites that need a disposable Supabase project), 0 failed (V0.1.51: 3179 / 34).
`npm run lint`: 0 errors (29 pre-existing warnings). `next build` (run inside the proof image
build), `npm run backend:typecheck`, `npm run backend:build`, `git diff --check`: clean. Repo-wide
`tsc` still reports only the known test-only type errors; no runtime file has one.

| suite | tests | proves |
|---|---|---|
| `order-fulfilment-cutover-db.test.ts` (real PostgreSQL 17, copy, restricted role, listening Fastify, Next route handlers/loaders, stub Auth + in-memory Storage) | 47 | 8 forbidden privilege probes + role checks inside the functions; the audit function refuses non-owner/superseded/wrong order/unknown action; parent detail ownership (foreign = unknown = malformed = identical 404; admin 403; unlinked 403), no N+1 (statement count independent of file count), copied history with microseconds; final media: owner signs, audit row has ids only, cross-parent/unapproved/superseded/unknown all 404 and nothing signed, browser cannot name a key, CSRF, admin cannot use the parent route, **Storage outage keeps metadata and is a retryable 500 without sign-out or audit row**; gallery: 60 rows with identical timestamps walk 24/24/12 with no duplicate or gap, exact multiple has no phantom page, upload between pages, deleted cursor row, forged cursors 400, foreign/final/other roles excluded, batch signing, re-use resolves only owned sources; admin: queue/detail incl. internal notes, parent 403 on every verb with X-Role/X-User-Id spoof ignored, read-vs-write/body/path assertion binding, a session that *claims* admin but is a parent is 403 and stores no byte; state machine: one history row with the admin as actor, same assertion twice 409, new-nonce retry 200 `replayed` with no second row, every refusal writes nothing, terminals never reopen, **12 parallel identical transitions -> one write**, **competing targets -> one winner and clean 409s**; final-media boundary: 11 key/MIME/size violations 422 + shape 400, uploaded->approved->superseded, gate before bytes, **definite refusal removes the object, unknown outcome keeps it**; end to end upload -> approve -> ready -> delivered with parent list/detail/final/gallery and the admin view agreeing; copied order history/media intact and advanceable; zero `/rest/v1` calls |
| `order-fulfilment-cutover-static.test.ts` | 15 | no `.from()/.rpc()` on a business table in the migrated surfaces; deleted readers/writers stay deleted; the service credential is Storage-only; the backend has no Storage code; signing only after PostgreSQL authorization in a fixed order; no actor/role/key from the browser; CSRF then caller; gate before `formData()`/upload; backend role and write preHandlers; key rules; 0018 shape and pin; repositories are constant SQL |
| ported | | gallery (3 files), observability and rate-limit routes, session-lifetime route test, privilege probes that listed the now-granted functions, schema parity (+1 target-only function), migration pins (18), static guard lists (CSRF users, backend client users, backend writes, write auth) |

**Docker / headless browser proof** (real `Dockerfile`s tagged `proof052`, frontend + backend containers on the
compose network, scratch PostgreSQL 17 migrated through 0018 and populated by the real copy tool, stub Supabase
Auth/Storage and the stub payment provider on the host): **49/49 checks passed.** New parent: sign-in ->
provisioning -> consent -> candy bought through the provider stub -> request submitted (exists only in
PostgreSQL) -> **the detail page renders it** (it 404'd before) with its source file from a short-lived signed
URL -> gallery lists it -> no final media yet (404, nothing signed). Admin (email sign-in): queue and detail
render from PostgreSQL; in_progress with exactly one history row by the admin; `ready` without an approved
final refused; upload (bytes to Storage, link in PostgreSQL, not visible); a disallowed type refused before
any byte is stored; approve; a spare upload superseded; ready; a stale token is a 409 and writes nothing;
delivered; a stale-token retry returns the current state and writes nothing; terminal never reopens. Parent
again: detail shows the result without any storage key, the final signs only for the approved asset (never the
superseded copy), the audit row is in PostgreSQL, list and gallery agree. Unauthorized parent: the same 404 for
another parent's order and an unknown id, cannot sign the final (nothing signed), gallery excludes it, the admin
status/upload APIs are 403 with no byte stored, the admin page is unreachable. Copied historical order: renders
with history, its approved v2 (not v1) signs, admin sees internal notes, cannot be reopened. Storage down:
metadata still renders, the signed route is a retryable 500, the same session works after recovery. The
browser contacted only Next, the auth stub and the provider's checkout page; no assertion header; no secret,
DB password or backend address in the console; the Supabase REST surface was called only for the Edge/admin
role gate (`/rest/v1/users`).

Local timings (Docker, one machine, restricted role, loopback Fastify, 20-30 calls each; NOT production
estimates; the transition figure includes reading the concurrency token first):

| path | median | p90 |
|---|---|---|
| parent order detail (backend) | 5.7 ms | 10.0 ms |
| gallery first page (24 of 30, backend) | 6.0 ms | 13.4 ms |
| admin queue (backend) | 3.8 ms | 5.2 ms |
| admin detail (backend) | 3.9 ms | 5.5 ms |
| status transition (token read + write) | 8.1 ms | 25.0 ms |
| final-media association | 3.9 ms | 6.5 ms |
| signed-URL authorization (PostgreSQL part) | 3.3 ms | 4.8 ms |

### Production status

**Not deployable.** Unchanged blockers: no real payment provider adapter; the `amr` check against real
Supabase tokens; a real `pg_dump` rehearsal; backend deployment; Storage still Supabase (and its
service credential now also signs final deliverables); migration 0018 ships with the app. New: the
Edge/admin-layout role gate still reads Supabase `users.role`; no refund policy for rejected/cancelled.

## V0.1.53: no Supabase database at runtime

After V0.1.53 Supabase is **Auth and Storage bytes only**. Every business row is
in PostgreSQL behind the backend; Next is the BFF, the UI, the Auth adapter and
the Storage signing boundary. A static guard scans the whole runtime tree for any
Supabase database call and the clients' TYPES no longer expose `.from()` /
`.rpc()`.

### Runtime audit (before any change)

| file | route / function | Supabase DB use | R/W | purpose | replacement |
|---|---|---|---|---|---|
| `middleware.ts` | Edge gate for /dashboard, /admin, /complete-request, /parent-consent | `users.role` read (twice) + the 30-day lifetime | R | role routing | **auth-only Edge**; role = server page gates (PostgreSQL via `/v1/auth/me`) |
| `app/admin/layout.tsx` | admin shell | `users.role` | R | admin gate | `gateAdminPage()` |
| `app/(auth)/complete-request/page.tsx` | step page | `users.role` + local lifetime | R | role/session gate | `gateParentPage()` |
| `lib/auth/require-admin.ts`, `lib/examples/example-auth.ts` | admin helpers | `users.role` | R | admin gate | deleted; the backend decides (403) |
| `app/api/referrals`, `/bind`, `/api/admin/referrals`, `/settings` | referrals | `users.role` + 5 `.rpc()` | R/W | referral summary, binding, admin overview + settings | backend `/v1/parent/referrals*`, `/v1/admin/referrals*` |
| `lib/homepage/{resolver,service,resolve-core}.ts` | public homepage | `homepage_content`, `homepage_media_assets`, `homepage_hero_layout` | R | CMS read | one anonymous `GET /v1/public/homepage` |
| `lib/admin/homepage/{service,media-service}.ts`, 4 admin routes | homepage CMS | `users`, the 3 tables, 4 `.rpc()` | R/W | CMS edit | backend `PUT /v1/admin/homepage`, media record/delete, hero layout |
| `app/(marketing)/examples`, `app/admin/examples/*`, 5 admin routes | examples CMS | `examples` (direct INSERT/UPDATE/DELETE via RLS) | R/W | examples CMS | backend `/v1/public/examples`, `/v1/admin/examples*` + 4 new trusted functions |
| `lib/parent/ensure-parent-profile.ts`, `app/api/parent/complete-signup` | signup | `parent_profiles` read + INSERT | R/W | duplicate Supabase business profile | **deleted** (PostgreSQL provisioning only) |
| `app/api/dev/parent-auth` | dev login/signup | `users.role` x4, `parent_profiles` INSERT | R/W | dev convenience | role via the backend; no profile insert |
| `app/api/parent/password` | password change | `users.role` | R | parent-only gate | role via the backend; the password is Supabase Auth only |
| `app/api/dev/supabase-check`, `lib/requests/resolve-character.ts`, `lib/auth/{admin-role,parent-access}.ts` | diagnostics / dead helpers | `characters` read / none | R | - | deleted (no caller) |

Supabase Auth usage is untouched; Storage usage is isolated in `lib/storage/*`.

### Role gates (item 3-6)

- **Edge middleware is authentication-only.** It verifies the session with the
  provider (bounded 5 s deadline, a 503 retry on an outage, never a sign-out) and
  redirects a signed-out visitor to `/login` or `/admin-login`. It reads no
  role, no table and no lifetime: the Edge has neither `node:crypto` nor the
  internal secret, so it cannot ask the backend, and it must not read Supabase.
- **Authoritative gates are server-side and run before any privileged markup or
  data exists**: `gateAdminPage()` in `app/admin/layout.tsx`, `gateParentPage()`
  in `app/(dashboard)/layout.tsx`, `/complete-request` and `/parent-consent`
  (`lib/auth/page-gates.ts`). They call `resolveCallerRole()`: Supabase Auth
  verifies who, then `GET /v1/auth/me` returns the role from `user_identities` +
  `users` in PostgreSQL, with the 30-day / `sessions_not_before` policy applied by
  the backend. `redirect()` throws, so nothing below a failed gate renders.
- Outcomes: admin/super_admin keep their semantics (a parent is sent to
  `/dashboard`; an admin may open `/dashboard` but is sent to `/admin` from the
  parent-only steps); a **deleted** account and an **unlinked** identity are denied
  (an unlinked one goes to `/parent-consent`, the page that runs the account
  bootstrap, instead of loading anything); an **expired / invalidated** session is
  ended and sent to the matching login; a **backend or provider outage** is neither
  access nor a sign-out (the page renders a retry message). Data routes never relied
  on the Edge: the backend refuses a non-admin on every admin route (403).
- Because layouts are cached across soft navigations, the gate is a UX/privilege
  gate; every data request is authorized again by the backend.

### Signup and the duplicate business state (item 7-8, 23)

Signup is: Supabase Auth user -> `POST /api/parent/account-setup` -> PostgreSQL
user, identity, profile, wallet, welcome credits and referral code
(`provision_supabase_parent_identity`). `complete-signup` and
`ensureParentProfile` (which inserted a second Supabase profile) are deleted, the
dev route no longer inserts a profile, and no wallet or credit row is created in
Supabase. Proven: a brand-new user goes through provisioning, role, consent,
referral, purchase creation, request, order detail and gallery with **zero**
`/rest/v1` requests. Existing production rows are not touched or deleted.

### Referrals (item 9-12)

There is **no referral reward in the schema**: a referral is a one-time binding
(`referral_relationships`) plus a program setting (`is_enabled`,
`reward_basis_points`, with an immutable history). No function credits a wallet, so
nothing financial moves; the basis points are admin-set configuration only.
Migration 0019 grants EXECUTE on the five existing trusted functions; the backend
routes are `GET /v1/parent/referrals` (v2 parent), `POST /v1/parent/referrals/bind`
(v3 parent, exact body `{ code }`), `GET /v1/admin/referrals` and
`PATCH /v1/admin/referrals/settings` (admin). Proven on real PostgreSQL: self,
unknown and malformed codes are `invalid_code`; the same parent cannot bind twice
(**14 parallel binds -> exactly one `bound`**, 13 `already_bound_same`; two referrers
racing -> one relationship); the 5-per-minute limit; a disabled program refuses binds;
extra body keys, ids, amounts and balances are 400; an admin cannot bind; settings
need the admin, have optimistic concurrency (**6 concurrent writers with one token ->
one `updated`, five `conflict`**) and write one history row; ledger and wallets are
unchanged by any bind. The shared CSRF guard is unchanged.

### Homepage and examples CMS (item 13-16)

- **Public homepage**: one anonymous `GET /v1/public/homepage` (content row, media
  rows with object KEYS, hero layout), resolved by the same pure code as before; Storage is
  touched only to build the public URL. A backend outage renders the committed defaults
  (never blank, never throws).
- **Admin writes**: `PUT /v1/admin/homepage` (revision-checked), media record /
  revert, hero layout - v3 assertion, admin role, the existing trusted functions.
  Bytes: Next asks `GET /v1/admin/cms/gate` first (a parent stores nothing), uploads, then
  records the metadata; a definite refusal removes the object, an unknown outcome keeps it.
  The slot is sent in the body (slot keys contain dots and backend paths are dot-free).
- **Examples**: migration 0019 adds `create/update/replace_media/delete_example_trusted`
  (admin role re-checked, field rules, the object key must be `examples/<this id>/...`);
  the application role still has no INSERT/UPDATE/DELETE on `examples`. Public list =
  published only; image bytes use the service credential in `lib/storage/example-media.ts`
  after PostgreSQL authorizes the admin (the bucket policy used to read the Supabase
  `users` table).
- The homepage / examples admin writes had **no CSRF guard**; they now use the shared one.

### Dev route, password route, client split (item 17-19, 28)

The dev parent-auth route asks the backend for the role of the session it just created
(admin, deleted or unconfirmed = refused; an unlinked parent = allowed, the bootstrap
provisions it); it is 404 unless dev auth is explicitly enabled and uses the Supabase Auth
Admin API only. The password route keeps the password inside Supabase Auth (no
Fastify/PostgreSQL handling); only the parent-only and session checks come from the backend.
`createServerSupabaseClient()` / `createBrowserSupabaseClient()` return
`Pick<SupabaseClient, "auth" | "storage">` and `createAdminSupabaseClient()` returns
`Pick<SupabaseClient, "storage">`: a database call does not compile. `SUPABASE_SECRET_KEY`
is read by exactly two modules (the Storage client, and the dev-only Auth Admin helper that
talks to `/auth/v1` only). `postgrest-retry.ts` (dead) is removed.

### Supabase RPC inventory (item 21)

Runtime `.rpc()` calls: **0** (at V0.1.51: 14; V0.1.52 removed 6; V0.1.53 removed the last 8).
Now unreferenced by any runtime code and kept only as history in `supabase/migrations`:
`bind_current_parent_referral_code`, `get_current_parent_referral_summary`,
`get_admin_referral_overview`, `get_admin_referral_relationships`,
`update_admin_referral_program_settings`, `update_homepage_content_trusted`,
`record_homepage_media_replacement_trusted`, `delete_homepage_media_trusted`,
`update_homepage_hero_layout_trusted`, `update_order_status_trusted`,
`record_final_media_trusted`, `approve_final_media_trusted`,
`supersede_final_media_trusted`, `get_order_status_history_admin`,
`get_parent_order_status_history`, `create_parent_request_trusted`,
`complete_candy_purchase_trusted` and the coupon/payment functions. Historical migrations
are not edited.

### Dependency report (item 31)

| | count | where |
|---|---|---|
| Supabase **Database** (table/RPC/PostgREST) at runtime | **0** | - |
| Supabase **Auth** call sites | 20 (12 files) | login/signup/admin-login/settings pages, logout, password, dev route, `supabase-identity-adapter`, `end-parent-session`, session-lifetime helpers, middleware `getUser` |
| Supabase **Storage** references | 16 (7 files) | `lib/storage/{final-deliverables,homepage-media,example-media,private-signed-url}`, `app/api/requests`, two browser public-URL builders |

### Global privilege matrix of `cartoona_app` (item 37)

SELECT-only tables (21): `candy_packages`, `candy_purchases`, `candy_wallets`, `characters`,
`coupon_package_rules`, `coupon_redemptions`, `coupons`, `creation_pricing`,
`drawing_animation_requests`, `examples`, `homepage_content`, `homepage_hero_layout`,
`homepage_media_assets`, `media_assets`, `order_status_history`, `orders`, `parent_profiles`,
`parent_welcome_credits`, `user_identities`, `users`, `video_requests` (+ column-level SELECT
`(id, purchase_id, status)` on `payment_attempts`). **No** INSERT / UPDATE / DELETE / TRUNCATE /
REFERENCES / TRIGGER on any of the 33 tables; the one column-level UPDATE is
`parent_profiles(full_name, updated_at)`. `internal_write_nonces`, `audit_logs`,
`referral_relationships`, `referral_program_settings(_history)`, `payment_*`, `candy_transactions`
are not directly writable (and the nonce table not even readable). EXECUTE on 32 of the 45
SECURITY DEFINER functions, all `*_trusted` or provisioning/nonce functions, none to PUBLIC:
financial (purchase/payment/coupon/request), fulfilment (status, final media, audit), referral
(summary, bind, admin overview/list/settings), CMS (homepage content/media/layout, examples) and the
identity ones (provision, consent, nonce). Pinned by `supabase-db-removal-db.test.ts`.

### Rejected / cancelled orders do not refund candies (item 29)

Unchanged and not fixed here. `update_order_status_trusted` has no financial effect: a request
that is rejected or cancelled after it was paid with candies keeps the debit (welcome credits
likewise). Business impact: a parent can lose candies on a request the team refuses. **Decision
required before any change**: refund on `rejected` only or also `cancelled`; who may cancel; full or
partial refund; welcome credits restored or not; one idempotent ledger credit (key
`order_refund:<id>`) inside the same transition. No balance was changed by this release.

### Rollback (HARD rule, item 30)

PostgreSQL is the source of truth for every business row. **Never roll back by re-enabling a
Supabase business writer** (request, purchase, referral, CMS, profile, fulfilment): the Supabase
copies are stale. Allowed: an older frontend only if it still talks to PostgreSQL-compatible
APIs, or a write freeze plus forward recovery. The Edge middleware of builds before V0.1.53 reads
Supabase `users`; do not run them against production data.

### Final cutover boundary (item 22)

Production cutover is: freeze writes -> V0.1.44 copy (Supabase -> PostgreSQL, pinned to the 19
migrations) -> verify -> start the new frontend/backend. After that every write is PostgreSQL's;
there is no dual write, no reverse sync and no continuing copy. Supabase keeps Auth and Storage
(bytes are not migrated; media rows carry the same keys).

### Verified locally (2026-10-25)

**Totals** (`CARTOONA_PLAIN_PG=docker`, run alone): 115 files (112 passed, 3 skipped files), **3303 passed**, 34
skipped (the opt-in suites that need a disposable Supabase project), 0 failed (V0.1.52: 3224 / 34).
`npm run lint`: 0 errors (29 pre-existing warnings; the one this release added was fixed). `next build`, `npm run backend:typecheck`,
`npm run backend:build` and `git diff --check`: clean. Repo-wide `tsc` reports only the known test-only errors; no runtime file has one.

| suite | tests | proves |
|---|---|---|
| `supabase-db-removal-db.test.ts` (real PostgreSQL 17, copy, restricted role, listening Fastify, Next handlers + page gates, stub Auth/Storage) | 36 | global privilege audit (no table writable; 32 audited EXECUTEs; nothing to PUBLIC; functions refuse a wrong role); role resolution for parent/admin/super_admin **ignoring a stub that claims admin**, deleted -> denied, unlinked -> bootstrap page, `sessions_not_before` -> session ended, outage -> unavailable; referrals (summary, bind idempotency, self/unknown/malformed, forged bodies, **14-way bind race -> one `bound`**, two-referrer race, 5/min limit, settings: parent 403, **6-way race -> one `updated`**, history, disabled program refuses binds, no wallet or ledger change); homepage (public anonymous read, revision races, structure, Next CSRF/409/422/403, media bytes+metadata+replace+revert, parents store nothing, hero layout, outage -> defaults); examples (parent stores nothing, create/publish/order/update/media swap/delete with Storage cleanup, key-namespace refusals, backend and function validation); brand-new user end to end and copied user and admin with **zero `/rest/v1` requests**; timings |
| `zero-supabase-db-static.test.ts` | 17 | the runtime tree has no `.rpc(`, no `.from(<schema table>)` (table names read from the migrations), no PostgREST, no role read; client types expose no database; the service credential is read in two modules and used for Storage only; the Auth Admin helper only talks to `/auth/v1`; the Edge reads nothing; signup/dev/password routes create no Supabase business state |
| `referral-cms-cutover-static.test.ts`, `page-gates.test.ts`, `backend-role.test.ts`, `homepage-backend-read.test.ts` | 10 + 11 + 14 + 8 | route auth and CSRF-first ordering, exact bodies and limits, admin gate before bytes, no reward effect; gate outcomes; role resolver mapping and fail-closed parsing; the anonymous homepage read and its degradation |
| ported | | middleware (auth-only), session-lifetime route tests, homepage tests (now data-based), legacy CSRF routes, static guard lists, schema parity (+4 target-only functions), privilege probes, consent gates (retry notice during an outage), migration pins (19) |

**Docker / headless browser proof** (real `Dockerfile`s tagged `proof053`, frontend + backend containers on the
compose network, scratch PostgreSQL 17 migrated through 0019 and populated by the real copy tool, stub Supabase
Auth/Storage and the stub payment provider on the host): **59/59 checks passed.** Anonymous: homepage and examples
render from PostgreSQL. New parent: sign-in provisions the account (profile, wallet, credits, identity, referral code
only in PostgreSQL), dashboard gate, referral page and binding (bound / already_bound / 409), purchase through the
provider stub, request, order detail with a signed preview, gallery - **zero requests to Supabase's `/rest/v1`
during the whole journey**. Copied parent: referral count, delivered order. Role boundaries: a parent opening
`/admin` or `/admin/requests` is sent to `/dashboard` with no admin markup; parent GET/PUT/PATCH/POST on the
homepage, examples, referral and CMS APIs are 403 and **no byte is stored**; signed-out visitors go to the right
login. Admin (email sign-in): every admin page renders; homepage saved (revision + 1, stale = 409); media bytes ->
Storage, metadata -> PostgreSQL, revert removes row and object; referral overview, settings (409 on a stale token);
example created with its image in Storage; fulfilment still works end to end. Public pages then show the new hero
title and the published example with its Storage URL (read-after-write). **Backend stopped:** the anonymous
homepage still renders (committed defaults), the examples page shows its unavailable card, a signed-in user gets
a retry message (no dashboard content, no login redirect, `/admin` shows no admin markup), and after the backend
returns the same session works. Hygiene: the Supabase stub saw only Auth and Storage calls, the browser contacted only
Next, the auth stub and the provider checkout, no assertion header or secret reached the browser.

Local timings (Docker, one machine, restricted role; NOT production estimates):

| path | median | p90 |
|---|---|---|
| role resolution (provider verify + `/v1/auth/me`) | 4.8 ms | 5.7 ms |
| referral summary (backend) | 3.6 ms | 4.4 ms |
| referral bind (backend, fresh parents) | 4.7 ms | 5.0 ms |
| homepage public read (backend) | 2.9 ms | 3.4 ms |
| examples public read (backend) | 2.6 ms | 3.1 ms |
| admin examples read / write (backend) | 3.7 / 5.3 ms | 5.9 / 17.2 ms |
| new-user bootstrap (`account-setup` route) | 7.2 ms | 16.8 ms |
| anonymous homepage page (browser fetch, SSR + backend, 20x) | 26.9 ms | 127 ms |
| anonymous examples page (same) | 14.9 ms | 52.5 ms |

### Production status

**Not deployable.** Unchanged blockers: no real payment provider adapter (only the refused-in-production
stub); the `amr` check against real Supabase tokens (the session-start model is not verified with real
tokens); a real `pg_dump`/production export rehearsal (fixtures only); backend deployment; Storage still
Supabase (its service credential signs final deliverables and stores CMS bytes). New for rehearsal: the
Supabase `handle_new_user` trigger and Storage policies that read Supabase tables are now irrelevant to the
app but still exist there; admin accounts must exist in PostgreSQL (`users.role`) because Supabase
roles are no longer read anywhere.

## Next

V0.1.54: production rehearsal prerequisites - a real export copy rehearsal, the `amr` check, the payment
provider adapter, backend deployment and a refund-policy decision; then Storage bytes.
