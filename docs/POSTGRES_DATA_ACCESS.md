# PostgreSQL data-access layer (V0.1.39)

A small, framework-free layer for the plain-PostgreSQL schema in
`database/migrations` ([PLAIN_POSTGRES.md](PLAIN_POSTGRES.md)): one `pg` pool,
a transaction helper, error normalisation, and read repositories that take an
explicit actor.

> **Status: used by the backend only.** No Next.js route, page, middleware or
> health check imports `lib/db` or `lib/repositories`, and a static test
> enforces it; the Fastify backend (`backend/`) does. Since V0.1.41 one
> frontend route, `GET /api/creation-pricing`, reaches PostgreSQL through that
> backend ([ROUTE_CUTOVER.md](ROUTE_CUTOVER.md)). Everything else is still
> served by Supabase (database, Auth and Storage).

## Layout

| Module | Role |
|---|---|
| `lib/db/pool.ts` | `getPool()` (lazy, one per process), `closePool()`, `readPoolConfig(env)` |
| `lib/db/types.ts` | `Queryable`: the `query(text, values)` interface both the pool and a transaction client satisfy |
| `lib/db/query.ts` | `runQuery(db, SQL, values)`: runs one parameterised statement and normalises errors |
| `lib/db/transaction.ts` | `withTransaction(work)` |
| `lib/db/errors.ts` | `DbError`, `DbConfigError`, `normalizePgError`, `isBusinessError`, `describeDbError` |
| `lib/db/health.ts` | `pingDatabase()`: `SELECT 1` readiness probe that never throws |
| `lib/repositories/*.ts` | Read repositories (below) |

Only `pg` and plain TypeScript are used: no `next/*`, `server-only`, React or
Supabase imports, so a future Fastify backend can use these modules unchanged.
The one host-specific detail is the `@/` import alias, which a Fastify build
resolves through `tsconfig` paths. `server-only` is deliberately not imported,
because it throws outside a Next.js server bundle. `pg` cannot be bundled
into client code anyway, since it needs `net`, and Next 16 already treats it as
a server-external package.

## Connection and pool

`DATABASE_URL` is read at the first `getPool()` call, never at import or build
time. A missing or unsafe value throws `DbConfigError` at that point. The
error message never contains the URL or password.

| Context | `DATABASE_URL` host |
|---|---|
| Container on the compose network (future backend) | `postgres:5432` |
| This Mac (tests, scripts) | `localhost:5433` / `127.0.0.1:5433` |

The URL is refused when:

- it is missing;
- it is not `postgres://` or `postgresql://`;
- it has no host or database;
- it has query parameters, which can redirect `host=` or `options=`;
- it points at hosted Supabase, or names a known Cartoona project ref.

The Supabase rule matters because `DATABASE_URL` used to mean "the Supabase
direct connection string" (older `.env` examples). The plain schema shares
table names with Supabase's, so a stale value would silently run these
repositories against hosted Supabase, as the owner and without RLS.

| Setting | Default | Env override | Why |
|---|---|---|---|
| `max` | 5 | `DB_POOL_MAX` (1–50) | PostgreSQL defaults to 100 connections, shared by every app replica, the future backend, migrations and psql. Reads are short, and the busiest page issues about 3 queries. |
| `idleTimeoutMillis` | 30 000 | `DB_IDLE_TIMEOUT_MS` | Returns idle server connections. |
| `connectionTimeoutMillis` | 5 000 | `DB_CONNECTION_TIMEOUT_MS` | pg's default is to wait forever. Fail fast when the DB is down or the pool is exhausted. |
| `statement_timeout` | 15 000 | — | Bounds a runaway statement. |
| `application_name` | `cartoona` | — | Identifies the app's sessions in `pg_stat_activity`. |

The pool is stored on `globalThis`, so Next.js dev hot reloads reuse it
instead of leaking a new one. An idle-client `error` is logged with safe
fields only (kind, SQLSTATE) so it cannot crash the process. No signal
handlers are installed. The host calls `closePool()` on shutdown, for example
from Fastify's `onClose`.

## Transactions

`withTransaction(async (tx) => { ... })` runs BEGIN, the work, then COMMIT,
all on one pooled client.

- On any error, including a failed COMMIT, it issues ROLLBACK and rethrows
  the **original** error, unwrapped.
- The client is always released. If ROLLBACK itself fails, the client is
  destroyed (`release(err)`) instead of being reused.
- `tx` is a `Queryable`, so the work cannot release the connection or reach
  the pool.
- There are no nested transactions and no savepoint emulation. Repositories
  accept a `Queryable`, so the caller owns the transaction boundary.

## Errors

Every failure surfaces as a `DbError` whose `message` is just
`database error: <kind>`. The raw server message, the row detail and the
connection target stay on `cause`, for server logs via `describeDbError`,
which emits only kind, SQLSTATE, constraint and business code.

| kind | SQLSTATE | retryable |
|---|---|---|
| `unique_violation` | 23505 | no |
| `foreign_key_violation` | 23503 | no |
| `check_violation` | 23514 | no |
| `not_null_violation` | 23502 | no |
| `invalid_input` | 22xxx | no |
| `serialization_failure` | 40001 | yes (retry the whole transaction) |
| `deadlock` | 40P01 | yes |
| `query_timeout` | 57014 | no |
| `business` | P0001 with a bare token message (`request_not_found`, `coupon_expired`, `ERR_REFERRAL_CODE_EXHAUSTED`, `orders_append_only`, …) | no |
| `unavailable` | 08xxx, 57P01–03, ECONNREFUSED and similar, pool connect timeout | yes |
| `unknown` | anything else, including P0001 raised with a sentence | no |

`isBusinessError(error, "request_not_found")` is how callers branch on a
business outcome from a SQL function.

## Repositories

Every function takes a `Queryable` first, so it works on the pool or inside
a transaction. Ownership-sensitive functions take the caller's
**already-resolved** id. Nothing in this layer knows about sessions, JWTs,
`auth.uid()` or RLS. Actor ids are validated as UUIDs before any SQL runs; a
bad id throws `RepositoryInputError`.

| Function | Actor | Ports | Returns |
|---|---|---|---|
| `getParentOrdersPage(db, { parentProfileId }, { cursor, limit })` | parent | `lib/parent/orders/queries.ts` | `{ ok, orders, nextCursor }` or `invalid_cursor` |
| `getWelcomeImageCreditsRemaining(db, { parentProfileId })` | parent | `readWelcomeImageCredits` (removed V0.1.46) | `max(granted − used, 0)`; 0 when there is no row. Served by `GET /v1/parent/welcome-credits` |
| `getCandyBalance(db, { parentProfileId })` | parent | `candy_wallets` read in `/api/candy-purchases` (removed V0.1.46) | balance, or null when there is no wallet. Served by `GET /v1/parent/candy-balance` (null → 0) |
| `getParentProfileDisplay(db, { userId })` | user (V0.1.46) | `parent_profiles.full_name` read of the public header | `{ fullName }` (null when unnamed) or null (no profile). One query on `user_id`; no id, consent or referral code. Served by `GET /v1/parent/profile` |
| `getActiveCreationPrices(db)` | public | `GET /api/creation-pricing` | `{ ok, prices }` or `invalid_catalog` (same rejection rules as the route) |
| `resolveUserIdentity(db, { provider, providerSubject })` | verified external identity (V0.1.42) | new: `user_identities` join `users` | `{ userId, role, deleted, sessionsNotBefore }` or null (identity not linked). One query; `sessionsNotBefore` (V0.1.43) is epoch ms or null. Read-only; never creates a user |
| `getUserById(db, { userId })` | user | role lookup in `ParentRequestContext` | `{ id, role, deleted }` or null |
| `findParentProfileIdByUserId(db, { userId })` | user | profile lookup in `ParentRequestContext` | profile id or null |

A database failure throws `DbError`. The future route adapter maps that to the
response it already returns today (for example `read_failed` → 503, or a null
welcome-credit count).

### Parent orders: what is preserved

- **Ownership:** `WHERE o.parent_id = $1`. This replaces both the Supabase
  `.eq()` and the RLS policy, so it is the only guard.
- **Visibility:** the same `PARENT_VISIBLE_INTERNAL_STATUSES` (drafts and
  pending payments stay hidden).
- **Pagination:** keyset on `(created_at DESC, id DESC)`, using
  `(created_at, id) < ($3, $4)`. Default 20, max 50, and `pageSize + 1` rows
  are read. It uses the same base64url cursor codec, and the cursor follows
  the last row **read**.
- **Row mapping:** the same `toParentOrderSummary`, moved without change to
  `lib/parent/orders/summary.ts` so both read paths share it. `queries.ts`
  re-exports it.
- **`completedAt`:** the first `delivered` transition, which is the same rule
  as `get_parent_orders_delivered_at`. It is computed in the **same
  statement**, as a correlated `MIN` over the already-limited page. That is
  one round trip instead of two, and never N+1.
- **Timestamp precision:** timestamps come back as fixed-format UTC text with
  microseconds (`2026-01-01T00:00:00.000001+00:00`). Left as JS `Date`s, they
  would be truncated to milliseconds, and a millisecond cursor repeats or
  skips rows that share a timestamp.

### SQL safety

All SQL is constant text with `$n` placeholders. The repositories contain no
template interpolation, no concatenated clauses and no dynamic identifiers,
so no allow-list was needed. If dynamic SQL ever is, it must come from a
fixed map. Hostile ids and cursors are rejected before SQL runs. Hostile text
stored as data comes back as data. Both cases are tested.

## Application role

`0009_application_role.sql` creates **`cartoona_app`**, a NOLOGIN group role
that holds the application's privileges:

- `CONNECT` on the database, and `USAGE` (not `CREATE`) on `public`;
- `SELECT` on `users`, `parent_profiles`, `creation_pricing`,
  `parent_welcome_credits`, `candy_wallets`, `orders` and
  `order_status_history`, which is exactly what the read repositories query,
  plus `SELECT` on `user_identities` (`0010_identity_read_grant.sql`, V0.1.42)
  for identity resolution. `users.sessions_not_before` (0011, V0.1.43) is
  readable through the existing `users` grant; there is deliberately **no**
  UPDATE, so the app role cannot clear a forced logout;
- no INSERT/UPDATE/DELETE, no EXECUTE, no access to ledgers, purchases,
  coupons, audit logs or `schema_migrations`;
- NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS, and
  it owns nothing.

So it cannot alter or drop schema, cannot disable triggers (that needs
ownership or `session_replication_role`, which is superuser-only), and cannot
call any `*_trusted` function yet. Each write cutover adds EXECUTE on exactly
the functions it calls, in a new migration. This is not Supabase's
`service_role`: there is no all-powerful app role.

**Why a group role plus a script, rather than a LOGIN role in the
migration:** a migration is committed and checksummed, so it cannot carry a
password. Roles are also cluster-wide, so per-environment credentials and
their rotation belong outside the schema chain. Login roles are created as
members of `cartoona_app` by:

```sh
CARTOONA_APP_DB_PASSWORD="$(openssl rand -hex 32)" \
DATABASE_URL=postgresql://cartoona:<owner-password>@localhost:5433/cartoona \
  scripts/db/app-login-role.sh            # role defaults to cartoona_app_login
```

The script:

- validates the owner target with `migrate-local.sh --check` (local only,
  never Supabase);
- requires 24–128 characters from `[A-Za-z0-9._~+/=-]`;
- sends the password to psql on stdin, never in argv;
- masks it out of any psql error, and never prints it.

Re-running it rotates the password. The app then connects as
`postgresql://cartoona_app_login:<password>@postgres:5432/cartoona`, never as
the owner. Migrations still run as the owner.

## Tests

| File | Database | Covers |
|---|---|---|
| `tests/unit/db-pool.test.ts` | none (`pg` mocked) | lazy init; failure only on use; one pool reused; config defaults, bounds and fail-closed URLs; no password in messages or logs |
| `tests/unit/db-foundation.test.ts` | none, plus a real pool to a closed loopback port | commit, rollback, release, original error kept; error normalisation; unreachable DB → `unavailable` with no password anywhere |
| `tests/unit/repositories.test.ts` | none (recording fake) | constant SQL with bind values; hostile ids and cursors; page-size bounds; cursor rules; mapping; pricing rules; credits and wallet |
| `tests/unit/db-layer-static.test.ts` | none | no Next.js or Supabase imports; no string-built SQL; app not switched; `/api/health` DB-free; 0009 has no secret |
| `tests/unit/postgres-repositories-db.test.ts` | opt-in, `CARTOONA_PLAIN_PG=docker` | real chain 0001–0009 through the runner; a real login role from the script; the real pool **as that role** over 127.0.0.1:5433; ownership, ordering, tie groups, bounds, empty states, privileges, transactions, live error kinds, timings |

```sh
docker compose --env-file .env.docker up -d postgres
CARTOONA_PLAIN_PG=docker npx vitest run tests/unit/postgres-repositories-db.test.ts tests/unit/plain-postgres-db.test.ts
```

The opt-in suite creates and drops its own `dal_<id>` database and
`cartoona_app_t<id>` role. The `cartoona_app` group role stays in the local
cluster, because roles are cluster-wide.

## Before the first route cuts over

**Status:** pricing (V0.1.41), the parent orders LIST (V0.1.45) and the
parent account reads (V0.1.46: profile name, candy balance, welcome credits)
are served from this layer through the backend. The orders list uses
`findParentProfileIdByUserId` and `getParentOrdersPage`. The account reads use
`findParentProfileIdByUserId`, `getCandyBalance`,
`getWelcomeImageCreditsRemaining` and `getParentProfileDisplay`. The SELECT
grants of 0009 already cover all of them (`users`, `parent_profiles`,
`candy_wallets`, `parent_welcome_credits`, `orders`, `order_status_history`;
`user_identities` from 0010), so no migration was added in either release.
No INSERT/UPDATE/DELETE or EXECUTE grant was added. Items 1–5 below are done for those reads; item 6 (writes) is open.

1. **Identity bridge:** a route still learns who the caller is from Supabase
   Auth. Cutover needs the Supabase user id resolved to a plain `users.id`,
   through `user_identities` or the same UUIDs carried over by the data copy.
2. **Data:** the plain database must hold real data for the domain being
   switched, either the copy procedure in PLAIN_POSTGRES.md or dual writes. A
   read cutover against an empty database would show empty states.
3. **Credentials:** provision `cartoona_app_login` in the target environment
   and set `DATABASE_URL` to it, never the owner. The compose example still
   names the owner for local tooling.
4. **Readiness:** add a readiness check that calls `pingDatabase()`. Keep it
   separate from `/api/health`, which stays liveness.
5. **Route adapters:** map `DbError` to the route's existing responses
   (`read_failed` → 503, null credit count). The pricing route's validation is
   now duplicated in `getActiveCreationPrices`; switching the route should
   delete the route-side copy.
6. **Writes:** write repositories over the `*_trusted` functions, plus
   EXECUTE grants in a new migration. They are not part of V0.1.39.
