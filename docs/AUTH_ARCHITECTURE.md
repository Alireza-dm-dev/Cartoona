# Auth architecture (V0.1.42)

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

## The chain

```
Browser ── session cookie (Supabase) ──> Next.js server
  │                                          │
  │                       lib/auth/supabase-identity-adapter.ts
  │                         getUser(): server round trip to the provider,
  │                         ONE 4 s deadline (refreshes included)
  │                                          │ VerifiedIdentity { provider: "supabase", subject: <auth uid> }
  │                       lib/backend/client.ts + lib/identity/assertion.ts
  │                         signs a 30 s assertion bound to method + path + request id
  │                                          │ X-Cartoona-Internal-Auth: v1.<payload>.<HMAC>   (server-to-server only)
  │                                          v
  │                                   Fastify  backend/src/plugins/auth.ts
  │                                     verify MAC (constant time), expiry, binding
  │                                     user_identities(provider, subject) ──> users.id, users.role
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
v1.<base64url(JSON)>.<base64url(HMAC-SHA256(secret, "cartoona-internal-auth\nv1\n" || payload))>
payload = { v: 1, prv: "supabase", sub, iat, exp, rid, mth, pth }   exactly these keys
```

| Rule | Value |
|---|---|
| Algorithm | HMAC-SHA256 with a fixed context prefix, compared with `crypto.timingSafeEqual` before the payload is parsed |
| Key | `CARTOONA_INTERNAL_AUTH_SECRET`: 64–256 hex chars (≥ 32 bytes), `openssl rand -hex 32`, no default |
| Lifetime | issued for 30 s; anything longer than 60 s is rejected even if correctly signed |
| Clock skew | `iat` up to 5 s in the future is accepted; beyond that it is `not_yet_valid` |
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
| Session rejected by the provider / assertion invalid, expired, rebound, forged | 401 `unauthenticated` | 401 `unauthenticated` | `AUTH_INVALID` |
| Provider unreachable or too slow (4 s) | **503** `auth_unavailable`, session kept | n/a | `AUTH_UNAVAILABLE` |
| Valid identity, no Cartoona mapping | 403 `identity_not_linked` | 403 `identity_not_linked` | `IDENTITY_NOT_LINKED` |
| Linked account soft-deleted / role not allowed | 403 `forbidden` | 403 `forbidden` | `AUTH_FORBIDDEN` |
| Backend rejects an assertion Next just signed (secret mismatch, clock) | 503 `service_unavailable` | 401 | `AUTH_UNAVAILABLE` / `assertion_rejected` |
| Database down, secret missing | 503 | 503 `service_unavailable` | `AUTH_UNAVAILABLE` |

A provider outage is never treated as a sign-out: the session cookie is never
cleared, and there is no automatic redirect to login. Logs carry the request
id, the category and a coarse reason. They never contain the assertion,
signature, subject, user id, tokens, cookies, email or phone.

## Identity mapping and bootstrap

`user_identities(provider, provider_subject) UNIQUE → users.id`
(`database/migrations/0003_identity.sql`). There is no foreign key to
`auth.users`.

**Existing users (migration backfill).** Cartoona ids were created from the
Supabase auth uid by the `on_auth_user_created` trigger, so every migrated user
keeps their id and gets one identity row:

```sql
-- After the users data copy, in the same maintenance window. Idempotent.
INSERT INTO public.user_identities (user_id, provider, provider_subject)
SELECT u.id, 'supabase', u.id::text
FROM public.users u
ON CONFLICT (provider, provider_subject) DO NOTHING;

-- Verify: every user has exactly one supabase identity, and it is their own id.
SELECT count(*) FROM public.users u
LEFT JOIN public.user_identities i ON i.user_id = u.id AND i.provider = 'supabase'
WHERE i.id IS NULL OR i.provider_subject <> u.id::text;   -- expect 0
```

This is proven locally on fixtures in `tests/unit/auth-chain-db.test.ts`. No
production data has been copied.

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

## Session lifetime: replacement decision

**Today:** `checkCurrentParentSessionLifetime` calls the Supabase RPC
`get_current_parent_session_policy`, which uses `auth.uid()`,
`auth.jwt() ->> 'session_id'` and `auth.sessions.created_at` to enforce a
30-day **absolute** lifetime. It has 15 call sites: middleware, 12 API
routes, `complete-request` and `ParentRequestContext`. It cannot exist on
plain PostgreSQL.

| Option | Absolute lifetime | Idle timeout | Forced invalidation | Cost |
|---|---|---|---|---|
| A. Provider expiry only | no: refresh tokens keep a session alive indefinitely | no | provider sign-out only | none |
| B. Cartoona session table | yes | yes | yes | a write on every sign-in and a read per request; a second session system |
| C. Signed application session over the provider | yes | possible | needs a deny list | a second cookie and its own refresh |
| **Chosen: A + the verified sign-in time + `sessions_not_before`** | **yes** | not required today | **yes** | one claim check, one column |

The decision is to enforce the policy at the Next adapter boundary, from
verified provider data, with no session table:

- **Absolute 30 days.** Supabase access tokens carry `amr[].timestamp` (when
  the user authenticated) and `session_id`. The adapter verifies the JWT
  (`auth.getClaims()`), takes the earliest `amr` timestamp as the session
  start, and refuses sessions older than 30 days. That is the same rule as the
  RPC, without `auth.sessions`.
- **Forced invalidation.** Add `users.sessions_not_before timestamptz`.
  A session whose sign-in time is earlier than this is refused. "Sign out
  everywhere" or an account lock then needs no provider API. The provider's
  own global sign-out also still works, because `getUser()` is a server round
  trip and rejects revoked sessions.
- **Idle timeout** is not a current requirement (the existing policy is
  absolute only). Add it later only if needed; that would be option B.

This is **not implemented in V0.1.42.** The 15 existing call sites keep the RPC
until their routes move. Implementing it touches every parent route and is its
own change, the next auth step. It requires a test that the `amr` timestamp
survives refresh in the target Supabase project.

## The ~26 s expired-session stall

**Where it was.** A cookie holding an **expired** access token makes
`getUser()` refresh first. auth-js retries a retryable refresh failure with
backoff (200 ms × 2ⁿ) inside a 30 s budget (`AUTO_REFRESH_TICK_DURATION_MS`).
Each attempt is bounded by the 10 s per-request timeout, but the loop of
attempts is not. With the provider down, three paths waited:

| Path | Who | Before (measured, local stub provider) | Now |
|---|---|---|---|
| Public header lookup (`getPublicHeaderAccount`, every marketing and creation page with a session cookie) | everyone with an expired cookie | **25.5 s** (refresh fails fast, 8 attempts), **30.6 s** (refresh hangs) | **≤ 2.5 s**, then the anonymous header |
| Middleware (`/dashboard`, `/admin`, `/complete-request`, `/parent-consent`) | protected pages | ~26–30 s, then 503 | **≤ 10 s**, then the same retryable 503 |
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
- The middleware deadline is 10 s, the existing single-attempt bound, so no
  refresh is abandoned earlier than before; only the useless retries are
  dropped.
- A refresh that succeeds after the deadline is not written back. This was
  already true for public pages (Server Components cannot set cookies) and for
  any attempt past the old 10 s per-request timeout. Supabase's refresh-token
  reuse interval covers a prompt retry. The 4 s adapter deadline makes this
  possible for refreshes taking 4–10 s on BFF routes. That is an accepted
  trade-off for a bounded response, and it is limited today to the proof
  route.

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
