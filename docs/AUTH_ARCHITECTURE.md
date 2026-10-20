# Auth architecture (V0.1.42; session policy V0.1.43)

**Supabase Auth is the temporary identity provider, and nothing more.** It
answers one question: which external account owns this session. Everything
Cartoona decides about that account (who the user is in Cartoona, their role,
what they own, whether they may act) comes from Cartoona's own PostgreSQL,
through code that never trusts the browser.

> **Status:** the identity chain is built and proven end to end, but **no
> business route uses it yet**. Every page and API route except
> `/api/creation-pricing` still authenticates and reads exactly as before
> (Supabase session, `public.users` and RLS in Supabase). The new pieces are
> the auth adapter, the internal assertion, `/v1/auth/me`, the proof route
> `/api/auth/backend-me`, and bounded deadlines on two existing auth paths.
> Since V0.1.43, Cartoona's own session policy (30-day absolute lifetime and
> `users.sessions_not_before`) replaces the Supabase-internal lifetime RPC
> everywhere: no runtime code reads `auth.sessions` or `auth.jwt()` any more.

## The chain

```
Browser ── session cookie (Supabase) ──> Next.js server
  │                                          │
  │                       lib/auth/supabase-identity-adapter.ts
  │                         getSession() -> getUser(<that token>): ONE provider round trip
  │                         verifies the exact token; amr -> sign-in time; 30-day check
  │                         ONE 4 s deadline (refreshes included)
  │                                          │ { identity: { provider, subject }, authenticatedAt }
  │                       lib/backend/client.ts + lib/identity/assertion.ts
  │                         signs a 30 s v2 assertion: subject + sign-in time, bound to method + path + request id
  │                                          │ X-Cartoona-Internal-Auth: v2.<payload>.<HMAC>   (server-to-server only)
  │                                          v
  │                                   Fastify  backend/src/plugins/auth.ts
  │                                     verify MAC (constant time), expiry, binding
  │                                     user_identities(provider, subject) ──> users.id, role, sessions_not_before
  │                                     session policy: 30 days + sessions_not_before (same query)
  │                                          │ request.authPrincipal { userId, role }
  │                                          v
  │                                   route ──> repositories with explicit ids
  └── never sees the assertion, the secret or the backend address
```

| Piece | File | Knows about |
|---|---|---|
| Neutral types | `lib/identity/types.ts` | `ExternalIdentity`, `VerifiedIdentity` (branded), `AuthPrincipal`, `PrincipalRole`, the provider allow-list |
| Assertion | `lib/identity/assertion.ts` | `node:crypto` only; shared by Next and Fastify |
| Supabase adapter | `lib/auth/supabase-identity-adapter.ts` | Supabase SDK; server-only; **no** database, tables, roles or profiles |
| Deadline helpers | `lib/auth/auth-deadline.ts` | one total budget for an auth check |
| Session policy | `lib/identity/session-policy.ts` | pure: evidence + policy + clock -> valid / expired / invalidated |
| Session evidence | `lib/auth/supabase-session-evidence.ts` | Supabase claim layout (`amr`) -> sign-in time; decode only, after verification |
| Lifetime for Supabase-backed routes | `lib/auth/parent-session-lifetime.ts` | `checkParentSessionLifetime(supabase, verifiedUserId)`, no network call |
| Identity resolution | `lib/repositories/user-identities.ts` | parameterised SQL; read-only |
| Backend auth | `backend/src/plugins/auth.ts` | `requireAuth`, `requireRole`; reads one header |
| Proof endpoints | `backend/src/routes/auth.ts` (`GET /v1/auth/me`), `app/api/auth/backend-me/route.ts` | minimal `{ authenticated, userId, role }` |

## What the backend never trusts

- **No browser identity.** `X-User-Id`, `X-Role`, cookies, `Authorization`,
  query or body identity are never read. The auth plugin reads exactly one
  header, and static tests pin that.
- **No provider calls.** Fastify has no Supabase variable and never contacts
  the provider. It trusts only a signature made with the shared secret.
- **No role from outside.** The assertion carries no role and no Cartoona user
  id. The role comes from `public.users`. A role change in PostgreSQL is what
  the next request sees, and this is tested.
- **No auth.uid(), auth.jwt() or auth.sessions.** None of these is used on the
  new path; tests check this.

## Internal assertion

```
v2.<base64url(JSON)>.<base64url(HMAC-SHA256(secret, "cartoona-internal-auth\nv2\n" || payload))>
payload = { v: 2, prv: "supabase", sub, aat, iat, exp, rid, mth, pth }   exactly these keys
```

**v2 (V0.1.43)** adds `aat`, the provider-verified sign-in time (unix seconds).
It is signed like every other field, so a forged, younger sign-in time fails
the MAC. **v1 is rejected** (`unsupported_version`): it carries no session
evidence, so it cannot be checked against the policy. Next and the backend
deploy together, so there is no mixed-version window to support.

| Rule | Value |
|---|---|
| Algorithm | HMAC-SHA256 with a fixed context prefix, compared with `crypto.timingSafeEqual` before the payload is parsed |
| Key | `CARTOONA_INTERNAL_AUTH_SECRET`: 64–256 hex chars (≥ 32 bytes), `openssl rand -hex 32`, no default |
| Lifetime | issued for 30 s; anything longer than 60 s is rejected even if correctly signed |
| Clock skew | `iat` up to 5 s in the future is accepted; beyond that it is `not_yet_valid` |
| Sign-in time | `aat`: positive whole seconds, never more than 5 s after `iat` |
| Binding | `mth` and `pth` must equal the request's method and path (query string excluded) |
| Request id | `rid` must be a safe request id; the same id as the call's `X-Request-Id` |
| Provider | allow-list (`supabase`); the subject must match the provider's id shape (UUID) |
| Contents | no email, phone, names, profile data, provider tokens, Cartoona id or role |
| Header | `X-Cartoona-Internal-Auth`, sent only by `lib/backend/client.ts`, server-to-server |

**Replay.** Within its ≤ 60 s life an assertion is a bearer value, but only for
one method and one path, and it only ever travels between the Next server and
the backend on the private network. There is no replay cache: that would need
shared state such as Redis, which is out of scope. Every route that accepts an
assertion today is an idempotent GET. Before a non-idempotent route relies on
assertions, add a one-time nonce: a `jti` stored for 60 s, for example in
PostgreSQL.

**Secret handling.**

- The frontend and backend containers both receive this one secret. They
  share nothing else: the frontend has no database credentials, and the
  backend has no Supabase variables.
- It is never `NEXT_PUBLIC_*` and never a build arg.
- Only `lib/identity/assertion.ts` reads it.
- It is never logged; error messages name the variable, never its value.
- The backend refuses to start without a valid secret.
- **Rotation:** change it on both services together. Requests already in
  flight fail with a 503 for at most the 30 s assertion lifetime.

## Failure semantics

| Situation | Next proof route | Fastify | Log category |
|---|---|---|---|
| No session | 401 `unauthenticated` (backend not called) | 401 `unauthenticated` | `AUTH_MISSING` |
| Session rejected by the provider / assertion invalid, expired, rebound, forged, v1 / no usable sign-in evidence (`amr`) | 401 `unauthenticated` | 401 `unauthenticated` | `AUTH_INVALID` |
| Signed in ≥ 30 days ago | 401 `session_expired` (no assertion is signed) | 401 `session_expired` | `SESSION_EXPIRED` |
| Signed in before `users.sessions_not_before` | 401 `session_invalidated` | 401 `session_invalidated` | `SESSION_INVALIDATED` |
| Provider unreachable or too slow (4 s) | **503** `auth_unavailable`, session kept | n/a | `AUTH_UNAVAILABLE` |
| Valid identity, no Cartoona mapping | 403 `identity_not_linked` | 403 `identity_not_linked` | `IDENTITY_NOT_LINKED` |
| Linked account soft-deleted / role not allowed | 403 `forbidden` | 403 `forbidden` | `AUTH_FORBIDDEN` |
| Backend rejects an assertion Next just signed (secret mismatch, clock) | 503 `service_unavailable` | 401 | `AUTH_UNAVAILABLE` / `assertion_rejected` |
| Database down, backend unreachable, secret missing | 503 `service_unavailable` | 503 `service_unavailable` | `AUTH_UNAVAILABLE` |

On the Supabase-backed routes (middleware and the 13 route and page callers),
the existing contract is unchanged: an expired session signs out locally,
then 401 or a login redirect with `reason=session_expired`. A failed session
read is a retryable 503 and never a sign-out.

A provider outage is never treated as a sign-out: the session cookie is never
cleared, and there is no automatic redirect to login. Logs carry the request
id, the category and a coarse reason. They never contain the assertion,
signature, subject, user id, tokens, cookies, email or phone.

## First business route (V0.1.45)

`GET /v1/parent/orders` is the first business route behind this chain:
`requireAuth` → `requireRole("parent")` → profile from `principal.userId`.
Its Next callers (`GET /api/parent/orders` and the `/dashboard/orders` first
page) use `verifySupabaseIdentity` and the backend client exactly as
`/api/auth/backend-me` does, and map the outcomes in the same way:

- a definite `session_expired` or `session_invalidated` clears the session
  cookies with a bounded local sign-out;
- `auth_unavailable`, a backend outage, or our own assertion being rejected
  is a 503 that never signs anyone out.

See [ROUTE_CUTOVER.md](ROUTE_CUTOVER.md#v0145-parent-orders-list). The `amr`
pre-production check below still blocks any production use.

## Identity mapping and bootstrap

`user_identities(provider, provider_subject) UNIQUE → users.id`
(`database/migrations/0003_identity.sql`). There is no foreign key to
`auth.users`.

**Existing users (migration backfill, V0.1.44).** Cartoona ids were created
from the Supabase auth uid by the `on_auth_user_created` trigger, so every
migrated user keeps their id and gets one identity row. The data-copy tool
writes it (`scripts/db/data-copy/identity.ts`, [DATA_MIGRATION.md](DATA_MIGRATION.md#identity-backfill)):
`('supabase', users.id::text) → users.id`, with a derived row id and
`created_at = users.created_at`, so it is deterministic. A subject mapped to a
different user, or a user with a second supabase subject, is refused with
nothing written; there is no `ON CONFLICT DO NOTHING` that could hide one.
Deleted users get their row too and are still refused (403) on `deleted_at`.

Proven locally on a copied Supabase-shaped fixture in
`tests/unit/data-copy-db.test.ts` (requireAuth → copied user and role; deleted
→ 403; unknown subject → `identity_not_linked`). No production data has been
copied. The copy does not depend on the open `amr` check below, but production
cutover does.

**No silent creation.** A verified identity with no mapping is
`identity_not_linked`. Reads never create users or identities, and
`cartoona_app` has no INSERT on either table.

**New signups (later, when signup moves).** One transaction, run by a trusted
backend function, creates:

1. `users`;
2. `user_identities('supabase', <auth uid>)`;
3. `parent_profiles`;
4. the wallet and welcome credits, through the existing triggers.

It is idempotent on `(provider, subject)`. Until then, signup stays on
Supabase (the `on_auth_user_created` trigger plus `ensureParentProfile`).

## Session policy (V0.1.43)

**Replaces** `get_current_parent_session_policy`, a Supabase RPC that read
`auth.uid()`, `auth.jwt() ->> 'session_id'` and `auth.sessions.created_at`.
It cost one extra round trip per protected request and could not exist on
plain PostgreSQL. No runtime code references any of these any more, and a
static test enforces that. The historical Supabase migrations are untouched.

**Rules** (`lib/identity/session-policy.ts`, pure, UTC epoch ms, clock
injected):

| Outcome | Condition |
|---|---|
| `expired` | `now >= authenticatedAt + 30 days` |
| `invalidated` | `authenticatedAt < ceil_to_second(sessions_not_before)`; never when NULL. Equality is **valid**. Checked before expiry. |
| `invalid_evidence` | sign-in time missing, non-positive, non-finite, or more than 5 s in the future |
| `valid` | otherwise, with `expiresAt = authenticatedAt + 30 days` |

Why the cut-off rounds up: provider sign-in times are whole seconds. A session
that began in the same second as an invalidation could have started before
it, so it is refused (the user signs in once more), never allowed to survive.

There is no idle timeout. The previous policy had none (absolute only), and
none is required now.

### Where `authenticatedAt` comes from

| Candidate | Verdict |
|---|---|
| `iat` | **Rejected**: every refresh issues a new token with a new `iat`, so a refreshed session would never expire. |
| `session_id` | Stable across refreshes, but carries no time. |
| `amr[].timestamp` | **Used.** "Authentication Methods References": one entry per method the user authenticated with in this session, `timestamp` = "when the method was successfully used" (auth-js 2.110 types). The provider keeps these per session and puts the same entries into every token of that session; refresh is not an authentication method (it is absent from auth-js's AMR method list). |

`authenticatedAt = min(amr[].timestamp) × 1000`
(`lib/auth/supabase-session-evidence.ts`). The minimum means a later step-up
factor added to the same session can never move the start forward. Entries
named `token_refresh` are ignored defensively. **Fail closed:** no `amr`, a
string-only `amr` (no timestamps) or a malformed token means no evidence, so
the user signs in again. That is never treated as "valid without a lifetime".

**Verification.** Claims are read only from a token the provider has just
accepted:

- **BFF adapter.** It calls `getSession()` (which refreshes if needed; a
  refresh response comes from the provider itself), then
  `getUser(<that exact token>)`, then reads the claims. `sub` must equal the
  verified user. This is one provider round trip, the same trust rule
  `auth.getClaims()` itself uses for symmetric keys. `getClaims()` is not used
  directly: with asymmetric keys it verifies locally and would not detect a
  revoked session.
- **Supabase-backed routes** (`checkParentSessionLifetime`). Every caller has
  just run `getUser()` on the same client in the same request, which verified
  the stored token. The check then reads that stored session locally and
  requires `sub` to match the verified user. No network call: the old RPC
  round trip is gone.

**Refresh never extends the lifetime.** This is proven against the real
auth-js with a stub provider that issues refreshed tokens with a new `iat` and
the same `amr`:

- the refreshed token has a new `iat`, and `authenticatedAt` is unchanged;
- a session one minute from 30 days, refreshed, expires on time;
- the same holds end to end through the backend.

> **Pre-production check: NOT YET VERIFIED against a real Supabase project
> (open blocker).** The `amr` design rests on the SDK's documented claim
> layout (auth-js 2.110 types: `amr[]` entries of `{ method, timestamp }`) and
> is proven against a local stub that issues tokens in that layout. It has
> **not** been confirmed against real Supabase tokens. On 2026-10-17 the only
> permitted project (the disposable one) was unreachable: requests to it fail
> at the TLS handshake while other hosts work, which is consistent with a
> paused project. Production is never used for this check.
>
> To close the blocker, once the disposable project is restored, with a test
> account and **sanitised output only** (no tokens, ids, phone or session id):
>
> 1. Sign in with each method Cartoona uses (phone OTP; password where
>    enabled). Record: is `amr` present, is it an array of objects, how many
>    entries, which `method` values, does each have a numeric `timestamp`.
> 2. Record the earliest timestamp, refresh through the normal supported flow,
>    and confirm `iat` changed while the earliest `amr` timestamp did not.
> 3. Confirm no custom access-token hook rewrites `amr`.
>
> If any of these fails, do not ship this design: the fallback is a
> Cartoona-owned first-seen time per provider `session_id`, which needs a
> write path. Until it passes, the branch is **not production-deployable**.
> If `amr` is absent or untimestamped, the effect is fail-closed (every user
> is asked to sign in again), never an unlimited session.

### `users.sessions_not_before` (migration 0011)

- **Meaning.** Every session that signed in before this instant is invalid.
  NULL means no forced invalidation.
- **Where it's enforced.** The backend checks it in `requireAuth`, from the
  same identity-resolution query, so there is no extra round trip. That covers
  every backend-authenticated request.
- **Existing users.** Existing and copied users start NULL. Every current
  session therefore stays valid, except those already past 30 days, which
  were already invalid under the old RPC.
- **Supabase-backed routes.** Routes that still run on Supabase (no
  PostgreSQL data yet) enforce the 30-day rule only, as before. Their forced
  logout remains the provider's global sign-out, which `getUser()` detects.
  Each route gains `sessions_not_before` as it moves to the backend.
- **Writing it (designed, not built).** A future trusted, audited function
  will do the write:

  ```sql
  -- invalidateAllUserSessions(userId): one statement, idempotent.
  UPDATE public.users SET sessions_not_before = now() WHERE id = $1;
  ```

  Uses: "log out all devices", a security incident, and a password change or
  reset. **`cartoona_app` has no UPDATE on `users`**; this is verified, and
  the write privilege arrives with that function in a later write-security
  migration. Local tests set the column as the owner.

### Next before signing

The BFF adapter evaluates the 30-day rule before anything is signed. **An
expired session never receives an assertion.** `sessions_not_before` lives in
PostgreSQL, and the frontend has no database access. So the backend applies
it in `requireAuth`, from the signed `aat` and the resolved cut-off, before any
principal exists. An invalidated session's assertion is therefore refused and
never reaches a route.

Designs compared:

- **A.** The backend resolves both, but Next has no evidence to send.
- **B.** An extra auth round trip.
- **C (chosen).** `aat` goes in the signed assertion, and the backend
  evaluates it in the query it already runs.

## The ~26 s expired-session stall

**Where it was.** A cookie holding an **expired** access token makes
`getUser()` refresh first. auth-js retries a retryable refresh failure with
backoff (200 ms × 2ⁿ) inside a 30 s budget (`AUTO_REFRESH_TICK_DURATION_MS`).
Each attempt is bounded by the 10 s per-request timeout, but the loop of
attempts is not. With the provider down, three paths waited:

| Path | Who | Before (measured, local stub provider) | Now |
|---|---|---|---|
| Public header lookup (`getPublicHeaderAccount`, every marketing and creation page with a session cookie) | everyone with an expired cookie | **25.5 s** (refresh fails fast, 8 attempts), **30.6 s** (refresh hangs) | **≤ 2.5 s**, then the anonymous header |
| Middleware (`/dashboard`, `/admin`, `/complete-request`, `/parent-consent`) | protected pages | ~26–30 s, then 503 | **≤ 5 s** (V0.1.43; 10 s in V0.1.42), then the same retryable 503 |
| New auth adapter (`/api/auth/backend-me`, future BFF routes) | authenticated BFF routes | n/a | **≤ 4 s**, then 503 `auth_unavailable` |

The baseline is reproducible with
`CARTOONA_MEASURE_AUTH_STALL=1 npx vitest run tests/unit/supabase-identity-adapter.test.ts -t baseline`.

**How it's fixed, without weakening auth or patching auth-js:**

- The caller stops waiting at the deadline (`withDeadline`).
- The client's fetch refuses to send anything after the deadline
  (`createDeadlineFetch`). It **throws**, and auth-js turns a fetch exception
  into a *retryable* error, which keeps the session. A fake HTTP error would
  be non-retryable, and auth-js answers a non-retryable refresh failure on an
  expired token by deleting the session (`_removeSession`), which would turn
  an outage into a sign-out. Tests assert that the cookie is never cleared and
  that no network call happens after the deadline.
- In middleware, all Auth calls of the request share one **5 s** budget
  (`createAuthDeadlineFetch`). Its PostgREST role lookup keeps its own bound,
  so a slow sign-in check cannot starve it.
- A refresh that succeeds after the deadline is not written back. This was
  already true for public pages (Server Components cannot set cookies) and for
  any attempt past the old 10 s per-request timeout. Supabase's refresh-token
  reuse interval covers a prompt retry (the 503 says "reload", with
  `Retry-After: 2`). The 5 s middleware and 4 s adapter deadlines make this
  possible for refreshes slower than that. That is an accepted trade-off for a
  bounded response: a much tighter budget would make it common on slow mobile
  links, which is why middleware stops at 5 s.

**No auth on public pages beyond the header.** Middleware runs only for the
four protected prefixes (pinned by a test). Public routes never call the
adapter.

## Provider replacement path

To replace Supabase Auth:

1. Write a new adapter that produces a `VerifiedIdentity` with a new
   `provider` value, and add that value to `IDENTITY_PROVIDERS`.
2. Link existing users by inserting `user_identities(newProvider, subject)`
   rows alongside the `supabase` ones. Users keep their Cartoona ids.
3. The backend, assertion format, repositories and roles do not change.
4. Remove the `supabase` rows when the old provider is gone.

## Session-lifetime caller audit (V0.1.43)

Every former caller now uses `checkParentSessionLifetime(supabase, verifiedUserId)`.
It runs after `getUser()` (or after the ownership check, which ran `getUser()`).
Its results, and each caller's reaction, are unchanged:
- **valid:** continue;
- **expired / missing_session:** local sign-out, then 401 or a login redirect;
- **lookup_failed:** retryable 503, no sign-out.

| Kind | Caller | Runs after | On expiry | On lookup failure |
|---|---|---|---|---|
| middleware | `middleware.ts` (`/dashboard*`, `/complete-request`, `/parent-consent`; not `/admin`) | getUser + role | local signOut, redirect `/login?reason=session_expired` | 503 `sessionCheckUnavailable` |
| parent auth helper | `lib/parent/parent-request-context.ts` (`verify: "full"`, the orders API) | getUser; in parallel with the role and profile reads | `session_invalid`: 401 + signOut | `session_invalid`: 503 |
| server component | `app/(auth)/complete-request/page.tsx` | getUser + role | redirect `/login?reason=session_expired` (no sign-out, as before) | in-page retry message, no redirect |
| route handlers (11 files, 12 calls) | `api/candy-purchases` (GET and POST), `candy-purchases/[id]/complete`, `candy-purchases/[id]/coupon`, `coupons/validate`, `parent-consent`, `parent/gallery`, `parent/password`, `referrals`, `referrals/bind`, `requests` | getUser + role | `createParentSessionFailureResponse`: 401 + signOut | 503 `SESSION_CHECK_UNAVAILABLE` |
| route handler | `api/parent/orders/[orderId]/final-media` | ownership check (its own getUser), with `ownership.userId` | same | same |
| admin | none: admin paths never had the lifetime check | n/a | n/a | n/a |

**Round trips.**
- **Protected middleware request:** was `getUser` + role read + lifetime RPC,
  3 sequential provider calls. Now it is `getUser` + role read, 2. The
  lifetime check is local.
- **Each route and the full request context:** one network call fewer.
- **Duplicate verification:** middleware and then the page both still call
  `getUser()` on `/dashboard`. That is unchanged and is left for the
  request-context rewrite at cutover.

## Audit (V0.1.42, before any change)

- **Verification:** 35 `auth.getUser()` calls in 33 files. No handler calls it
  twice. The duplication is across layers: a `/dashboard` request is verified
  by middleware and then again by the page's `ParentRequestContext`, which is
  two provider round trips per protected page. API routes are not covered by
  middleware's matcher, so they verify only once, themselves. The future BFF
  adapter verifies once per request and forwards the result as an assertion.
- **Supabase uid = Cartoona user id:** 29 files look the user up with
  `.eq("id", user.id)` or `.eq("user_id", user.id)` on `users` or
  `parent_profiles`. This holds because the `on_auth_user_created` trigger
  creates `public.users` with the auth uid. Each must use the resolved
  `principal.userId` when its route moves.
- **Role lookups:** 25 files read `users.role` through the session client
  (RLS: own row).
- **Profile lookups:** 15 files read `parent_profiles` by `user_id`.
- **auth.sessions / auth.jwt():** only `get_current_parent_session_policy`
  (15 call sites through `checkCurrentParentSessionLifetime`).
- **Session-bound RPCs:** the parent and admin flows still call ~20 RPCs
  (`create_parent_request_trusted`, `complete_candy_purchase_trusted`,
  referral, coupon and admin functions) through the session client, whose
  Supabase versions read `auth.uid()`. Their plain-PostgreSQL ports take
  explicit actor ids (V0.1.38).
- **Refresh:** cookies are refreshed and written only by middleware (protected
  pages) and by Route Handlers. Server Components cannot write cookies, so
  public pages never persist a refresh.
- **Signup:** the phone OTP is handled by Supabase, and the
  `on_auth_user_created` trigger inserts `public.users`. Then
  `POST /api/parent/complete-signup` calls `ensureParentProfile` (profile,
  plus the wallet and welcome credits through triggers).
