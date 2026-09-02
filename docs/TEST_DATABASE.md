# Test Database Configuration

## Main Project (DO NOT USE FOR DESTRUCTIVE TESTS)

- **Project ref:** `oucyhmrnzahlhqjfqcge`
- **URL:** `https://oucyhmrnzahlhqjfqcge.supabase.co`
- **Purpose:** Cartoona production data.

**Never run stateful/destructive tests against this project.**

## Migration Test Project (ALWAYS FORBIDDEN)

- **Project ref:** `guhhlshjvmiwwmixiulk`
- **URL:** `https://guhhlshjvmiwwmixiulk.supabase.co`

Always forbidden, even with matching ref and opt-in.

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_URL` | Supabase project URL (alternative var) |
| `SUPABASE_SECRET_KEY` | Service-role key for test setup/teardown |
| `SUPABASE_PROJECT_REF` | Project ref (cross-checked against URLs) |
| `CARTOONA_ALLOW_DESTRUCTIVE_TESTS` | Must be `"true"` to run stateful tests |
| `CARTOONA_TEST_SUPABASE_PROJECT_REF` | Exact project ref of the approved disposable target |

## Destructive-Test Guard

### All Supplied Identifiers Must Agree

The guard collects **every** non-empty, non-whitespace value from:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_PROJECT_REF`
- `CARTOONA_TEST_SUPABASE_PROJECT_REF`

No variable receives priority. All must resolve to the same target. Any disagreement returns `kind = "unknown"` and is rejected.

### URL Validation

Every supplied Supabase URL must:

- Parse as a valid URL
- Use `http:` or `https:` protocol
- Have no username or password
- Have no query string
- Have no fragment
- Have no non-root path (only `/` or empty path allowed)
- Have a valid hostname

**Rejected examples:**
- `https://ref.supabase.co/path` (has path)
- `https://ref.supabase.co?x=1` (has query)
- `https://ref.supabase.co#frag` (has fragment)
- `https://user:pass@ref.supabase.co` (has credentials)
- `https://ref.supabase.co.evil.example` (lookalike host)
- `not-a-url` (malformed)

For hosted Supabase: hostname must be exactly `<project-ref>.supabase.co`.

For local Supabase: recognizes `localhost`, `127.0.0.1`, `::1`. Bracketed IPv6 `[::1]` is normalized to `::1`.

### Agreement Rules

- **Multiple hosted URLs** → every URL must identify the same project ref.
- **Hosted URL + `SUPABASE_PROJECT_REF`** → must match exactly.
- **Hosted URL + `CARTOONA_TEST_SUPABASE_PROJECT_REF`** → must match exactly.
- **`SUPABASE_PROJECT_REF` + `CARTOONA_TEST_SUPABASE_PROJECT_REF`** → must match exactly.
- **Local URLs** → `localhost`, `127.0.0.1`, and `::1` are equivalent loopback hosts. Ports must match across all local URLs.
- **Local + hosted** → any mix is rejected.
- **Main project anywhere** → rejected unconditionally, even hidden behind a secondary disposable-looking identifier.
- **Migration Test project anywhere** → rejected unconditionally, even hidden behind a secondary identifier.

### Acceptance Conditions

Only these targets may pass:

1. **Local**
   - Every supplied identifier resolves consistently to the same local endpoint.
   - `CARTOONA_ALLOW_DESTRUCTIVE_TESTS=true`.
   - Local ports agree.

2. **Explicit disposable hosted project**
   - `CARTOONA_ALLOW_DESTRUCTIVE_TESTS=true`.
   - `CARTOONA_TEST_SUPABASE_PROJECT_REF` is present.
   - At least one valid hosted Supabase URL is present.
   - Every supplied hosted URL resolves to that exact ref.
   - `SUPABASE_PROJECT_REF`, when present, equals that ref.
   - Ref is neither the main project nor Migration Test project.

### Result Model

| Kind | Meaning |
|---|---|
| `main` | The main Cartoona project `oucyhmrnzahlhqjfqcge` |
| `forbidden_known_project` | The Cartoona Migration Test project `guhhlshjvmiwwmixiulk` |
| `local` | Localhost, 127.0.0.1, or ::1 Supabase |
| `explicit_disposable` | Remote supabase.co project matching `CARTOONA_TEST_SUPABASE_PROJECT_REF` with opt-in |
| `unknown` | Unidentifiable, conflicting, malformed, lookalike, or non-allowlisted remote project |

Only `local` and `explicit_disposable` may return `ok = true`, and only with `CARTOONA_ALLOW_DESTRUCTIVE_TESTS=true`.

### Guard Unit Tests

`tests/unit/assert-safe-database-target.test.ts` — 33 test cases:

| # | Scenario | Result | Kind |
|---|---|---|---|
| 1 | Main URL alone | Rejected | `main` |
| 2 | Main URL + opt-in | Rejected | `main` |
| 3 | Main URL + disposable secondary URL | Rejected | `main` |
| 4 | Main project ref + disposable URL | Rejected | `main` |
| 5 | Migration Test URL alone | Rejected | `forbidden_known_project` |
| 6 | Migration Test URL + disposable secondary | Rejected | `forbidden_known_project` |
| 7 | Migration Test ref + disposable URL | Rejected | `forbidden_known_project` |
| 8 | Both URL vars same hosted ref + test ref + opt-in | Accepted | `explicit_disposable` |
| 9 | Both URL vars different refs | Rejected | `unknown` |
| 10 | URL and SUPABASE_PROJECT_REF disagree | Rejected | `unknown` |
| 11 | URL and explicit test ref disagree | Rejected | `unknown` |
| 12 | SUPABASE_PROJECT_REF and test ref disagree | Rejected | `unknown` |
| 13 | Local + hosted mix | Rejected | `unknown` |
| 14 | localhost + 127.0.0.1 same port + opt-in | Accepted | `local` |
| 15 | localhost + ::1 same port + opt-in | Accepted | `local` |
| 16 | Different local ports | Rejected | `unknown` |
| 17 | Local without opt-in | Rejected | `local` |
| 18 | Arbitrary hosted without test ref | Rejected | `unknown` |
| 19 | Exact disposable + opt-in | Accepted | `explicit_disposable` |
| 20 | Exact disposable without opt-in | Rejected | `explicit_disposable` |
| 21 | Empty strings ignored | Accepted | `explicit_disposable` |
| 22 | Whitespace-only ignored | Accepted | `explicit_disposable` |
| 23 | URL with path | Rejected | `unknown` |
| 24 | URL with query | Rejected | `unknown` |
| 25 | URL with fragment | Rejected | `unknown` |
| 26 | URL with credentials | Rejected | `unknown` |
| 27 | Lookalike hostname | Rejected | `unknown` |
| 28 | Uppercase hostname | Accepted | `explicit_disposable` |
| 29 | Malformed URL | Rejected | `unknown` |
| 30 | All identifiers absent | Rejected | `unknown` |
| 31 | Duplicate equivalent URLs | Accepted | `explicit_disposable` |
| 32 | NEXT_PUBLIC disposable, SUPABASE_URL main | Rejected | `main` |
| 33 | NEXT_PUBLIC main, SUPABASE_URL disposable | Rejected | `main` |

### Guard Smoke Test

`tests/helpers/guard-smoke.ts` — standalone script (no test framework needed):

```bash
npx tsx tests/helpers/guard-smoke.ts
```

Validates: main hidden behind disposable, Migration Test hidden behind disposable, conflicting URLs, URL/ref conflict, URL/test-ref conflict, local/hosted conflict, equivalent local hosts, different local ports, explicit disposable acceptance, unknown rejection.

### Main-Project Rejection Example

```text
Error: Guard blocked: Refusing to run destructive tests against the main Cartoona
project (oucyhmrnzahlhqjfqcge).
```

### Migration Test Project Rejection Example

```text
Error: Guard blocked: Refusing to run destructive tests against the forbidden
project "guhhlshjvmiwwmixiulk".
```

## Running Tests Against a Disposable Database

### Option A: Local Supabase (requires Docker)

```bash
npx supabase start
npx supabase db push
export CARTOONA_ALLOW_DESTRUCTIVE_TESTS=true
npx playwright test tests/e2e/admin-referral-db.spec.ts
npx playwright test tests/e2e/coupon-api.spec.ts
npx playwright test tests/e2e/admin-coupons-api.spec.ts
npx supabase stop
```

### Option B: Explicit Disposable Remote Supabase

The guard requires `CARTOONA_ALLOW_DESTRUCTIVE_TESTS=true` and every supplied identifier
to resolve to the same ref declared in `CARTOONA_TEST_SUPABASE_PROJECT_REF`.

```bash
export NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SECRET_KEY=<service-role-key>
export CARTOONA_TEST_SUPABASE_PROJECT_REF=<ref>
export CARTOONA_ALLOW_DESTRUCTIVE_TESTS=true
npx playwright test tests/e2e/admin-referral-db.spec.ts
npx playwright test tests/e2e/coupon-api.spec.ts
npx playwright test tests/e2e/admin-coupons-api.spec.ts
```

**Arbitrary non-main Supabase projects are NOT accepted** — the exact ref must
be declared. Do not set `CARTOONA_TEST_SUPABASE_PROJECT_REF` to the main project
ref or the migration test project ref; those are hard-rejected.

## Test Suite Classification

### Payment-Completion Tests (Stateful — requires service-role key)

| Suite | Mutations | Requirements |
|---|---|---|
| `candy-billing-dashboard.spec.ts` | Auth users, parent_profiles, candy_purchases, candy_wallets, candy_transactions | Auth, dev server, `CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION=true` |
| `candy-purchase-api.spec.ts` | Auth users, parent_profiles, candy_purchases, candy_wallets, candy_transactions | Auth Admin API, service-role key, simulation enabled |

All payment-completion tests are stateful and **must never run against the main Supabase project**.
Privilege-verification tests (read-only catalog inspection) are safe against main.

### Coupon Tests (Stateful — requires service-role key, disposable/local target only)

| Suite | Mutations | Requirements |
|---|---|---|
| `coupon-api.spec.ts` | Auth users, parent_profiles, candy_packages, candy_purchases, coupons, coupon_package_rules, coupon_redemptions, payment_attempts | Auth Admin API, service-role key, dev server, migration `20260801100000` applied |
| `admin-coupons-api.spec.ts` | Auth users, coupons, coupon_package_rules | Auth Admin API, service-role key, dev server, migrations `20260801100000` + `20260801110000` applied |

`coupon-api.spec.ts` calls `assertSafeDatabaseTarget()` at module scope and throws
against the main project. It exercises: coupon enumeration protection, no browser
writes to coupon tables, trusted-RPC privilege denial for browser roles, validate
(read-only) and apply (atomic, idempotent) behavior, usage limits, package
eligibility, inactive/not-started/expired codes, fixed-amount clamping, unknown
field/format rejection, and auth rejection. **Status: guarded, unexecuted** —
requires a disposable or local Supabase target (see options below).

`admin-coupons-api.spec.ts` (18 scenarios) exercises the Admin coupon surface on a
disposable/local target only: 401 unauth / 403 non-admin, create, duplicate-code
409, field validation 422, list filters and pageSize cap, detail + created-by,
update + optimistic-concurrency 409, scheduled status, package rules, invalid
package 422, public-role RPC denial, and no-redemption-id/parent-identity leakage
in list responses. **Status: guarded, unexecuted.**

Pure coupon logic is covered by `tests/unit/coupon-rules.test.ts` (142 tests) and
`tests/unit/admin-coupons.test.ts` (33 tests) — no database, safe to run anywhere.

### Destructive / Audit-Producing

| Suite | Mutations | Requirements |
|---|---|---|
| `admin-referral-db.spec.ts` | Auth users, parent_profiles, referral_relationships, referral_program_settings_history | Auth Admin API, settings RPC |
| `admin-referral-api.spec.ts` | Auth users, parent_profiles, referral_relationships, referral_program_settings_history | Auth Admin API, settings RPC |
| `referral-dashboard.spec.ts` | Auth users, parent_profiles, referral_relationships, referral_program_settings, history | Auth Admin API, dev server |
| `referral-api.spec.ts` | Auth users, parent_profiles, referral_relationships | Auth Admin API |
| `live-price-change.spec.ts` | creation_pricing row mutation (restored) | Auth Admin API, service-role key |
| `login-destinations.spec.ts` | Auth users, parent_profiles | Auth Admin API, dev server, dev auth |

### Mocked-UI (no coupon mutation; synthetic admin Auth user cleaned up)

| Suite | Mutations | Requirements |
|---|---|---|
| `admin-coupons-dashboard.spec.ts` | Auth users (1 synthetic admin, deleted in afterAll) | Dev server; mocks `/api/admin/coupons*` via `page.route` |

40 scenarios covering the admin coupon dashboard: header/create link, list
table + mobile cards, discount summaries (percent/fixed/cap), status badges,
usage/reserved summaries, edit navigation, search/filter controls and refetch,
pagination, empty / filtered-empty / error + retry states, create form fields,
validation, code-normalization preview, type hints, expiry-before-start error,
submit JSON shape + redirect, edit prefill, immutable fields for used coupons,
PATCH `expectedUpdatedAt`, confirm dialog (open/cancel/Escape/confirm), conflict
message, server field-error render, cancel-to-list, and package-restriction
toggle. No coupon rows are created on any target.

### Request-Fulfilment Tests (Stateful — requires service-role key, disposable/local target only)

Requires migration `20260801120000_request_fulfilment_workflow.sql` applied
(order_status_history, media_assets extension, `final-deliverables` bucket, 4
trusted RPCs, 2 read functions).

| Suite | Mutations | Requirements |
|---|---|---|
| `admin-request-fulfilment-db.spec.ts` | Auth users, orders, media_assets, order_status_history, storage objects in `final-deliverables` | Auth Admin API, service-role key, dev server |
| `admin-request-fulfilment-ui.spec.ts` | Auth users, orders (mocks `/api/admin/requests/*` mutations via `page.route`) | Dev server |

`admin-request-fulfilment-db.spec.ts` (11 scenarios) exercises the real trusted
RPC/API round-trips: invalid transition → 422, rejection without reason → 422,
stale `expectedUpdatedAt` → 409, valid transition + atomic history append,
upload → `uploaded`/not-visible, parent cannot read unapproved finals, approve →
`approved` + parent-visible, `ready` unlock, terminal status never reopens,
supersede hides permanently, and history append-only (direct UPDATE refused).

`admin-request-fulfilment-ui.spec.ts` (10 scenarios) renders the real queue +
detail pages and verifies: queue legend + status dot, status filter, detail
sections (status form, final-media upload, history), allowed-next statuses,
PATCH payload shape, 409 conflict rendering, rejection reason validation, file
input, and empty history state.

### Read-Only (safe against main project)

| Suite | Requirements |
|---|---|
| `pricing-api.spec.ts` | Dev server (API queries only) |
| `creation-page-pricing.spec.ts` | Dev server (UI pricing display only) |
| `payment-simulation-policy.test.ts` (unit) | No database — environment variable behavior only |
| `request-rpc-error.test.ts` (unit) | No database — RPC error-code → HTTP-status mapping only |
| `payment-rules.test.ts` (unit) | No database — pure provider-neutral payment rules (status, amounts, idempotency, serialization) |

Payment-attempt and webhook foundation is DDL-only. No API route or webhook route exists yet, so there are no stateful payment-attempt tests. When provider integration (or a disposable target) arrives, stateful tests for `payment_attempts` / `payment_webhook_events` (attempt creation, session recording, dedup) **must never run against the main Supabase project**.

### Summary

| Suite | Guard | Mutates DB? | Creates Auth Users? | Requires Auth Admin? | Requires Storage? |
|---|---|---|---|---|---|
| admin-referral-db.spec.ts | Module-scope throw | Yes | Yes (4) | Yes | No |
| admin-referral-api.spec.ts | Module-scope throw | Yes | Yes (4) | Yes | No |
| referral-dashboard.spec.ts | Module-scope throw | Yes | Yes (4) | Yes | No |
| referral-api.spec.ts | Module-scope throw | Yes | Yes (3) | Yes | No |
| live-price-change.spec.ts | Module-scope throw | Yes | No | Yes | No |
| login-destinations.spec.ts | Module-scope throw | Yes | Yes (2) | Yes | No |
| coupon-api.spec.ts | Module-scope throw | Yes | Yes (3) | Yes | No |
| admin-coupons-api.spec.ts | Module-scope throw | Yes | Yes (2) | Yes | No |
| admin-coupons-dashboard.spec.ts | Module-scope throw | Mocked (none) | Yes (1) | No | No |
| admin-request-fulfilment-db.spec.ts | Module-scope throw | Yes | Yes (2) | Yes | Yes |
| admin-request-fulfilment-ui.spec.ts | Module-scope throw | Mocked (none) | Yes (1) | No | No |
| pricing-api.spec.ts | No | No | No | No | No |
| creation-page-pricing.spec.ts | No | No | No | No | No |

## Running Repeated Flake Checks

These commands require a safe disposable/local target. Do not run against the main
project — the guard blocks them.

### Referral Dashboard (3 previously flaky tests)

```bash
# Individual flaky test ×10
for i in $(seq 10); do
  npx playwright test "tests/e2e/referral-dashboard.spec.ts" \
    --grep "bound state has no edit" --reporter=list
done

# Group of flaky tests ×10
for i in $(seq 10); do
  npx playwright test "tests/e2e/referral-dashboard.spec.ts" \
    --grep "bound state|already-bound|no wallet" --reporter=list
done

# Full spec
npx playwright test tests/e2e/referral-dashboard.spec.ts --reporter=list
```

### Login Traversal (2 previously flaky tests)

```bash
# Individual ×10
for i in $(seq 10); do
  npx playwright test "tests/e2e/login-destinations.spec.ts" \
    --grep "Unsafe path-traversal" --reporter=list
done

for i in $(seq 10); do
  npx playwright test "tests/e2e/login-destinations.spec.ts" \
    --grep "Unsafe encoded-traversal" --reporter=list
done

# Together ×10
for i in $(seq 10); do
  npx playwright test "tests/e2e/login-destinations.spec.ts" \
    --grep "Unsafe path-traversal|Unsafe encoded-traversal" --reporter=list
done

# Full spec
npx playwright test tests/e2e/login-destinations.spec.ts --reporter=list
```

### Required Environment for Flake Checks

```bash
export CARTOONA_ALLOW_DESTRUCTIVE_TESTS=true
export CARTOONA_TEST_SUPABASE_PROJECT_REF=<explicit-disposable-ref>
export NEXT_PUBLIC_SUPABASE_URL=https://<explicit-disposable-ref>.supabase.co
export SUPABASE_SECRET_KEY=<service-role-key>
```

Do not include secrets in scripts. Do not fall back to the main project.

**Status: PENDING** — repeated flake validation requires a disposable or local
Supabase target. Docker is unavailable. No disposable remote project is configured.

## Regression Suites

### Read-Only Regression Suite

Safe against the main project. 19 tests covering pricing API and creation-page UI.

```bash
npx playwright test tests/e2e/pricing-api.spec.ts tests/e2e/creation-page-pricing.spec.ts --reporter=list
```

### Full Stateful Regression

Requires explicit disposable or local target.

```bash
npx playwright test tests/e2e/
```

## Cleanup Expectations

Stateful tests must clean up after themselves via `afterAll`:

- Delete synthetic Auth users (`auth/v1/admin/users/{id}`).
- Restore modified settings to original state.
- Restore `creation_pricing` rows to original values.

However, cleanup is not a substitute for running against disposable infrastructure.
Immutable audit tables (like `referral_program_settings_history`) retain test artifacts
permanently, and cleanup migrations should be created after test runs.

## Important Notes

- **All supplied identifiers must agree.** No environment variable receives priority.
  `NEXT_PUBLIC_SUPABASE_URL` has no priority over `SUPABASE_URL`.
- **URL/ref disagreement fails closed.** Any disagreement returns `kind = "unknown"`.
- **Main or Migration Test appearing in any identifier blocks execution.**
  Even if another identifier looks like a disposable target, the presence of a
  forbidden ref causes immediate rejection.
- **Local loopback equivalence**: `localhost`, `127.0.0.1`, and `::1` are considered
  equivalent, but ports must match.
- **Paths, queries, fragments, and credentials in URLs are rejected.**
- **Empty-string and whitespace-only variables are treated as absent.**
- **Arbitrary non-main `*.supabase.co` projects are NOT safe.** Only local or an
  explicitly declared (via `CARTOONA_TEST_SUPABASE_PROJECT_REF`) remote project is
  accepted.
- **Repeated flake validation remains PENDING** until a disposable or local
  Supabase target becomes available.
