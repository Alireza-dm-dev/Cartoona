# Production cutover (V0.1.54 readiness, V0.1.55 resolution and runbook)

Operator checklist, audits and decisions for moving Cartoona's business data
from the Supabase database to PostgreSQL in production. Nothing in this
repository performs a production cutover; every step below is run by a person.
V0.1.54 was the rehearsal/readiness release; V0.1.55 turned every remaining blocker into
resolved-or-external (section 15), added the production preflight and the read-only cutover
check, and rewrote the runbook (section 11). Deployment specifications (PostgreSQL, backend,
frontend, alerts, smoke, monitoring, refund memo) are in `docs/PRODUCTION_DEPLOYMENT_SPEC.md`.

Status words used throughout: **RESOLVED**, **CODE READY / MANUAL ACTION**,
**EXTERNAL DEPENDENCY**, **PRODUCT DECISION**, **INFRASTRUCTURE REQUIRED**,
**HARD BLOCKER** (the matrix is section 15, the go/no-go list section 16).

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
| `DB_SSL_MODE` (`disable`\|`verify-full`), `DB_SSL_CA` (PEM, optional) | no | run | no | V0.1.55: TLS to PostgreSQL; `DATABASE_URL` cannot carry `?sslmode=` |
| `CARTOONA_CUTOVER_*` | no | no | `cutover:check` | read-only precheck inputs; confirm value required |
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

## 4. AMR (session start) - HARD BLOCKER (external dependency)

The 30-day session limit measures from `min(amr[].timestamp)` of the
provider-verified access token. Whether a real Supabase project issues a stable,
timestamped AMR for phone OTP and for password sign-in, and keeps the earliest
timestamp across refresh, has **not been verified against a real token**: the
disposable project named in `.env.local` does not resolve (DNS `ENOTFOUND`), and
production was not used. Result: **BLOCKED** (re-checked 2026-10-25: the project host resolves to a non-routable proxy address and HTTPS fails; nothing else was tried, production never).

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

## 5. Export rehearsal - HARD BLOCKER (real export), RESOLVED (tooling)

No real `pg_dump` of the Supabase project is available, so the rehearsal on a
real export is **BLOCKED** and was not faked. **The synthetic rehearsal below is not
equivalent to it** (it cannot show production schema drift, legacy columns, anomalous
rows or a real dump's restore errors), so launch stays blocked until step 0.2 of the
runbook is done by the operator. What was rehearsed, labelled
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

Storage policy audit: the migrations define 19 policies on `storage.objects` (17 call
`is_admin()`, `is_parent()` or `is_parent_approved_final_deliverable()` against the
Supabase copy of `users`/`orders`; 2 are public-read; V0.1.54 said 20/18, a miscount
corrected in section 18). Runtime depends on none of
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

Hosting requirements (full spec: `PRODUCTION_DEPLOYMENT_SPEC.md`): PostgreSQL 17, extension `pgcrypto`, TLS with `DB_SSL_MODE=verify-full` on the backend, a
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

## 11. Cutover runbook (V0.1.55)

Roles: **operator** (runs commands), **approver** (owns GO/NO-GO, section 16).
Nothing here is run by the repository's tests; all production contact is manual.
Every step has the same four parts: **Do**, **Expect**, **STOP if**, **Recover**.
"STOP" means do not continue and tell the approver; it never means "retry until it
passes". Shell variables used below hold URLs that include credentials: set them
in the operator's shell from the secret store, never in a file in this repository,
never echoed (`set +o history` first).

| Variable | Meaning |
|---|---|
| `OWNER_DATABASE_URL` | owner login of the NEW production PostgreSQL (`postgresql://…/cartoona`) |
| `APP_DATABASE_URL` | the `cartoona_app_<name>` login URL, as the backend will use it |
| `STAGING_SOURCE_URL` | the restored staging copy of the Supabase dump (local or tunnelled loopback) |
| `OLD_FRONTEND` / `NEW_FRONTEND` / `BACKEND_URL` | base URLs (backend URL is reachable only from the private network or a bastion) |

### Phase 0 - Preconditions (days before; each is a section 16 gate)

**0.1 Release.** *Do:* `git rev-parse HEAD`; build both images from that commit; record
the digest. *Expect:* one commit, clean `git status`, `npm test`, `npm run lint`,
`npx next build`, `npm run backend:typecheck`, `npm run backend:build` all green on it.
*STOP if:* any is red or the tree is dirty. *Recover:* fix and rebuild; no production state touched yet.

**0.2 Real export rehearsal.** *Do:* section 5 procedure with a real `pg_dump` of the
Supabase project (taken by the project owner from a read-only role), restored into a
private staging database, copied with `npm run db:copy` into a fresh migrated database,
then `npm run cutover:check -- --expect-target imported` with `CARTOONA_CUTOVER_SOURCE_DATABASE_URL`.
*Expect:* copy exit 0; reconciliation with 0 mismatches; `counts_match_source` pass; anomaly
list reviewed and each anomaly either explained in writing or fixed in the SOURCE data.
*STOP if:* a schema/column drift refusal, any mismatch, any unexplained anomaly.
*Recover:* nothing in production changed; discard the scratch databases.

**0.3 AMR.** *Do:* section 4 on a disposable Supabase project. *Expect:* `result: stable`
for every sign-in method the product offers. *STOP if:* unstable/missing/not run: build the
Cartoona-owned session-start record (section 4) and re-run 0.1-0.2 on that commit.

**0.4 Payments decision.** *Do:* approver records one of: (a) payments CLOSED at launch
(`CARTOONA_PAYMENT_PROVIDER` unset; buying answers `PAYMENT_UNAVAILABLE`); (b) a real
provider adapter shipped, sandbox contract-tested, with its retry guarantees written into
section 17. *STOP if:* paid purchases are required and (b) is not complete.

**0.5 PostgreSQL provisioned** to `docs/PRODUCTION_DEPLOYMENT_SPEC.md` section 1.
*Do:* from the bastion, `psql "$OWNER_DATABASE_URL" -X -At -c "select current_setting('server_version_num')::int/10000, (select ssl from pg_stat_ssl where pid=pg_backend_pid())"`.
*Expect:* `17|t`. *STOP if:* not 17 or not TLS.

**0.6 Migrations applied to the target** (from a trusted host; same logic as `scripts/db/migrate-local.sh`, which refuses remote hosts):

```
psql "$OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"
for f in $(ls database/migrations/*.sql | LC_ALL=C sort); do
  v=$(basename "$f" .sql); sum=$(shasum -a 256 "$f" | cut -d' ' -f1)
  { cat "$f"; printf "\nINSERT INTO public.schema_migrations (version, checksum) VALUES ('%s', '%s');\n" "$v" "$sum"; } \
    | psql "$OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null || { echo "STOP: $v failed"; break; }
done
```

*Expect:* no output. (This exact loop was run on a scratch database in V0.1.55 and
`cutover:check` then reported 19/19 migrations with matching checksums.)
*STOP if:* it prints `STOP:`. *Recover:* each file is its own transaction; drop the (still
empty) database and recreate it; never edit an applied migration.

**0.7 App login role.** *Do:* `CARTOONA_APP_DB_PASSWORD="$(openssl rand -hex 32)" psql "$OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v role=cartoona_app_prod -f database/ops/create-app-login-role.sql`;
store the password in the secret store as part of `APP_DATABASE_URL`. *Expect:* one line "ready". *STOP if:* a refusal line.

**0.8 Backend gates.** *Do:* start the backend (staging or production network) with
`APP_DATABASE_URL`; `curl -fsS $BACKEND_URL/ready`. *Expect:* `{"status":"ready"}`. The backend
refuses to start on an owner/superuser login or a schema behind the build. *STOP if:* exit 1 on start or `/ready` 503.

**0.9 Preflight, both services** (run with each service's real environment, e.g. inside the container):
`npm run production:preflight -- --service backend --expect-freeze off` and
`npm run production:preflight -- --service frontend --expect-freeze off [--payments required]`.
*Expect:* `OK`, 0 failed (warnings listed and accepted by the approver). *STOP if:* any FAIL.

**0.10 Backup and restore drill** (`docs/PRODUCTION_DEPLOYMENT_SPEC.md` section 1.5):
restore the latest backup into a scratch database, `cutover:check` it, start a backend on it,
`/ready` 200. *STOP if:* not done once successfully.

**0.11 Alerts live** (spec section 5) and a test alert delivered to the on-call channel.

**0.12 Smoke accounts.** One parent (consented), one admin; credentials in the secret store.

### Phase 1 - Announce (T-60 min)

**1.1** *Do:* publish the maintenance window. *Expect:* approver confirms. *STOP if:* no approver present.

### Phase 2 - Freeze the OLD deployment (T-0)

**2.1** *Do:* set `CARTOONA_WRITE_FREEZE=1` on the old frontend, restart. *Expect:*
`CARTOONA_CUTOVER_CONFIRM=read-only-cutover-check CARTOONA_CUTOVER_TARGET_DATABASE_URL="$OWNER_DATABASE_URL" CARTOONA_CUTOVER_FRONTEND_URL=$OLD_FRONTEND CARTOONA_CUTOVER_APP_ORIGIN=$OLD_FRONTEND npm run cutover:check -- --expect-freeze on`
reports `write_freeze` pass (an unauthenticated POST answered `503 write_freeze`).
*STOP if:* `observed` is not `frozen`. *Recover:* unset the variable and restart; no data moved.

**2.2** *Do:* in the Supabase SQL editor (read-only role) `select count(*) from auth.users; select max(updated_at) from public.orders;` twice, 5 minutes apart.
*Expect:* identical results (no writer is active; auth sign-ins do not change `public.orders`).
*STOP if:* the values move. *Recover:* find the unguarded writer (every route is enumerated by `tests/unit/write-freeze-coverage.test.ts`; anything else is a direct Supabase client); do not proceed.

### Phase 3 - Pending payments (section 17)

**3.1** With payments CLOSED (0.4a): *Do:* on the staging source after 4.1, `select count(*) from public.payment_attempts where completed_at is null; select count(*) from public.candy_purchases where payment_provider is not null and status = 'pending';`. *Expect:* `0` and `0` (no provider ever existed, so no provider payment can be outstanding). *STOP if:* either is > 0: payments were not closed; apply 3.2.
**3.2** With a provider (0.4b): follow section 17 exactly; otherwise STOP.

### Phase 4 - Export, copy, validate

**4.1** *Do:* the project owner takes `pg_dump -Fc` (Supabase, read-only role); operator restores it into the private staging database with `pg_restore --no-owner --no-privileges`. *Expect:* `pg_restore` exits 0, or only errors on Supabase-managed schemas/roles/extensions (list them and compare with the rehearsal's list from 0.2). *STOP if:* an error on a `public` table.

**4.2** *Do:* `CARTOONA_CUTOVER_CONFIRM=read-only-cutover-check CARTOONA_CUTOVER_TARGET_DATABASE_URL="$OWNER_DATABASE_URL" CARTOONA_CUTOVER_SOURCE_DATABASE_URL="$STAGING_SOURCE_URL" npm run cutover:check -- --expect-target empty`.
*Expect:* `pass`: PostgreSQL 17, TLS, migrations 19/19 with checksums, `target_empty`, source and target fingerprints differ. *STOP if:* any failed check, particularly a non-empty target. *Recover:* an already-populated target is never overwritten: recreate the database from 0.5-0.7.

**4.3** *Do:* the copy tool accepts only loopback targets. Open a tunnel from the operator host to the production primary (`ssh -N -L 127.0.0.1:55432:<primary-private-host>:5432 <bastion>`), then
`CARTOONA_COPY_SOURCE_URL=<staging, loopback> CARTOONA_COPY_TARGET_URL=postgresql://<owner>@127.0.0.1:55432/cartoona npm run db:copy -- --check` and, if it prints the expected labels, the same command without `--check`.
*Expect:* exit 0 and a reconciliation report with 0 mismatches. The tunnel is the only way the tool can reach a managed host; this exact path (loopback target forwarded to a managed host) has not been rehearsed against a real managed service, only against a loopback database.
*STOP if:* exit 2/3/4. *Recover:* exit 2 or 3 wrote nothing. Exit 4 means validation failed after writing: the target is NOT usable; drop and recreate it (0.5-0.7) and investigate before retrying.

**4.4** *Do:* `npm run cutover:check -- --expect-target imported` (same variables as 4.2). *Expect:* `counts_match_source` pass for all 12 data tables. *STOP if:* any difference.

**4.5** *Do:* `CARTOONA_STORAGE_CHECK_DATABASE_URL="$OWNER_DATABASE_URL" CARTOONA_STORAGE_CHECK_SUPABASE_URL=https://<prod-ref>.supabase.co CARTOONA_STORAGE_CHECK_SECRET_KEY=<service key> CARTOONA_STORAGE_CHECK_CONFIRM=read-only-existence-check node scripts/ops/storage-key-check.mjs`.
*Expect:* `all_present`, exit 0. *STOP if:* exit 4 (missing keys): report counts to the approver; do not repair silently.

### Phase 5 - Deploy the NEW stack (still frozen)

**5.1** *Do:* start the backend with `APP_DATABASE_URL`; `npm run cutover:check -- --expect-target imported` with `CARTOONA_CUTOVER_BACKEND_URL=$BACKEND_URL`. *Expect:* `backend_health` and `backend_ready` pass. *STOP if:* backend exits 1 or `/ready` is 503.

**5.2** *Do:* deploy the new frontend with `CARTOONA_WRITE_FREEZE=1`, then `npm run production:preflight -- --service frontend --expect-freeze on`. *Expect:* OK. *STOP if:* FAIL.

**5.3** *Do:* verify the freeze on the new frontend (as 2.1 against `$NEW_FRONTEND`). *Expect:* `frozen`.

**5.4 Verify authorization is PostgreSQL-backed (read-only, still frozen).** *Do:* sign in as the smoke parent, the smoke admin; open orders, one order detail, gallery, admin queue, one request detail. *Expect:* all load; an admin-only URL as the parent answers the existing refusal. Confirm in the backend log that these requests produced `BACKEND_REQUEST_COMPLETED` and that none of the requests of this phase reached `/rest/v1` on the Supabase project (Supabase API logs: zero PostgREST requests from this deployment). *STOP if:* any page fails or any PostgREST request appears.

**5.5 Verify Storage reads.** *Do:* open a gallery tile and a final deliverable preview. *Expect:* signed URLs load. *STOP if:* a missing object.

### >>> IRREVERSIBLE BUSINESS-DATA BOUNDARY <<<

**Immediately before step 6.1 the old Supabase deployment can still be restored.** Step 6.1
permits the first PostgreSQL-only business write. **After it, the old Supabase database
writers (the previous release, any script or dashboard that writes `public.*`) must NEVER be
re-enabled:** they would not see, and would silently diverge from, every order, credit and
consent written since. The approver says "cross the boundary" in writing before 6.1.

### Phase 6 - Enable writes

**6.1** *Do:* unset `CARTOONA_WRITE_FREEZE` on the new frontend, restart; point DNS/traffic to the new stack. *Expect:* `npm run production:preflight -- --service frontend --expect-freeze off` OK and `cutover:check -- --expect-freeze off` shows `not_frozen`. *STOP if:* the freeze remains.
*Recover before the first real write:* re-set the freeze, redeploy the old release, unfreeze (section "Rollback").

**6.2 Smoke (section 6 of the spec, minimal write set).** *Do:* as the smoke parent, one request submission (with a source image) and as the smoke admin one status change. *Expect:* both succeed; the order appears on both sides; no `REQUEST_FAILED`/`ADMIN_REQUEST_DB_FAILED`. *STOP if:* a failure. *Recover:* AFTER the boundary: roll forward only (fix, redeploy, or restore PostgreSQL from backup).

### Second boundary - Storage policy lockdown

**Run only after Phase 6 smoke has passed and the monitoring window has shown no Storage errors for at least 60 minutes.** Rolling the old release back is no longer possible after 6.1 anyway, and the lockdown is independently reversible only by re-applying the policies (section 18). It must never run before the new application is active and verified.

### Phase 7 - Storage lockdown

**7.1** *Do:* in the Supabase SQL editor run the pre-check in section 18.1. *Expect:* the 19 policies listed. **7.2** *Do:* run `database/ops/supabase-storage-lockdown.sql`. *Expect:* `COMMIT`. **7.3** *Do:* section 18.2 post-lockdown checklist, in full. *STOP if:* any item fails. *Recover:* re-apply the named migration policies (section 18.3) and investigate.

### Phase 8 - Close out

**8.1** Remove the Supabase database credentials from every secret store and rotate any key that was shared. **8.2** Start the monitoring window (spec section 6). **8.3** Keep the old Supabase database untouched and read-only (no writers) for the retention period decided by the approver; it is the only copy of pre-cutover state apart from backups.

### Rollback

* **Before step 6.1** (nothing written to PostgreSQL only): set the freeze on the new frontend, redeploy the previous release, unfreeze. Discard the PostgreSQL copy.
* **After step 6.1: there is no rollback to the Supabase writer.** Roll forward: fix and redeploy the new stack; restore PostgreSQL from backup (point-in-time) if data is damaged. A partial return would lose every order, credit and consent written since 6.1.

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

## 15. Blocker matrix (V0.1.55)

Classification: **RESOLVED**, **CODE READY / MANUAL ACTION**, **EXTERNAL DEPENDENCY**,
**PRODUCT DECISION**, **INFRASTRUCTURE REQUIRED**, **HARD BLOCKER** (launch cannot happen
while open). A HARD BLOCKER is also tagged with what clears it.

| # | Item | Class | State and what clears it |
|---|---|---|---|
| A | Real Supabase AMR verification | **HARD BLOCKER** (EXTERNAL DEPENDENCY) | Not verified. The disposable project in `.env.local` does not answer (DNS resolves to a non-routable proxy address; HTTPS connect fails, checked 2026-10-25). Production not used. Cleared by `verify-amr.mjs` reporting `stable` on a reachable disposable project, or by building the session-start record (section 4). The model is **unverified, not known-bad**; no fallback is active. |
| B | Real `pg_dump` / export rehearsal | **HARD BLOCKER** (EXTERNAL DEPENDENCY) | No real export exists anywhere on this machine. The synthetic rehearsal is NOT equivalent (section 5). Cleared by runbook step 0.2 with a real dump. |
| C | Real payment provider and adapter | **EXTERNAL DEPENDENCY** + **PRODUCT DECISION**; **HARD BLOCKER only if paid purchases are required at launch** | `REAL PAYMENT PROVIDER NOT SELECTED`: no provider is named in code, config or docs other than examples. Production payments stay blocked (`PAYMENT_UNAVAILABLE`). Launch with payments closed is possible and supported. |
| D | Production PostgreSQL hosting | **INFRASTRUCTURE REQUIRED** | Spec: `PRODUCTION_DEPLOYMENT_SPEC.md` s.1. TLS to the database is now configurable (`DB_SSL_MODE=verify-full`, V0.1.55); before this the backend could not connect to a TLS-only host. |
| E | Backend hosting and private network | **INFRASTRUCTURE REQUIRED** | Spec: s.2. Image builds; host not chosen. |
| F | Backup / PITR / restore drill | **INFRASTRUCTURE REQUIRED** | Spec s.1.5 and runbook 0.10; not performed (no production-like hosting). |
| G | Alerting / observability | **INFRASTRUCTURE REQUIRED** (events are CODE READY) | Alert definitions and log queries: spec s.5. Log destination not chosen. |
| H | Distributed rate limiting | **RESOLVED by decision** for one frontend instance; **HARD BLOCKER** for a second instance | Spec s.4. |
| I | Refund policy | **PRODUCT DECISION** (not launch-blocking unless the owner says so) | Current behaviour (no refund) preserved. Options memo: spec s.7. |
| J | Storage lockdown at the right stage | **CODE READY / MANUAL ACTION** | Runbook phase 7 and section 18; never before the boundary and a clean Phase 6 smoke. |
| K | Copy tool reaches only loopback targets | **CODE READY / MANUAL ACTION** | Found in V0.1.55: `data-copy` refuses non-local hosts by design. Runbook 4.3 uses a loopback tunnel to the managed primary; not rehearsed against a real managed service. |
| L | TLS to PostgreSQL | **RESOLVED (code)**, verification **INFRASTRUCTURE REQUIRED** | `DB_SSL_MODE`/`DB_SSL_CA` implemented and unit tested; no TLS-enabled PostgreSQL was available locally, so a real TLS handshake is **UNVERIFIED**. |
| M | Pending provider payments across the freeze | **HARD BLOCKER if a provider launches**; N/A with payments closed | Section 17. |
| N | Supabase DB runtime dependencies | **RESOLVED** | Zero; static guard re-run after V0.1.55. |
| O | Storage RLS dependency on Supabase tables | **RESOLVED (code)** / **CODE READY / MANUAL ACTION** (SQL) | V0.1.54. |
| P | Dead Auth legacy, payment stub in production, startup/readiness gates, write freeze + coverage test, config preflight, cutover precheck | **RESOLVED** | Tested. |

**Hard blockers open today: A, B (always), M (if a provider launches), C (if paid
purchases are required), H (if more than one frontend instance).** Actual production
cutover is therefore **NO-GO** (section 16).

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

## 16. GO / NO-GO checklist

The approver signs each line. **Any unchecked line, or any HARD BLOCKER in section 15
that applies to this launch, is NO-GO.** A warning in preflight is not a failure; a
failure is.

| # | Gate | Evidence | NO-GO if |
|---|---|---|---|
| 1 | Release is one clean commit, all suites green | step 0.1 | red or dirty |
| 2 | AMR verified stable, or session-start record shipped and tested | `verify-amr` output / commit | **unverified** (today) |
| 3 | Real export rehearsal complete with reconciliation 0 mismatches and anomalies explained | step 0.2 report | **not done** (today) |
| 4 | Payments: closed by decision, or real adapter sandbox-tested and section 17 satisfied | step 0.4 | paid purchases required and no adapter (today) |
| 5 | PostgreSQL 17 production instance, TLS, private network | step 0.5 | unavailable (today) |
| 6 | Backend hosted privately, gates pass | step 0.8 | unavailable (today) |
| 7 | Backups enabled and one restore drill passed | step 0.10 | no backup (today) |
| 8 | Migration + copy reconciliation clean, counts equal | steps 4.3-4.4 | any mismatch |
| 9 | Storage keys all present | step 4.5 | missing keys |
| 10 | Storage authorization validated: every flow in section 18.2 passes on staging | staging run | not validated against a real Supabase Storage project (today) |
| 11 | Preflight OK for both services; freeze verified on and off | steps 0.9, 2.1, 5.3, 6.1 | any FAIL |
| 12 | Alerts live and a test alert received | step 0.11 | no alerting (today) |
| 13 | Rate limiting: single frontend instance, or distributed limiter shipped | spec s.4 | second instance without limiter |
| 14 | Approver and operator both present for the whole window | roster | absent |

## 17. Pending-payment cutover plan

**With payments closed (decision 0.4a):** no provider payment can exist. Step 3.1
proves it with two counts of 0 on the restored source; nothing else is needed.

**With a real provider (decision 0.4b) the following are all required, and today none is
provable because no provider exists, so this is a HARD BLOCKER for a paid launch:**

1. *Before the freeze:* stop new payment sessions early enough for sessions to settle. The code
   has no switch that stops NEW sessions while still accepting webhooks: the freeze (2.1) blocks
   both session creation and webhooks (webhooks answer `503` + `Retry-After`, so a conforming
   provider retries). The adapter work must either add such a switch or the window must be
   longer than the provider's session lifetime.
2. *Settlement window:* sessions already issued either complete during the window (their webhook
   is answered 503 and retried) or expire. The operator records the exact outstanding purchase ids
   (`select id from public.candy_purchases where status = 'pending' and payment_provider is not null`)
   before Phase 4, and re-queries after Phase 4 to detect any that changed.
3. *Before the final export:* compare the provider's settlement report with `paid` purchases; every
   provider success must be `paid` in the source, or be listed as outstanding (item 2).
4. *At the boundary:* a provider success that arrives during the freeze is not lost only if the
   provider retries beyond the window, **a guarantee that must be written from the chosen
   provider's documentation into this section**, and only if, after step 6.1, the operator
   runs a status lookup for every outstanding id (the server-side verification path exists and is
   proven on the stub; a batch reconciler does not exist and must be built with the adapter).
   Crediting stays at-most-once (event de-duplication and the one-transaction credit are proven).
5. If the retry guarantee is unknown, **launch stays blocked.**

## 18. Storage lockdown (`database/ops/supabase-storage-lockdown.sql`)

Static inspection of the SQL (V0.1.55), verified against the Storage policies that
`supabase/migrations` create (`tests/unit/storage-lockdown-static.test.ts`).

**Not automatic.** It is not in `supabase/migrations` or `database/migrations`, no script or
test runs it, and it is documented to run only in phase 7, after the irreversible boundary.

### 18.1 What it removes (17 policies on `storage.objects`; run the pre-check first)

Pre-check (expect these 19 names, 17 to be dropped and 2 to remain):
`select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1;`
If the project has any other policy on `storage.objects` (created in the dashboard), STOP and
review it: the SQL does not touch it.

| Bucket | Removed policies | Kept |
|---|---|---|
| `parent-uploads` | `parent_uploads_insert_own`, `_select_own`, `_delete_own`, `_select_admin` | none |
| `generated-media` | `generated_media_insert_admin`, `_select_admin`, `_update_admin`, `_delete_admin`, `_select_parent` | none (no runtime use) |
| `final-deliverables` | `final_deliverables_insert_admin`, `_select_admin`, `_update_admin`, `_delete_admin`, `_select_parent` | none |
| `example-media` | `example_media_insert_admin`, `_update_admin`, `_delete_admin` | `example_media_select_public` |
| `homepage-media` | none (it never had write policies) | `homepage_media_select_public` |

(The V0.1.54 text said 20 policies, 18 dropped; the migrations define 19 and the SQL drops 17.)

### 18.2 What stops working, and what must keep working (check each IMMEDIATELY after)

Stops (by design): a browser or script using the public anon key plus any Supabase session to
list, upload, download, copy, overwrite or delete objects in `parent-uploads`,
`generated-media`, `final-deliverables`, or to write to `example-media`; admin writes through the
Storage REST API with a user JWT. The application does none of these.

Must keep working (service credential, server-side), each to be exercised and ticked:

1. [ ] Parent submits a request with a new source image (upload to `parent-uploads/<subject>/<order>/<name>`).
2. [ ] Parent submits a request reusing a gallery item (copy within the same subject folder).
3. [ ] Parent order detail shows the source preview (signed URL).
4. [ ] Parent gallery tiles load (batch signed URLs).
5. [ ] Admin request detail shows the parent's source preview.
6. [ ] Admin uploads a final deliverable (upload gate, then upload).
7. [ ] Admin removes a final deliverable (rollback path).
8. [ ] Parent downloads an approved, visible final deliverable (signed URL).
9. [ ] A parent cannot fetch another parent's source or an unapproved final (expect refusal, no URL).
10. [ ] Admin replaces a homepage media slot; public homepage image still loads from its public URL.
11. [ ] Admin publishes example media; public examples still load.
12. [ ] Anonymous user can still read public homepage and example objects.
13. [ ] With the anon key and a parent session, `GET /storage/v1/object/list/parent-uploads` and an upload both answer 4xx (proves the lockdown took effect).
14. [ ] `SUBMISSION_STORAGE_FAILED` and `STORAGE_SIGNED_URL_*` events stay at zero for 30 minutes.

### 18.3 Reverting

Re-apply the `CREATE POLICY` statements from the migrations named beside each group in the SQL
(`20260717210000_private_media_storage.sql`, `20260801120000_request_fulfilment_workflow.sql`,
`20260717090000_examples_cms.sql`). They call `public.is_admin()` / `is_parent()` against the
Supabase copy of `users`, which is stale after the boundary, so reverting restores a browser path
whose authorization is wrong; do it only to diagnose and remove it again.
