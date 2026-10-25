# Production cutover (V0.1.54)

Operator checklist, audits and decisions for moving Cartoona's business data
from the Supabase database to PostgreSQL in production. Nothing in this
repository performs a production cutover; every step below is run by a person.
V0.1.54 is a rehearsal/readiness release: product behaviour changed only to
remove verified production blockers (section 6).

Status words used throughout: **RESOLVED**, **READY BUT MANUAL**,
**EXTERNAL DEPENDENCY**, **PRODUCT DECISION**, **PRODUCTION INFRA REQUIRED**
(the matrix is section 15).

## 1. Final runtime architecture

| Concern | Where it lives | Notes |
|---|---|---|
| Authentication / sessions | Supabase Auth | verifies WHO; roles come from PostgreSQL (`GET /v1/auth/me`) |
| Object bytes | Supabase Storage | service credential, server side only; signed URLs, 300 s |
| All business data | PostgreSQL 17 | read/written only by the Fastify backend as `cartoona_app_*` |
| BFF / UI / Auth adapter / Storage signing | Next.js | holds the Supabase keys and the payment provider secrets |
| Business API | Fastify (`backend/`) | holds `DATABASE_URL` and the internal assertion secret, nothing else |

Supabase database use at runtime: **zero** (`tests/unit/zero-supabase-db-static.test.ts`
scans app, components, lib, backend and middleware for `.rpc(`, `.from(<table>)`,
`/rest/v1`).

## 2. Environment variables by service

Names only; values never belong in this repository.

| Variable | Frontend (Next) | Backend (Fastify) | Migration / ops tooling | Notes |
|---|:-:|:-:|:-:|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` | build + run | no | no | public by design; baked into the browser bundle |
| `SUPABASE_SECRET_KEY` | run | **never** | storage-key check only | Storage bytes only (section 8) |
| `CARTOONA_INTERNAL_AUTH_SECRET` | run | run | no | the one shared secret; hex, >= 32 bytes |
| `BACKEND_INTERNAL_URL`, `BACKEND_REQUEST_TIMEOUT_MS` | run | no | no | server-side only |
| `CARTOONA_APP_ORIGIN` | run | no | no | CSRF origin; production refuses writes when unset |
| `CARTOONA_WRITE_FREEZE` | run | no | no | cutover freeze, exactly `1` (section 11) |
| `CARTOONA_PAYMENT_PROVIDER`, `CARTOONA_PAYMENT_*` | run | **never** | no | provider secrets stay in Next |
| `RATE_LIMIT_HASH_SECRET`, `RATE_LIMIT_TRUSTED_IP_HEADER`, `RATE_LIMIT_DISABLED` | run | no | no | `RATE_LIMIT_DISABLED` must be unset in production |
| `DATABASE_URL` | **never** (blanked in compose) | run | owner URL, migrations only | backend uses the restricted login role |
| `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`, `BACKEND_PORT`, `BACKEND_HOST`, `LOG_LEVEL` | no | run | no | |
| `POSTGRES_*`, `CARTOONA_APP_DB_PASSWORD`, `BACKEND_DATABASE_URL`, `LOCAL_DATABASE_URL` | **never** | no | local compose only | compose blanks these for the frontend; a static test checks the list |
| `DEV_PARENT_AUTH_*` | **unset** | no | no | development only; refused in production |
| `CARTOONA_AMR_*`, `CARTOONA_STORAGE_CHECK_*` | no | no | operator scripts | disposable project / explicit read-only confirmation |

Secrets are not duplicated into containers that do not need them: the backend
container has no `env_file` and receives exactly the variables in its
`environment:` block; the frontend receives no database credential.

## 3. Dead Auth legacy removed (RESOLVED)

`lib/auth/parent-session-lifetime.ts` (`checkParentSessionLifetime`) and
`createParentSessionFailureResponse` had zero runtime callers since V0.1.53 and
were deleted with their tests; `auth-boundary-static.test.ts` pins their
absence. Kept: the pure session policy (`lib/identity/session-policy.ts`), the
AMR evidence reader and the backend's 30-day / `sessions_not_before` enforcement.

## 4. AMR (session start) - EXTERNAL DEPENDENCY

The 30-day session limit measures from `min(amr[].timestamp)` of the
provider-verified access token. Whether a real Supabase project issues a stable,
timestamped AMR for phone OTP and for password sign-in, and keeps the earliest
timestamp across refresh, has **not been verified against a real token**: the
disposable project named in `.env.local` does not resolve (DNS `ENOTFOUND`), and
production was not used. Result: **BLOCKED**.

Operator procedure (disposable project only):

```
CARTOONA_AMR_PROJECT_URL=https://<disposable-ref>.supabase.co \
CARTOONA_AMR_ANON_KEY=<publishable key> \
CARTOONA_AMR_EMAIL=<test user> CARTOONA_AMR_PASSWORD=<test password> \
node scripts/auth/verify-amr.mjs            # password
CARTOONA_AMR_PHONE=<number> node scripts/auth/verify-amr.mjs --phone --send-otp
CARTOONA_AMR_PHONE=<number> CARTOONA_AMR_OTP=<code> node scripts/auth/verify-amr.mjs --phone
```

It prints sanitized JSON only (methods, booleans, second deltas), never a token,
refresh token, subject, phone, e-mail or session id, and refuses the production
project ref. Exit 0 = stable, 4 = unstable or missing. The analysis is unit
tested (`tests/unit/amr-analysis.test.ts`).

If the result is **stable**: nothing to build; record the date and result here.
If **missing or unstable**, do NOT fall back to `iat` (a refresh moves it and
would extend sessions). Build the Cartoona-owned session-start record instead
(designed, deliberately not built, no evidence it is needed):

* table `auth_session_starts(provider, provider_session_id, first_seen_at, last_seen_at)`,
  primary key `(provider, provider_session_id)`; the id is the provider-verified
  session id claim, never browser-supplied; no tokens stored;
* the backend inserts `ON CONFLICT DO NOTHING` on first observation with the
  **database clock**, so concurrent first requests yield one row and a refresh
  (same session id) never moves `first_seen_at`;
* the policy uses `first_seen_at`; `users.sessions_not_before` keeps working
  unchanged; rows older than the session lifetime + margin are deleted by a
  bounded daily job (`DELETE ... WHERE first_seen_at < now() - interval '31 days'`).

## 5. Export rehearsal - EXTERNAL DEPENDENCY (real export), RESOLVED (tooling)

No real `pg_dump` of the Supabase project is available, so the rehearsal on a
real export is **BLOCKED** and was not faked. What was rehearsed, labelled
synthetic: `tests/unit/data-copy-perf-db.test.ts` with
`CARTOONA_DATA_COPY_PERF_PARENTS=9990 CARTOONA_DATA_COPY_PERF_VIA_DUMP=1`
builds a Supabase-shaped source (real migration chain, rows through the real
triggers), `pg_dump -Fc` -> `pg_restore` into a staging database -> V0.1.44 copy
into a freshly migrated plain target -> validation -> verified no-op rerun.

| Measure (10,000 users, 100,000 orders, 602,945 rows, local Docker) | Result |
|---|---|
| dump + restore (31.4 MiB custom dump) | 6.3 s |
| copy (preflight 2.3 s, copy 19.8 s, validation 4.3 s) | 26.6 s total |
| slowest phase / table | orders phase 13.4 s; order_status_history 179,920 rows 4.4 s |
| peak RSS of the tool | 95 MB (baseline 42 MB) |
| verified no-op rerun | 6.6 s |
| preservation mismatches / source checks / target checks | 0 / 60 clean / 65 clean over 31 tables |

The reconciliation block (counts, per-table content checksums, check results)
is written to `CARTOONA_DATA_COPY_PERF_REPORT` as JSON; it contains no row values.

Known gaps a real export may expose (reported, never silently repaired): Supabase
managed schemas/roles/extensions in the dump (restore into an empty database
with `--no-owner --no-privileges` and check what `pg_restore` rejects), columns or
migrations that drifted in production (the tool refuses on a schema-fingerprint
or column mismatch and names the table), and data the synthetic fixture does not
model. The operator runs the same tool against the restored staging copy before
the real cutover (section 11, step C).

## 6. Blockers found and fixed in V0.1.54

1. **Parent source uploads depended on a Supabase-database Storage policy.**
   `POST /api/requests` uploaded, copied and removed parent files with the
   parent's own JWT under policies calling `public.is_parent()`. After cutover a
   parent created in PostgreSQL has no Supabase row, so every upload would fail,
   and a role changed in PostgreSQL would never reach the policy. Now
   `lib/storage/parent-uploads.ts` does it with the service credential after
   PostgreSQL authorized the caller, confined to `<subject>/<orderId>/<name>`
   keys (traversal and foreign subjects refused, a copy may read only the same
   subject's folder).
2. **Source previews were signed with the viewer's session** (parent gallery,
   parent order detail, admin request detail) under the same policies. They now
   go through `signParentSources`, which signs only keys PostgreSQL selected.
3. **Storage policies left as false security assumptions.**
   `database/ops/supabase-storage-lockdown.sql` drops every Storage policy that
   authorizes through a Supabase-database function (keeps the two public-read
   policies). Run it after the irreversible boundary (section 11, step F).
4. **Payment stub override removed.** `CARTOONA_PAYMENT_STUB_UNSAFE_ALLOW_IN_PRODUCTION`
   no longer exists; `readStubConfig` returns null whenever `NODE_ENV=production`.
   Container proofs that used the production build with the stub can no longer
   do so; the payment flows are proven in the PG-enabled Vitest suites (stub
   provider on a non-production process).
5. **Backend startup/readiness gates** (section 10) and the **write freeze**
   (section 11).

## 7. Payment provider audit - PRODUCT DECISION / EXTERNAL DEPENDENCY

**Real provider not selected.** No provider SDK, credentials, sandbox account or
provider name exists in the repository other than examples in
`docs/PAYMENT_PROVIDER_ARCHITECTURE.md`. Production payment stays blocked:
with no provider configured `pay` answers `503 PAYMENT_UNAVAILABLE`; the stub is
impossible in production. No speculative adapter was written. The provider
boundary (`lib/payments/providers/types.ts`, `registry.ts`) and the security
properties a real adapter must satisfy are already proven on the stub: signature
over the RAW body, timestamp tolerance, constant-time compare, server-side
verification of the session with the provider (never trusting a return query),
amount and currency check, event de-duplication in one PostgreSQL transaction,
at-most-once wallet credit, secrets only in Next. When a provider and sandbox
credentials are provided, the work is one adapter file implementing
`PaymentProviderAdapter` plus its contract tests against the sandbox.

## 8. Storage production audit

Every action: actor, authorization source, namespace, credential, lifetime,
MIME/size. "PG" = PostgreSQL decided it through the backend before Storage is
touched. Browsers never receive a Storage credential.

| Action | Actor | Authorization | Bucket / key namespace | Credential | Lifetime | MIME / size |
|---|---|---|---|---|---|---|
| Parent source upload | verified parent | PG (parent role, consent, quota in the write) | `parent-uploads` / `<subject>/<orderId>/<name>` built by the route | service key, server | permanent object; orphan removed on a definite refusal | allow-listed images/video, <= 10 MB, checked before upload |
| Gallery reuse (copy) | verified parent | PG proved the source asset is theirs; helper re-checks same subject | `parent-uploads` same namespace | service key | permanent | MIME re-checked from the stored row |
| Source preview (parent, admin) | parent / admin | PG selected the rows (admin role gated by backend) | `parent-uploads` | service key, signed URL | 300 s | n/a |
| Final deliverable upload | admin | PG upload gate (`/upload-gate`) before bytes | `final-deliverables` / `orders/<id>/final/...` | service key | permanent; rollback removes it | allow-listed, size cap in `media-validation` |
| Final deliverable download | parent | PG visibility (approved + parent_visible) | `final-deliverables` | service key, signed URL | 300 s | n/a |
| Homepage media write | admin | backend CMS gate before bytes | `homepage-media` (public read) | service key | permanent; replaced objects removed | validated per slot |
| Example media write | admin | backend gate | `example-media` (public read) | service key | permanent | validated |
| Public media read | anyone | public bucket | `homepage-media`, `example-media` | none (public URL) | n/a | n/a |

Service-role minimization: `SUPABASE_SECRET_KEY` is read by exactly two modules,
the Storage-only client (`lib/supabase/admin.ts`, type exposes `storage` only,
imported by four `lib/storage/*` modules) and the development-only Auth Admin
helper that is 404 unless dev auth is enabled. It is not `NEXT_PUBLIC_*`, not in
the browser bundle, never sent to the backend, and never used for business data
(static tests). Logs carry bucket and error category, never keys or URLs.

Storage policy audit: 20 policies on `storage.objects` exist (18 call
`is_admin()`, `is_parent()` or `is_parent_approved_final_deliverable()` against the
Supabase copy of `users`/`orders`; 2 are public-read). Runtime depends on none of
them after V0.1.54. They are dropped by `supabase-storage-lockdown.sql` after the
irreversible boundary, because before it the old Supabase writer may still be the
live system.

Key existence validation: Storage bytes are not migrated, so after the copy run
the **read-only** checker, with the explicit confirmation variable:

```
CARTOONA_STORAGE_CHECK_DATABASE_URL=... CARTOONA_STORAGE_CHECK_SUPABASE_URL=https://<ref>.supabase.co \
CARTOONA_STORAGE_CHECK_SECRET_KEY=... CARTOONA_STORAGE_CHECK_CONFIRM=read-only-existence-check \
node scripts/ops/storage-key-check.mjs [--sample 2000] [--concurrency 8]
```

It reads keys from `media_assets`, `homepage_media_assets` and `examples` in a
READ ONLY transaction and calls Storage `exists` only. Output: counts and
non-reversible fingerprints (never keys). Exit 0 all present, 4 problems.

## 9. Production database roles (READY BUT MANUAL)

* **Owner role** (managed-database admin): applies `database/migrations` in
  order, runs the copy, never used by a running service.
* **`cartoona_app`**: `NOLOGIN` group created by migration 0009. No table writes
  (only column UPDATE on `parent_profiles(full_name, updated_at)`), EXECUTE on the
  audited SECURITY DEFINER `*_trusted` and provisioning functions, none to PUBLIC.
* **Login role** (`cartoona_app_<name>`): member of the group, no superuser,
  createdb, createrole, replication or bypassrls, owns nothing in `public`.
  Created by `database/ops/create-app-login-role.sql` on a remote database
  (`scripts/db/app-login-role.sh` refuses non-local hosts by design). The password
  is generated (`openssl rand -hex 32`), read by psql via `\getenv`, never on a
  command line, never committed. Tested: `tests/unit/ops-role-provisioning-db.test.ts`
  (refusals, restricted attributes, rerun re-passwords, passes the backend's own
  role and schema checks, an owner login fails them).

Hosting requirements: PostgreSQL 17, extension `pgcrypto`, TLS to the backend, a
private network path from the backend only, `scram-sha-256`. `migrate-local.sh`
also refuses remote hosts; on production apply each file with
`psql --single-transaction -v ON_ERROR_STOP=1 -f <file>` followed by the
`schema_migrations` insert exactly as the script does, from a trusted host.

## 10. Backend and frontend production configuration

Backend fail-fast (`backend/src/config.ts`, `server.ts`): refuses to start on a
missing or weak `CARTOONA_INTERNAL_AUTH_SECRET`, an invalid or Supabase-pointing
`DATABASE_URL`, a bad port or host. With `NODE_ENV=production` it additionally
connects and refuses to start if the login is a superuser/privileged/owner/non-member
role, or if the schema is behind the build (the head migration's function is not
executable). An **unreachable** database does not stop the process; `/ready`
reports 503 so an outage is visible instead of a restart loop. Proven in the
production image: owner login -> exit 1 (`superuser`); schema at migration 18 ->
exit 1 (`behind`); restricted + current -> listening, `/ready` 200; unreachable
host -> stays up, `/ready` 503; missing secret -> exit 1.

Readiness: `/health` is liveness only (no database). `/ready` = `SELECT 1` on
every call, plus (once per process, cached) restricted-role check and
migration-head check.

Frontend: needs the public Supabase values at build time, `SUPABASE_SECRET_KEY`,
`CARTOONA_INTERNAL_AUTH_SECRET`, `BACKEND_INTERNAL_URL`, `CARTOONA_APP_ORIGIN`
(exact public origin) at run time; no database variable; `DEV_PARENT_AUTH_*`,
`RATE_LIMIT_DISABLED` and any `CARTOONA_PAYMENT_STUB_*` unset.

Network topology: browser -> (TLS) Next -> (private network) Fastify -> PostgreSQL;
Next -> Supabase Auth and Storage over TLS. The backend is not exposed publicly,
has no CORS and accepts only signed assertions; PostgreSQL accepts only the
backend (and operators from a bastion for migrations/backups).

Migration order/version rule: apply all migrations to the target **before** the
new backend starts (the gate enforces it); the data-copy tool pins the head
(`EXPECTED_TARGET_MIGRATIONS`) and `tests/unit/startup-gate.test.ts` fails if a
new migration is added without moving the pin and the readiness probe.

## 11. Cutover runbook

Roles: operator (runs commands), approver (go/no-go). Nothing below is run by
the repository's tests; all production contact is manual and deliberate.

**A. Pre-cutover (days before)**

1. Real export rehearsal (section 5) on a restored copy; reconcile; fix findings.
2. AMR verification on a disposable project (section 4) recorded as stable, or
   the session-start record built.
3. Payment provider selected and sandbox-tested, or payments declared closed
   for the launch (the app answers `PAYMENT_UNAVAILABLE`).
4. Production PostgreSQL provisioned, migrated, login role created
   (section 9), backups enabled and a restore tested (section 12).
5. Backend and frontend images built from the release commit; secrets in the
   secret store; staging boot shows the gates pass.
6. Alerts and dashboards live (section 13). Refund policy confirmed (section 14).

**B. Freeze** (announce a window, e.g. 30 minutes)

1. Set `CARTOONA_WRITE_FREEZE=1` on the **old** deployment and restart: every
   browser business write answers 503 `write_freeze` with `Retry-After`, the
   payment webhook answers 503 so the provider retries later, reads and sign-in
   keep working.
2. Pending payments: list `candy_purchases` / attempts in a non-final state. Let
   in-flight provider sessions finish or expire (<= the provider's session
   lifetime) before copying; any that confirm during the window are replayed by
   the provider's webhook retry after cutover (de-duplicated by event id, credited
   at most once). Reconcile the provider's settlement report against paid purchases.
3. Wait for the Supabase side to quiesce (no writes for 5 minutes).

**C. Copy**

1. `pg_dump -Fc` of the Supabase project; restore into a staging database.
2. `npm run db:copy` staging -> production target (fresh, migrated). Exit 0 and a
   clean reconciliation report (counts + checksums, no mismatches) are the gate.
3. `node scripts/ops/storage-key-check.mjs` (section 8): zero missing keys.
4. Backfill/verify identities: the copy tool backfills `user_identities`; check
   the report line.

**D. Deploy**

1. Start the backend against the restricted login: it must pass its gates.
2. Deploy the frontend (the new build) with the freeze still on; `/ready` 200.

**E. Verify** (freeze still on, reads only)

Sign in as a copied parent, an admin, and view orders, gallery, final media and
the CMS; call `/ready`; confirm requests show Auth/Storage only to Supabase.

**F. Enable**

1. Remove `CARTOONA_WRITE_FREEZE` and restart. Smoke: one request submission,
   one admin status change, one coupon validation.
2. **Irreversible boundary:** the first write that lands in PostgreSQL only.
   From here the Supabase writer must never be re-enabled (it would diverge).
3. Run `database/ops/supabase-storage-lockdown.sql` on Supabase. Remove the
   Supabase database from the application's secret store and rotate any key
   that was shared.

**G. Monitor** for 24 h: alerts in section 13; watch `READINESS_FAILED`,
5xx rate, pool wait, payment webhook outcomes.

**Rollback**

* Before F.2 (nothing written to PostgreSQL only): set the freeze, redeploy the
  previous release (Supabase writer), unfreeze. The PostgreSQL copy is discarded.
* After F.2: **there is no rollback to the Supabase writer.** Roll forward: fix
  and redeploy the new stack; restore PostgreSQL from backup (point-in-time) if
  data is damaged. A partial return would lose every order, credit and consent
  written since F.2.

## 12. Backup and restore

Required before cutover (PRODUCTION INFRA REQUIRED): continuous WAL archiving
or the provider's point-in-time recovery (RPO <= 5 minutes), a daily logical
`pg_dump -Fc` kept 30 days in a separate account/region, encrypted at rest.
Restore drill (practiced once before cutover, then quarterly): restore the latest
dump into a scratch database, run `scripts/db/migrate-local.sh`-equivalent version
check, start a backend against it, and run the storage-key check. Storage objects
are backed up by the Supabase project's own policy plus a periodic listing export
(bytes are not in PostgreSQL). Target RTO: 1 hour.

## 13. Observability and alerts

Events already emitted as JSON logs (V0.1.30): `READINESS_FAILED` (reason
`db_role_*`, `schema_behind`), `CSRF_REJECTED`, `PAYMENT_WEBHOOK_REJECTED`,
`SUBMISSION_STORAGE_FAILED`, `SESSION_*`, `STORAGE_SIGNED_URL_*`,
`BACKEND_START_FAILED`. Alerts to configure in the log platform:

| Alert | Condition | Severity |
|---|---|---|
| Backend not ready | `/ready` 503 for 2 min | page |
| Role/schema gate | any `READINESS_FAILED` with `db_role_*` or `schema_*` | page |
| Backend restart loop | > 3 starts / 10 min | page |
| 5xx rate | > 2 % of API requests for 5 min | page |
| Payment webhook rejected | `PAYMENT_WEBHOOK_REJECTED` spike | warn |
| Storage failures | `SUBMISSION_STORAGE_FAILED` > 5 / 10 min | warn |
| Pool pressure | backend p95 latency > 1 s for 10 min | warn |
| Write freeze left on | `CSRF_REJECTED` code `write_freeze` after the window | page |

Rehearsal: the readiness/gate alerts were exercised by the production-image proof
in section 10.

## 14. Rate limiting and refund decisions

**Rate limiting - PRODUCTION INFRA REQUIRED.** The limiter is in memory and not
distributed. Decision: run the Next frontend as a **single instance** at launch
(documented in `docs/rate-limiting.md`); a distributed store is required before a
second instance or serverless scale-out. Set `RATE_LIMIT_HASH_SECRET` and the
trusted IP header for the actual proxy; never `RATE_LIMIT_DISABLED`.

**Refund policy - PRODUCT DECISION (not implemented).** Current behaviour is
**no refund**: a paid candy purchase is credited once and never reversed; spent
candies are not returned. Options for the owner:

| Option | Behaviour | Needed |
|---|---|---|
| A. No refund (current) | none | terms of service wording only |
| B. Automatic full refund | provider refund + ledger reversal on request | provider refund API, ledger `refund` type, negative-balance rule |
| C. Admin-controlled | admin triggers a refund per purchase | B plus an admin screen and audit entries |
| D. Conditional | refundable only if unspent / within N days | C plus eligibility rules |

Recommendation: ship with A and say so in the terms; decide B/C/D with the chosen
provider, because refunds are provider-specific.

## 15. Blocker matrix

| Item | Status | Detail |
|---|---|---|
| Supabase database runtime dependencies | RESOLVED | zero (static guard + network proof); Storage policies lockdown script ready |
| Storage RLS dependency on Supabase tables | RESOLVED (code) / READY BUT MANUAL (lockdown SQL) | section 6 |
| Dead Auth legacy | RESOLVED | section 3 |
| Payment stub in production | RESOLVED | override removed |
| Backend startup/readiness/migration gates | RESOLVED | proven in the production image |
| Write freeze, key check, role SQL, scale rehearsal tooling | RESOLVED | tested |
| Scale (10k users / 100k orders), load (20/50 clients) | RESOLVED (synthetic) | section 5; load report below |
| AMR real-token verification | EXTERNAL DEPENDENCY | disposable Supabase project unreachable; script ready |
| Real `pg_dump` export rehearsal | EXTERNAL DEPENDENCY | no export supplied; not faked |
| Real payment provider adapter | EXTERNAL DEPENDENCY + PRODUCT DECISION | provider not selected |
| Refund policy | PRODUCT DECISION | section 14 |
| Backend deployment | PRODUCTION INFRA REQUIRED | image builds; hosting not chosen |
| PostgreSQL hosting | PRODUCTION INFRA REQUIRED | PG 17 + pgcrypto, private network, TLS |
| Supabase Storage (production buckets, bytes) | READY BUT MANUAL | buckets exist; key check after copy |
| Rate limiting (distributed) | PRODUCTION INFRA REQUIRED | single instance until then |
| Backups / restore drill | PRODUCTION INFRA REQUIRED | section 12 |
| Observability / alerting | PRODUCTION INFRA REQUIRED | alert table in section 13 |

### Load rehearsal result (local Docker, copied 1,000-user database, restricted role)

| Clients x pool | Requests | req/s | p50 / p95 / p99 / max (ms) | Statuses |
|---|---|---|---|---|
| 20, pool 5 | 800 | 1268 | 14 / 28 / 48 / 53 | 800 x 200 |
| 50, pool 5 | 2000 | 1833 | 26 / 36 / 40 / 45 | 2000 x 200 |
| 50, pool 20 | 2000 | 1869 | 23 / 45 / 86 / 132 | 2000 x 200 |

Reads of `/v1/parent/orders` with signed assertions through the real Fastify app.
The default pool of 5 queues 50 clients without errors on this data; writes were
not load tested. `/ready` stayed 200 after each run
(`tests/unit/backend-load-db.test.ts`, opt-in `CARTOONA_LOAD_REHEARSAL=1`).
