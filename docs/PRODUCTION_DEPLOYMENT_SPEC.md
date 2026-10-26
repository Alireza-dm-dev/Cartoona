# Production deployment specification (V0.1.55)

What the production environment must provide, and how to know it does. Companion to
`docs/PRODUCTION_CUTOVER.md` (the runbook, blocker matrix and go/no-go list). No secret
value appears here; names and shapes only. Hosting providers are deliberately not chosen.

Topology: **Browser -> (TLS) Next.js frontend/BFF -> (private network) Fastify backend -> PostgreSQL 17.**
Supabase remains for Auth and Storage object bytes only; runtime Supabase **database** usage is zero.

## 1. PostgreSQL

| Item | Requirement |
|---|---|
| Version | **PostgreSQL 17** (major 17 exactly; `cutover:check` fails otherwise). Extension `pgcrypto` available (migration 0001 runs `CREATE EXTENSION IF NOT EXISTS pgcrypto`; on a managed service the owner role must be allowed to, or the provider pre-installs it). |
| Database | `cartoona` (UTF8). One database, one schema in use: `public`. |
| Owner / migration role | e.g. `cartoona_owner`: owns every object, applies migrations and the data copy, used from the bastion only. **No running service uses it.** The backend refuses to start on it. |
| App group role | `cartoona_app` (`NOLOGIN`), created by migration 0009. Column `UPDATE` on `parent_profiles(full_name, updated_at)` only; `EXECUTE` on the audited `SECURITY DEFINER` `*_trusted` and provisioning functions; nothing granted to `PUBLIC`. |
| App login role | `cartoona_app_<name>` (e.g. `cartoona_app_prod`): member of `cartoona_app`; not superuser/createdb/createrole/replication/bypassrls; owns nothing in `public`. Created by `database/ops/create-app-login-role.sql` (password from `openssl rand -hex 32`, never on a command line). The backend startup gate and `/ready` verify all of this. |
| TLS | Server TLS 1.2+ mandatory (`hostssl` only, `scram-sha-256`). Backend: `DB_SSL_MODE=verify-full` (certificate chain **and** host name verified) plus `DB_SSL_CA` if the provider's CA is not in Node's store. `DATABASE_URL` must not carry query parameters. **V0.1.55 added this setting; a real TLS handshake has not been exercised (no TLS-enabled PostgreSQL available locally); first connection in staging is the proof.** |
| Connections | Server `max_connections` >= 100. Budget: `backend_instances x DB_POOL_MAX` + 10 for operators/backups. Default `DB_POOL_MAX=5` per backend process; rehearsed at 5 and 20 (50 concurrent clients, 0 errors, p95 36-45 ms on synthetic data). Per-statement timeout 15 s is fixed in the application; connection checkout timeout 5 s. |
| Maintenance access | Bastion/VPN only, named operator accounts with MFA, owner login used interactively, session logging on. No public IP, no 0.0.0.0/0 rule. |
| Network | Ingress 5432 only from (a) the backend's subnet/security group and (b) the bastion. Nothing from the frontend, the internet, or Supabase. |

### 1.5 Backups and recovery (required before cutover; none exists yet)

* Continuous WAL archiving / provider PITR, **RPO <= 5 minutes**, retention >= 7 days PITR.
* Daily logical `pg_dump -Fc`, kept 30 days, encrypted at rest, stored in a separate account/region.
* **RTO <= 1 hour.** A restore drill is mandatory before cutover (runbook 0.10) and quarterly: restore the latest
  backup into a scratch database; run `npm run cutover:check` against it (migrations 19/19 with checksums, extensions, roles
  present); create the app login role; start a backend on it and require `/ready` 200; run the Storage key checker.
* Restored databases do not carry login roles' passwords unchanged across providers: re-run `create-app-login-role.sql` and
  re-check grants (`/ready` performs the role and migration-head checks).
* Not performed in V0.1.55: no production-like hosting exists. **INFRASTRUCTURE REQUIRED.**

## 2. Backend (Fastify)

| Item | Requirement |
|---|---|
| Runtime | Node **24** (the Dockerfile default `NODE_VERSION=24`, `node:24-bookworm-slim`), single process, non-root user `backend`. |
| Image | Built from `backend/Dockerfile` at the release commit; runtime stage contains `server.cjs` and `healthcheck.mjs` only. Record the digest in the release note. |
| Port / host | `BACKEND_PORT` (default 4000), `BACKEND_HOST=0.0.0.0` in a container. |
| Networking | **Private only.** No public load balancer, no public DNS, no CORS. Reachable from the frontend's network only. The browser must never reach it: it accepts nothing without an HMAC identity assertion, but exposure is still a deployment error. `cutover:check` cannot prove the absence of a public route; verify with an external probe from the internet (`curl` must fail to connect). |
| Liveness | `GET /health`: process is up; **never** touches the database. |
| Readiness | `GET /ready`: `SELECT 1` every call; first success per process also verifies the restricted role and the migration head; 503 `{"status":"unavailable"}` otherwise. The orchestrator routes traffic only on `/ready` 200. Liveness must never be used as readiness. |
| Required env | `DATABASE_URL`, `CARTOONA_INTERNAL_AUTH_SECRET`, `NODE_ENV=production`, `DB_SSL_MODE`. Optional: `DB_SSL_CA`, `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`, `BACKEND_PORT`, `BACKEND_HOST`, `LOG_LEVEL`. Forbidden: `SUPABASE_*`, `CARTOONA_PAYMENT_*`, `BACKEND_INTERNAL_URL`. Check with `npm run production:preflight -- --service backend`. |
| Startup gates | Missing/weak internal secret, invalid `DATABASE_URL` or a Supabase host: exit 1. With `NODE_ENV=production` a reachable database that is wrong (owner/superuser/privileged login, `cartoona_app` membership missing, schema behind the build) exits 1. An **unreachable** database does not stop the process; `/ready` reports 503. |
| Schema version | The build requires migration head 0019 (`HEAD_PROBE` in `lib/db/health.ts`, pinned by `tests/unit/startup-gate.test.ts`). Apply migrations **before** starting a new backend. |
| Graceful shutdown | SIGTERM/SIGINT: stop accepting, drain in-flight requests, close the pool, exit 0. Set the orchestrator grace period >= 30 s. |
| Logs | One JSON object per line on stdout/stderr (allow-listed fields only; no PII, no keys, no URLs). Destination: the platform's log collector -> the alerting system (section 5). Not chosen. |
| Request id | The frontend sends `X-Request-Id`; the backend validates it (or generates one), logs it in every event, and echoes it in the response; the frontend logs the echoed id, so one id spans browser error -> frontend -> backend. |

## 3. Frontend (Next.js)

| Variable | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` | build + run, **public** | baked into the browser bundle by design |
| `SUPABASE_SECRET_KEY` | run, server only | Storage bytes only; read by `lib/supabase/admin.ts` (Storage-only type) |
| `CARTOONA_INTERNAL_AUTH_SECRET` | run, server only | same value as the backend; hex >= 32 bytes |
| `BACKEND_INTERNAL_URL` | run, server only | plain `http(s)://host[:port]`, private address; never `NEXT_PUBLIC_*` |
| `CARTOONA_APP_ORIGIN` | run | exact public https origin(s); production refuses browser writes when unset |
| `RATE_LIMIT_HASH_SECRET`, `RATE_LIMIT_TRUSTED_IP_HEADER` | run | header must be the one the real proxy sets |
| `CARTOONA_PAYMENT_PROVIDER` + provider secrets | run, server only | unset today (payments closed); only the safe/public values may ever be client-visible |
| `CARTOONA_WRITE_FREEZE` | run | `1` only during the cutover window |
| Must be unset | | `DATABASE_URL`, `POSTGRES_*`, `CARTOONA_APP_DB_PASSWORD`, `DEV_PARENT_AUTH_*`, `RATE_LIMIT_DISABLED`, `CARTOONA_TEST_*`, `CARTOONA_PAYMENT_STUB_*` |

`npm run production:preflight -- --service frontend --expect-freeze off [--payments required]` checks all of this
without printing a value, without network access and without writing anything.

**Build-output secret scan (V0.1.55, run on the production `next build`).** The scan reads the secret-bearing values from
`.env.local` and `.env.docker` (12 values: service key, internal secret, database passwords and URLs, test keys) and searches
every file under `.next/static` (client-visible, 40 files, 1.4 MB) and `.next/server` (1,206 files, 35 MB) by value, plus
patterns (a database URL with an embedded password, the `sb_secret_` prefix, the service-role JWT shape), plus the names `BACKEND_INTERNAL_URL`,
`CARTOONA_INTERNAL_AUTH_SECRET`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `CARTOONA_PAYMENT`, `RATE_LIMIT_HASH_SECRET` in the
client bundle. Result: **no secret value or credential pattern in either tree; none of the names in the client bundle.** One
value matched: the Supabase **anon (publishable)** key, which is identical to `NEXT_PUBLIC_SUPABASE_ANON_KEY` and public by
design. A provider secret could not be scanned (no provider exists). Re-run the scan against the production-environment
build before release; the operator's variant simply feeds the real secret values from the secret store.

## 4. Rate limiting decision

The limiter is **in memory, per frontend process** (`docs/rate-limiting.md`).

* **Decision for launch: exactly one frontend instance.** Limits (for example 5 request submissions per minute per parent) are
  then exact. `production:preflight` cannot detect the instance count; the go/no-go list (gate 13) requires the approver to
  confirm it.
* With **N > 1 instances** the effective limit is up to N times higher and instances do not share windows. That is acceptable
  for nothing the product relies on for abuse control, so **a second instance is a HARD BLOCKER** until a shared limiter exists.
* Recommended interface (no provider chosen): keep `enforceRateLimit(policy, key)` unchanged and put a `RateLimitStore`
  behind it with one atomic operation `increment(key, windowSeconds) -> { count, resetAt }`; selected by
  `RATE_LIMIT_STORE_URL` (unset = in-memory). A store failure must keep today's fail-open/fail-closed per policy decision
  (`RATE_LIMITER_FAILED` is already logged). Backend (Fastify) needs none: only the frontend is public.

## 5. Observability and alerts (no PII anywhere)

All events below are emitted today by the code (names verified in V0.1.55). The log platform and pager are not chosen.
Queries are written as field filters on the JSON log lines: `event`, `level`, `subsystem`, `errorCode`, `reason`, `status`, `route`.

| Alert | Condition (filter -> threshold) | Severity |
|---|---|---|
| Backend not ready | external probe `/ready` != 200 for 2 min; or `event=READINESS_FAILED` | page |
| DB connection failure | `event=READINESS_FAILED subsystem=database` (any), or `PURCHASE_DB_FAILED`/`REQUEST_FAILED`/`ADMIN_REQUEST_DB_FAILED`/`ORDERS_PAGE_FAILED` combined > 5 / 5 min | page |
| Role/schema gate | `READINESS_FAILED reason in (db_role_*, schema_*)`; `BACKEND_START_FAILED` | page |
| Sustained 5xx | `status>=500` / all `BACKEND_REQUEST_COMPLETED` (and frontend equivalent) > 2 % for 5 min | page |
| Auth provider outage | `event=AUTH_USER_LOOKUP_FAILED` or `errorCode=AUTH_UNAVAILABLE` > 10 / 5 min; `SESSION_CHECK_UNAVAILABLE` responses | page |
| Storage failure | `SUBMISSION_STORAGE_FAILED`, `STORAGE_SIGNED_URL_FAILED`, `STORAGE_SIGNED_URL_BATCH_FAILED`, `FINAL_MEDIA_SIGN_FAILED` > 5 / 10 min | warn; page after lockdown (phase 7) |
| Payment confirmation failure | `PAYMENT_WEBHOOK_REJECTED`, `PAYMENT_EVENT_FAILED`, `PAYMENT_RETURN_VERIFY_FAILED`, `PAYMENT_PROVIDER_FAILED` any > 3 / 10 min (only once a provider exists) | page |
| Request-creation failure | `REQUEST_FAILED level=error`, `SUBMISSION_BACKEND_CONTRACT_VIOLATION` (any), `REQUEST_OUTCOME_UNKNOWN` > 3 / 10 min | page |
| Fulfilment failure | `ADMIN_REQUEST_DB_FAILED`, `FINAL_MEDIA_SIGN_FAILED`, `AUDIT_WRITE_FAILED` (any) | warn; page for `AUDIT_WRITE_FAILED` |
| Restart loop | > 3 `BACKEND_LISTENING` / 10 min | page |
| Pool pressure | backend p95 `durationMs` > 1 s for 10 min | warn |
| Freeze left on | `CSRF_REJECTED errorCode=write_freeze` after the window closes | page |
| Rate limiter broken | `RATE_LIMITER_FAILED` > 0 | warn |

Dashboards: request rate and 5xx by route; p50/p95 `durationMs`; `/ready` status; counts of the events above; DB connections
used vs `max_connections`.

## 6. Smoke plan and monitoring window

Never run against production by this repository; operator-run, after phase 6 (writes enabled), with the smoke accounts.

**Anonymous:** homepage loads with CMS media; examples list and one detail.
**Parent:** sign in; account page; consent (new parent) accepted once; referral link bind (idempotent); candy balance;
purchase page (with payments closed: shows the unavailable state, no error); submit a request with an uploaded image and
one reusing a gallery item; orders list; order detail with source preview; gallery tiles load; (if a provider exists:
purchase -> provider sandbox -> confirmation -> exactly one wallet credit).
**Admin:** sign in; request queue; request detail with parent source preview; status transition; upload and remove a
final deliverable; parent sees the approved final; homepage CMS edit + media slot; examples CMS create/publish; referral
settings edit; coupon create/update.

**Monitoring window (first 24 h; strictest for the first 60 minutes).** No production baseline exists, so thresholds are
absolute and conservative, to be tightened from the first day's data:

| Signal | Watch | STOP / rollback-forward trigger |
|---|---|---|
| Backend 5xx | rate over 5 min | > 2 % for 5 min, or any `SUBMISSION_BACKEND_CONTRACT_VIOLATION` |
| `/ready` | continuously | any 503 > 2 min |
| DB errors | `READINESS_FAILED subsystem=database`, pool wait p95 | repeated; pool wait p95 > 1 s |
| Auth failures | `AUTH_REJECTED` vs successes; `AUTH_USER_LOOKUP_FAILED` | rejection share suddenly > 3x the first hour's, or lookup failures > 10 / 5 min |
| Request errors | `REQUEST_FAILED`, `REQUEST_OUTCOME_UNKNOWN` | > 3 / 10 min |
| Storage errors | `SUBMISSION_STORAGE_FAILED`, `STORAGE_SIGNED_URL_*` | > 5 / 10 min; any right after lockdown (see runbook 18.3) |
| Payment | webhook/return failures; hourly operator check (read-only) that every `paid` purchase has exactly one purchase credit in `candy_transactions` and no wallet balance is negative (the CHECK enforces the latter). The first query depends on the adapter's reference columns and is written with the adapter; with payments closed there are no paid purchases | any missing or duplicate credit |
| Fulfilment | `ADMIN_REQUEST_DB_FAILED`, `AUDIT_WRITE_FAILED` | any `AUDIT_WRITE_FAILED` |

"STOP" after the irreversible boundary means: freeze writes (`CARTOONA_WRITE_FREEZE=1`), investigate, roll **forward**
(fix and redeploy, or restore PostgreSQL from PITR). There is no return to the Supabase writer.

## 7. Refund policy decision memo (PRODUCT DECISION)

Current behaviour, **preserved**: a rejected or cancelled request does **not** refund candies; a paid purchase is credited once and never reversed.
No code change is made without the product owner's explicit choice. Not launch-blocking unless the owner says it is.

| Option | Customer impact | Abuse risk | Accounting complexity | Engineering scope |
|---|---|---|---|---|
| **A. No refund** (current) | Candies lost on rejection; the most likely source of complaints and chargebacks | none from refunds | none | terms-of-service wording only |
| **B. Automatic full refund** on rejected/cancelled request | best experience | an attacker can submit-and-cancel to probe moderation at no cost; farmed rejections | a reversal ledger type, negative-balance rule when candies were already spent | ledger `refund` transaction in the status-transition function, idempotent per order, tests; no provider API needed if refunding candies (not money) |
| **C. Admin-controlled refund** | fair, slower | low (a human decides) | needs reason codes and audit entries | B plus an admin screen, permission, audit |
| **D. Conditional refund** (e.g. only if rejected by us, not cancelled by the parent; or within N days) | middle | low-medium | eligibility rules must be explainable | C plus the rule engine and copy |

Note that "refund candies" (ledger credit) and "refund money" (provider API) are different decisions; money refunds depend on
the unchosen payment provider. Recommendation: ship with A and say so in the terms; decide B/C/D with the provider.
