# Forensic Audit — July 29, 2026

## Why This Audit Was Performed

Cartoona's main Supabase project (`oucyhmrnzahlhqjfqcge`) accumulated synthetic test and seed
artifacts during development before a destructive-test guard was implemented. This audit was
performed to:

1. Quantify all synthetic artifacts in the main project.
2. Confirm no real parent/customer data existed.
3. Build a deterministic, reproducible cleanup migration.
4. Apply the migration and verify the result.

## Evidence That No Real Parent/Customer Data Existed

- **0 candy transactions** — no financial activity ever occurred.
- **0 orders** — no request was ever submitted.
- **0 child profiles** — no child was ever registered.
- **0 media assets** — no user-generated content was uploaded.
- **0 audit/moderation logs** — no admin action was taken.
- **All 75 wallets had 0 balance** — no candy was ever earned or spent.
- **All 102 referral relationships were orphaned** — both referrer and referred
  parent IDs were NULL, and all fell within documented test windows.

The only non-synthetic accounts were two administrative gmail.com addresses created
on July 17. Neither had a parent profile, wallet, referral relationships, or any
customer data.

## Aggregate Before State

| Table | Before | After |
|---|---|---|
| `auth.users` | 99 | 2 |
| `public.users` | 99 | 2 |
| `public.users (role=parent)` | 70 | 0 |
| `parent_profiles` | 75 | 0 |
| `candy_wallets` | 75 | 0 |
| `candy_transactions` | 0 | 0 |
| `referral_relationships` | 102 | 0 |
| `referral_binding_rate_limits` | 0 | 0 |
| `referral_program_settings_history` | 0 | 0 |
| `orders` | 0 | 0 |
| `child_profiles` | 0 | 0 |
| `audit_logs` / `moderation_logs` | 0 | 0 |
| `media_assets` / `video_requests` / etc. | 0 | 0 |
| `creation_pricing` | 9 | 9 |
| `referral_program_settings` | 1 (enabled, 1500 bps) | 1 (unchanged) |

## Synthetic Naming and Metadata Patterns

### Email Domains (all proven synthetic)

| Domain | Count | Origin |
|---|---|---|
| `@test.com` | 34 | Unit/integration test fixtures |
| `@dev.cartoona.example` | 34 | Dev-auth phone-derived users |
| `@t.co` | 26 | Phone-auth auto-generated emails |
| `@test.co` | 1 | Seed data |
| `@test.cartoona.local` | 1 | Local development test |
| `@cartoona.dev` | 1 | Seed "test parent" account |
| `(null email)` | 1 | Seed user (same as `@cartoona.dev`) |

### Email Prefixes (subset of `@test.com` users)

- `db_admin_*` — admin-referral-db test suite
- `adm_api_*` / `sup_api_*` — admin-referral-api test suite
- `par_api_*` / `par2_api_*` — admin-referral-api (parent test users)
- `ref_owner_*` / `ref_target_*` / `ref_third_*` — referral-api test suite
- `dash_owner_*` / `dash_bind_*` / `dash_bound_*` / `dash_unauth_*` — referral-dashboard test suite
- `dbg_owner_*` / `dbg_bind_*` — debug test sessions
- `d_owner_*` / `d_bind_*` — debug test sessions
- `test_adm_*` — Unit admin test
- `test-*` / `jwt-test-*` / `c3-*` — Seed/concurrent test fixtures

### Other Synthetic Markers

- Phone numbers: `090` / `091` prefix + 8 timestamp digits
- Full name: "Test" (English) or "والد آزمایشی" (Persian "Test Parent")
- Password: `TestPass999!`
- `full_name` metadata containing Persian test markers

### Auth User Metadata

- Role `authenticated` (all users, including real admins)
- Public roles: `parent` (70), `admin` (22), `super_admin` (7)

## Classification Methodology

1. **Proven synthetic** — email domain matches known test domain (`test.com`,
   `dev.cartoona.example`, `t.co`, `test.co`, `test.cartoona.local`, `cartoona.dev`)
   or email is NULL (the seed user's public.users record).
2. **Proven real** — email domain is `gmail.com` and user was created on
   July 17 before any seed/test activity. Neither has a parent profile, wallet,
   or any customer-related data.
3. **Intersection verified** — every synthetic user's creation timestamp falls
   within documented test or seed windows (July 22–28). Every real user was
   created on July 17. No overlap.

## Cleanup Migration

**File:** `supabase/migrations/20260727123000_remove_all_synthetic_test_data.sql`

**Deterministic predicate (identifies exactly 97 synthetic auth users):**

```sql
WHERE email IS NULL
   OR email ILIKE '%@test.com'
   OR email ILIKE '%@dev.cartoona.example'
   OR email ILIKE '%@t.co'
   OR email ILIKE '%@test.co'
   OR email ILIKE '%@test.cartoona.local'
   OR email ILIKE '%@cartoona.dev'
```

**Safeguards:**

- Pre-cleanup assertions verify expected counts (97 synthetic, 99 total,
  75 profiles, 75 wallets, 102 relationships, 0 balance, 0 orders).
- Any unexpected count raises an exception and rolls back the entire migration.
- Clean environments (0 synthetic users) safely no-op.
- Referral settings and creation pricing are asserted after cleanup.
- Two-path design: same migration handles both dirty and clean states.

**Deletion order:**

1. `auth.identities` (synthetic user IDs)
2. `auth.sessions` (synthetic user IDs)
3. `auth.users` (cascades to `public.users` → `parent_profiles` → `candy_wallets`)
4. `referral_relationships` (orphaned after SET NULL cascade)

## Aggregate After State

All synthetic artifacts removed. Configuration preserved.
24 migrations in sync (local = remote).

## Accounts Preserved

- 2 administrative accounts (1 admin, 1 super_admin), both created July 17.
- Created via unknown method (before any Cartoona signup flow was built).
- Neither has a parent profile, wallet, referral data, orders, or media.
- Neither was touched by the cleanup migration.

## Configuration Preserved

- Referral program: enabled, 1500 basis points (id=1).
- Creation pricing: 9 active rows, unchanged.
- All database functions, triggers, RLS policies, storage buckets, and
  migration history are intact.

## Test-Data Incident Cause

Before the destructive-test guard was implemented, stateful Playwright tests ran
against the main project. The tests created synthetic auth users, parent profiles,
candy wallets, and referral relationships. Some test `afterAll` cleanup routines
failed to execute, leaving orphaned data.

## Destructive-Test Guard Remediation

After the incident, a multi-phase guard was implemented at
`tests/helpers/assert-safe-database-target.ts`:

- **Phase 1 (July 28):** Basic guard identifying main/local/unknown targets.
- **Phase 2 (July 28):** Requires explicit `CARTOONA_TEST_SUPABASE_PROJECT_REF`
  for remote projects. Migration Test project is always forbidden.
- **Phase 3 (July 29):** All supplied identifiers must agree. No environment
  variable receives priority. URLs are strictly validated (no path, query,
  credentials). Local loopback equivalents require matching ports.
  33 unit tests. Guard invoked at module scope in all 6 stateful test suites.

## Stateful Tests Still Pending

Repeated flake validation and full stateful regression testing remain PENDING
until a safe disposable or local Supabase target is configured. Docker is
unavailable locally. No disposable remote project is set up.

## Files Modified During Cleanup

- `supabase/migrations/20260727123000_remove_all_synthetic_test_data.sql` (new)
- `docs/FORENSIC_AUDIT.md` (this file)
- `.claude/summary.md` (updated)
