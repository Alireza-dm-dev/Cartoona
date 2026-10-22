# Data migration: Supabase → plain PostgreSQL (V0.1.44)

This document covers the tool that copies Cartoona's domain data from the
current Supabase database shape into the plain PostgreSQL schema
(`database/migrations` 0001–0013), and backfills `user_identities`.

> **Status: local and testing tooling only.** No production data has been
> copied. The tool refuses every non-local host and every known Supabase
> project. Its future production mode is designed below but **disabled in
> code**. No application route reads the copied data yet.
>
> **AMR blocker (from V0.1.43, still open).** Data-copy tooling is safe to
> build and test without real AMR verification: it reads and writes no session
> data, and copied users get `sessions_not_before = NULL`. **Production cutover
> is NOT allowed** until either the real disposable-project token `amr` shape
> has been verified ([AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md#where-authenticatedat-comes-from)),
> or the session-start design has been replaced. The branch is **not
> production-deployable**.

## Quick start (local)

```bash
docker compose --env-file .env.docker up -d postgres

# A target: a freshly migrated, never-used plain database.
docker compose exec postgres psql -U cartoona -d postgres -c "create database cartoona_copy"
PSQL=scripts/db/psql-docker.sh DATABASE_URL=postgresql://cartoona@postgres:5432/cartoona_copy scripts/db/migrate-local.sh

# A source: any LOCAL database with the Supabase public schema shape
# (see "Source extraction" below). Then:
CARTOONA_COPY_SOURCE_URL=postgresql://cartoona:<pw>@localhost:5433/supabase_staging \
CARTOONA_COPY_TARGET_URL=postgresql://cartoona:<pw>@localhost:5433/cartoona_copy \
npm run db:copy -- --manifest copy-manifest.json
```

Options: `--check` validates both URLs without connecting.
`--stop-after-phase <name>` commits up to and including that phase, then
stops; a rerun resumes. `--batch-size N` sets rows per read (default 2000).
`--manifest <file>` also writes the manifest as JSON (mode 0600).

| Exit | Meaning |
|---|---|
| 0 | completed; verified no-op on a completed target; or stopped as requested |
| 2 | refused before connecting or before writing: unsafe URL, same database, schema incompatible, wrong role |
| 3 | unsupported target state: not empty, a different completed copy, a failed copy, or the source changed during a resume. Nothing written |
| 4 | integrity, reconciliation, identity or validation failure. Nothing written if the source failed; the current phase rolled back if a phase failed |
| 1 | unexpected error (message redacted) |

## Source → target mapping

The plain schema is column-for-column identical to the migrated Supabase
`public` schema. The parity suite in `plain-postgres-db.test.ts` proves this,
with three exceptions: `users.sessions_not_before` and `user_identities` exist
only in the target, and the `users.id → auth.users` FK exists only in the
source. Most tables are therefore direct copies. The canonical list lives in
`scripts/db/data-copy/mapping.ts`, and the static suite fails when a plain
table is left unclassified.

| Phase | Table | Strategy | Notes |
|---|---|---|---|
| 1 users | `users` | **transformed** | `id` = Supabase auth UUID, unchanged. The `auth.users` FK is not carried over. `sessions_not_before` is target-only and stays NULL. `deleted_at` is copied exactly |
| | `user_identities` | **derived** | backfilled in the target, see [Identity backfill](#identity-backfill) |
| 2 reference | `creation_pricing`, `candy_packages`, `characters` | **reference-data replace** | see [Reference data](#reference-data) |
| | `referral_program_settings`, `homepage_content`, `homepage_hero_layout` | **reference-data replace** | singletons; admin edits and `revision` carry forward |
| | `homepage_media_assets` | direct | CMS media metadata (`storage_path`) only |
| 3 parents | `parent_profiles` | direct, **3 triggers bypassed** | referral codes, consent and timestamps preserved |
| | `candy_wallets` | direct | wallet ids and balances preserved, then reconciled |
| | `parent_welcome_credits` | direct | `granted_count`/`used_count` preserved, then reconciled |
| | `child_profiles`, `referral_relationships`, `referral_binding_rate_limits` | direct | |
| 4 commerce | `coupons`, `coupon_package_rules`, `coupon_redemptions`, `payment_attempts`, `payment_webhook_events` | direct | provider references unchanged |
| | `candy_purchases` | direct, **two-pass** | FK cycle with `payment_attempts`: inserted with `active_payment_attempt_id` NULL, then set once the attempts exist (`candy_purchases_set_updated_at` bypassed for that UPDATE) |
| 5 orders | `orders` | direct | `child_name`, `submission_key`, `payment_source`, `created_at`/`updated_at` preserved |
| | `video_requests`, `drawing_animation_requests` | direct | fulfilment extension rows |
| | `order_status_history` | direct | append-only. Its guard blocks UPDATE/DELETE/TRUNCATE, not INSERT, so no bypass. `delivered_at` is derived from it and therefore preserved |
| | `media_assets` | direct | metadata only: ids, `file_url` (object **key**), MIME, size, role, delivery/visibility flags |
| | `parent_welcome_credit_usages` | direct | append-only; INSERT is not guarded |
| 6 ledger | `candy_transactions` | direct | append-only ledger; `idempotency_key` preserved |
| 7 content and logs | `examples` | direct | `media_url`/`thumbnail_url` are object keys |
| | `referral_program_settings_history`, `audit_logs`, `moderation_logs` | direct | immutable history; INSERT is not guarded |

**Excluded:**

- The `auth` schema: users, identities, sessions, refresh tokens and MFA. Credentials stay with the provider.
- The `storage` schema: buckets and objects.
- The Supabase internals: `supabase_migrations`, `realtime`, `vault`, `graphql` and `extensions`.
- The target's own `schema_migrations`, which is verified but never written.
- RLS policies, grants and Supabase roles.

**Deferred:**

- Storage object bytes, moved by key in the storage migration.
- `sessions_not_before` values, which are never derived from `auth.sessions`.

There are no other "fulfilment/request" tables: fulfilment state lives in
`orders`, `order_status_history`, `media_assets` and the two extension tables.

### Copy order and dependencies

Each phase depends only on earlier phases. Within a phase, tables are loaded
in FK order. The static suite checks every FK in `0002_tables.sql` against
this order:

```
users ─┬─> user_identities
       ├─> (reference) referral_program_settings, homepage_*  (updated_by → users)
       └─> parent_profiles ─> candy_wallets ─────────────────────────> candy_transactions
             ├─> parent_welcome_credits ─> parent_welcome_credit_usages <─ orders
             ├─> child_profiles, referral_relationships, referral_binding_rate_limits
             ├─> candy_purchases <─> payment_attempts  (cycle: two-pass)
             │      ├─> payment_webhook_events, coupon_redemptions <─ coupons <─ coupon_package_rules
             └─> orders ─> video_requests, drawing_animation_requests,
                           order_status_history, media_assets
characters ─> orders, examples          candy_packages ─> candy_purchases, coupon_package_rules
```

## ID preservation

Every primary key is copied unchanged. **Existing users keep id = their
Supabase auth user UUID.** Foreign keys reference these ids, storage keys embed
them (`<user id>/<order id>/…`, `orders/<order id>/final/…`), payment providers
and URLs reference them, and the identity backfill depends on them. The tool
contains no id generator (`gen_random_uuid` is statically forbidden in it).
Inserts list the source columns, ids included, and a per-table checksum
compares every copied column with the source.

## Identity backfill

For every copied user, the target gets one row:

```
provider = 'supabase', provider_subject = users.id::text, user_id = users.id
id = md5('cartoona-identity:supabase:' || users.id)::uuid, created_at = users.created_at
```

The row id and timestamp are derived, so the backfill is **deterministic**:
two copies of the same source produce identical rows. It runs inside the
`users` phase, under `LOCK TABLE users, user_identities IN SHARE ROW EXCLUSIVE MODE`:

| Existing state | Result |
|---|---|
| no row for the subject | inserted |
| `(supabase, subject)` → the same user | no-op |
| `(supabase, subject)` → a **different** user | **refused**: nothing written, both ids reported |
| the user already has a supabase identity with **another** subject | **refused**. The schema does not forbid several identities per provider, but nothing in Cartoona creates one, so for a migrated user it can only be an error |

There is no `ON CONFLICT` and no UPDATE/DELETE path, so a conflicting identity
is never overwritten. Soft-deleted users get their identity row too, which
keeps the historical link. The backend still denies them through
`users.deleted_at` (403 `forbidden`), as proven after the copy.

## Trigger handling

Three `parent_profiles` INSERT triggers would corrupt a historical copy, and
one UPDATE trigger would rewrite a timestamp:

| Trigger | Why it is bypassed |
|---|---|
| `assign_parent_referral_code` (BEFORE INSERT) | **replaces** the referral code with a new random one, which breaks shared links and `referral_relationships.referral_code_snapshot` |
| `ensure_parent_candy_wallet` (AFTER INSERT) | creates a second, zero-balance wallet with a new id; the historical wallet and its ledger are copied instead |
| `grant_parent_welcome_image_credits` (AFTER INSERT) | creates a fresh 3/0 grant; the historical grant, with its `used_count`, is copied instead |
| `candy_purchases_set_updated_at` (BEFORE UPDATE) | would set `updated_at = now()` during the FK-cycle second pass |

Mechanism: `ALTER TABLE public.<t> DISABLE TRIGGER <name>` by name,
**inside the phase transaction**, then `ENABLE` again. Before COMMIT, the phase
verifies that every trigger on its tables is enabled. Because the ALTER is
transactional, a failed phase, or a crashed process (whose transaction the
server rolls back), leaves the trigger enabled. The tool never uses
`session_replication_role = replica` or `DISABLE TRIGGER ALL`: those also turn
off foreign-key enforcement. It needs table ownership, so it must run as the
schema owner / migration role. The preflight refuses `cartoona_app` and any
member of it.

The append-only guards (`audit_logs`, `moderation_logs`,
`parent_welcome_credit_usages`, `order_status_history`, `candy_transactions`,
referral settings history) block UPDATE, DELETE and TRUNCATE only. Inserts
pass, so the guards **stay active for the entire import**, and the suite
proves they refuse mutation afterwards. Foreign keys, CHECKs and unique
indexes also stay active throughout.

## Reference data

A fresh target holds the 0008 seed rows: 9 prices, 3 packages, 10 characters
and the 3 singletons.

| Table | Decision | Why |
|---|---|---|
| `creation_pricing`, `candy_packages`, `characters` | **replace from source** | They are business data that admins edit. Copied orders, purchases, coupon rules and examples reference the **source** ids. Regenerating from migrations would orphan those FKs and silently reset prices |
| `referral_program_settings`, `homepage_content`, `homepage_hero_layout` | **replace from source** | Admin edits, `updated_by` and `revision` carry forward. A stale `revision` would break the CMS optimistic concurrency |

Replace means: in the phase transaction, `DELETE` the seed rows (which the
preflight proved are exactly the seed counts), then insert the source rows.
Nothing is merged, so no seed row can be duplicated, and `pricing_key` is
unique as a second guard. A source missing a singleton is refused.

## Reconciliation rules

The same checks run on the **source before anything is written**, and on the
**target after the copy**. Source and target share the table shape, so it is
the same SQL. Violations are reported with up to 10 references (ids and
amounts only). **Nothing is auto-repaired.**

| Check | Rule (from the schema's real business logic) | Severity |
|---|---|---|
| `fk_orphan:<table.col->ref>` | every FK of the plain schema (39), checked as a query, so a constraint-less dump restore is caught | error |
| `wallet_balance_mismatch` | `balance = SUM(amount)` per wallet. Correct here because every balance change writes a **signed** ledger row in the same transaction (`complete_candy_purchase_trusted` `+candy_amount`, `create_parent_request_trusted` `-candy_cost`) | error |
| `wallet_negative_balance`, `ledger_sign_invalid` | balance ≥ 0. `purchase`/`refund`/`grant` > 0; `order_debit`/`spend` < 0 | error |
| `ledger_order_debit_unmatched`, `candy_order_debit_count` | every debit references an order of the same parent with `payment_source = 'candy'` and `amount = -candy_cost`, and each candy order with a cost has exactly one debit | error |
| `ledger_purchase_unmatched`, `paid_purchase_credit_count` | every purchase credit references a **paid** purchase of the same parent with `amount = candy_amount`, and each paid purchase has exactly one credit | error |
| `welcome_used_exceeds_granted` | `granted_count ≥ used_count`, `used_count ≥ 0` | error |
| `welcome_used_count_mismatch` | `used_count = COUNT(usages)` per parent (incremented together in the request function) | error |
| `welcome_usage_order_invalid`, `welcome_order_usage_count` | a usage's order belongs to the same parent and is an `image` with `payment_source = 'welcome_image_credit'` and `candy_cost = 0`, and every such order has exactly one usage | error |
| `order_payment_source_invalid` | `payment_source ∈ {candy, welcome_image_credit}`, welcome credits for images only | error |
| `duplicate_*` | one profile per user, one wallet per parent, unique `(parent_id, submission_key)`, unique ledger idempotency key, unique referral code | error |
| `required_singleton_missing` | the three singletons exist | error |
| `identity_missing`, `identity_conflict` (target) | every user has `('supabase', id)`, and no supabase subject differs from its user id | error |
| `sessions_not_before_set` (target) | NULL for every copied user | error |
| `trigger_not_enabled` (target) | every public trigger is enabled | error |
| preservation (target) | per copied table, the row count and md5 content checksum (all source columns, in PK order) equal the source's | error |
| `media_upload_key_prefix`, `media_final_key_prefix` | upload keys start `<user id>/<order id>/`, final keys `orders/<order id>/final/`. Keys are copied verbatim either way | warning |
| `parent_without_wallet`, `active_parent_without_welcome_grant` | account defaults | warning |

Timestamps are never rewritten. Comparisons run with `TimeZone = UTC`, and
values pass through `json_populate_recordset` at full microsecond precision.

## Transactions, rerun and resumability

- **Source:** one `REPEATABLE READ READ ONLY` transaction for the whole run,
  so every table, checksum and check sees one snapshot.
- **Target:** one transaction **per phase**, not one giant one. A failure
  rolls back only the current phase and names the phase and table. Committed
  phases stay committed, so the failure can be inspected. Each phase commits
  together with its row in `cartoona_data_copy.phases`, so progress and data
  can never disagree.

Target states (`classifyTarget`):

| Target | Behaviour |
|---|---|
| **A. fresh**: migrated 0001–0013, every domain table empty, reference tables at exactly their seed counts, no bookkeeping | full copy |
| **B. completed** copy of the **same** source state (same data and schema fingerprint) | **verify-only no-op**: re-runs every check and the per-table preservation comparison, writes nothing, exits 0 (`verified_noop`) |
| completed copy of a **different** source state | refused (exit 3). Recreate the target |
| interrupted (`in_progress`), same source state, unfinished phases' tables still initial | **resume** at the first uncommitted phase (`resumed_completed`) |
| interrupted, but the source changed | refused (`source_changed`). Start again from a fresh target |
| `failed_validation` | refused. Discard the target; it is never repaired in place |
| anything else (rows the tool did not write) | refused (`target_not_empty`, with per-table counts) |

The bookkeeping lives in a dedicated schema, `cartoona_data_copy` (`runs`,
`phases`). PUBLIC has no access to it and neither does `cartoona_app`, and the
application never reads it. It also holds the manifest.

## Manifest

Stored in `cartoona_data_copy.runs.manifest`, and optionally written to a file.
It contains safe metadata only:

- the tool version and outcome;
- start and finish times;
- the source schema fingerprint (sha256 of the column/type list), the source
  data fingerprint (sha256 of per-table count + checksum), and the Supabase
  migration head when the source still has `supabase_migrations`;
- the target migrations, their fingerprint and the server version;
- per-phase and per-table row counts, checksums and durations;
- the bypassed triggers;
- the identity backfill counts;
- the validation summary (check names and counts) and timings.

It holds **no credentials, no emails, names or other PII samples, and no
tokens**. The suite asserts this, and the reference samples printed on failure
are never stored.

## Safety checks

- Both URLs are named explicitly by `CARTOONA_COPY_SOURCE_URL` and
  `CARTOONA_COPY_TARGET_URL`, from the environment only (argv is visible in
  `ps`). `DATABASE_URL` and `.env` files are never read, and nothing is defaulted.
- Each URL must be `postgresql://user[:pw]@host[:port]/db` with no query
  string and one host. Both must be local (`localhost`, `127.0.0.1`, `[::1]`
  or the compose `postgres`) and not a maintenance database. Supabase hosts,
  the three known Cartoona project refs and the CLI-linked ref are refused
  anywhere in either URL. Ambient `PGHOST`/`PGPORT`/`PGDATABASE`/`PGSERVICE`/`PGHOSTADDR` are refused.
- Source ≠ target is checked by URL and again by the server and database
  actually reached (system identifier, start time and database oid).
- The target schema must be **exactly** the audited 0001–0013, in order, each
  with the sha256 of this checkout's file. If the checkout itself holds an
  unaudited migration (0012+), the tool refuses until the mapping is re-audited.
- The source schema must have every target column with the same type, and no
  extra column (that data would be lost). A source that looks plain-shaped
  (`user_identities`/`schema_migrations`) is refused.
- The target role must own the tables and must not be, or be a member of, `cartoona_app`.
- Every message passes through `redact()`: passwords and connection URLs never
  reach the logs, errors or manifest.
- No application code imports the tool, it is not in the backend bundle, and it
  imports nothing from `lib/` (all enforced statically).

## Source extraction (provider-neutral)

The tool reads **one thing**: a PostgreSQL database whose `public` schema has
the current Supabase shape. Every input format reduces to that:

| Input | How it becomes a source |
|---|---|
| SQL / custom-format dump | restore it into a local **staging** database, built as below |
| CSV / JSON exports | `\copy` each table into the same staging schema |
| direct connection (future, controlled environment) | only via the designed, currently disabled production mode below |

Staging schema = `tests/helpers/supabase-stub.sql` + the repo's
`supabase/migrations` chain. This is exactly the build the tests use. After
building it, drop `public.users_id_fkey` (the stub's `auth.users` is empty),
then `pg_restore --data-only --disable-triggers --schema=public` into it.
Disabling triggers is appropriate **in staging only**: it replays a snapshot
that is already consistent, so it must not regenerate wallets or codes. The
copy tool's source preflight then re-proves every FK, uniqueness and ledger
rule before anything is written to the target. Staging is a throwaway database
on the operator's machine.

## Local testing

```bash
npm test                                                  # static guards (tests/unit/data-copy-static.test.ts)
CARTOONA_PLAIN_PG=docker npx vitest run tests/unit/data-copy-db.test.ts
CARTOONA_PLAIN_PG=docker CARTOONA_DATA_COPY_PERF=1 npx vitest run tests/unit/data-copy-perf-db.test.ts --reporter=verbose --silent=false
```

- **Source fixture** (`tests/fixtures/data-copy/supabase-source-fixture.sql`),
  applied to the real Supabase chain over the stub, with deterministic ids:
  - 2 parents, 1 admin, 1 super admin, and 1 soft-deleted parent with history;
  - profiles, wallets and grants created by the real triggers;
  - 2 purchases completed by the real `complete_candy_purchase_trusted`, with
    payment attempts in the FK cycle, a webhook event, and a coupon with a
    package rule and a reserved redemption;
  - 8 orders created by the real `create_parent_request_trusted`: 5 paid by
    welcome credits, then the candy fallback for a 4th image, a video and a
    drawing whose upload is verified against `storage.objects`;
  - status history including `delivered`, superseded and approved final media,
    a referral relationship and a rate-limit row, settings history, CMS edits,
    an example, audit and moderation logs, and admin-edited pricing.
- **Scale fixture** (`synthetic-scale.sql`): 1,000 users, 10,000 orders,
  9,010 ledger rows, 17,920 history rows, 6,040 media rows and 3,000 audit
  rows, all satisfying every reconciliation rule.

Measured locally (Docker PostgreSQL 17 on this Mac, 2026-10-18), 62,945 rows:

| | Time |
|---|---|
| preflight (schema, fingerprints, target state) | 0.3 s |
| copy, 7 phases | 2.4 s (slowest phase `orders`, 1.5 s; slowest table `order_status_history`, 17,920 rows, 0.5 s) |
| validation (source + target + preservation) | 0.4 s |
| **total** | **3.4 s** |
| verify-only rerun (Mode B) | 0.7 s |
| peak RSS of the process running the tool | 74 MB (baseline 31 MB) |

The first measurement found validation at 19 s: three correlated
`count(*)`-per-row checks were O(orders × ledger). They were rewritten as
grouped joins. No other optimisation was needed.

## Production copy plan (future, NOT executed)

Not runnable in V0.1.44: the production mode is disabled in code, and the
cutover is blocked by the AMR check. Prerequisites:

- the AMR blocker is closed;
- the plan has been rehearsed end to end on a disposable or staging Supabase
  export;
- the target environment's host allowance has been reviewed and enabled in a
  dedicated change;
- storage object migration is ready (same keys).

1. **Write freeze (maintenance window).** Put the app in maintenance mode
   (every mutating route returns 503; reads may stay up). Disable Supabase Auth
   sign-ups, because a signup writes `auth.users` → `public.users` through the
   trigger. Pause the payment provider's webhooks, or let them queue: providers
   retry. Admin tools are part of the app, so they are frozen with it. Record
   the time.
2. **Final export.** Take a read-only `pg_dump --data-only --schema=public`
   (plus `supabase_migrations.schema_migrations`) from Supabase, made by the
   operator with the provider's own tooling. The copy tool never connects to
   Supabase. Confirm that Supabase's applied migration head equals this
   checkout's `supabase/migrations` head.
3. **Staging restore**, as in [Source extraction](#source-extraction-provider-neutral).
4. **Target check.** Create a fresh target and migrate it 0001–0013 with the
   runner as the owner role. `npm run db:copy -- --check`.
5. **Data copy:** `npm run db:copy -- --manifest <file>`. The source
   preflight refuses a broken export before writing.
6. **Reconciliation:** must be clean. Archive the manifest. Any failure stops
   the cutover; nothing is hand-patched in the target.
7. **Identity backfill verification:** `identity_missing = 0`,
   `identity_conflict = 0`, and the `user_identities` count equals `users`. Run
   the auth proof (a signed assertion for a known staff test account →
   `/v1/auth/me`).
8. **Application deploy:** the release that reads the cut-over domain from
   PostgreSQL (V0.1.45 read-only parent orders; V0.1.46 read-only profile
   name, candy balance and welcome credits), with the backend's
   `cartoona_app` login provisioned on the target.
9. **Smoke tests:** `/ready` (role check), parent orders list and pagination
   for a staff test parent, its balance, welcome credits and header name, a
   soft-deleted account → 403, pricing.
10. **Rollback point:** the point of no return is the **first write that lands
   only in plain PostgreSQL**. V0.1.45 and V0.1.46 are read-only, so until a write route
   moves, rollback is redeploying the previous release: Supabase stayed the
   source of truth and was never written by the new path.

**Writes during the copy** are prevented by the freeze, not reconciled.
There is no CDC and no dual-write, because the evidence does not call for it:
the July cleanup migration found 99 auth users in production, 97 of them synthetic, and 1,000 users / 10,000
orders copy and validate in 3.4 s locally, so the window is measured in
minutes. A guard catches a freeze leak: the source data fingerprint in the
manifest must equal a fingerprint recomputed from Supabase right before
unfreezing. A mismatch means a write slipped in, so discard the target and
redo steps 2–6.

**Designed, disabled production mode:** `--source-mode=production-export`
would allow one named, non-local **staging** host for the source (never a
Supabase host, which stays refused). It would require an explicit
operator-supplied confirmation of the target database name, and it would stay
read-only on the source. Today any mode other than `local` throws
`production_mode_disabled`, and the static suite asserts that.

## Rollback plan

- **Before deploy:** drop the target. Supabase is untouched and is still the
  source of truth.
- **Copy failed mid-way:** a resumable run continues from the first
  uncommitted phase. A `failed_validation` or changed-source target is dropped
  and re-created; it is never patched in place.
- **After a read-only cutover (V0.1.45, V0.1.46):** redeploy the previous release.
  There is nothing to reconcile.
- **After the first write route moves (consent, V0.1.48):** consent changes
  made after the cutover exist only in PostgreSQL. The rollback boundary and
  the reverse-sync step are defined in
  [ROUTE_CUTOVER.md](ROUTE_CUTOVER.md#rollback-boundary-the-first-postgresql-only-write).

## Remaining blockers

V0.1.45 cut the parent orders LIST over locally, and V0.1.46 the parent account
reads (profile name, candy balance, welcome credits), both on data copied by
this tool ([ROUTE_CUTOVER.md](ROUTE_CUTOVER.md#v0146-parent-account-reads)).
The V0.1.46 proof adds `tests/fixtures/data-copy/parent-account-extra.sql`
(a third parent signed up through the real triggers, so names, balances and
credits all differ between parents). Production remains blocked by:

1. **AMR verification** against real Supabase tokens (V0.1.43). This is still
   the hard production blocker.
2. **A rehearsal** of the export → staging → copy path on a real
   (disposable/staging) Supabase export. It has only been done with the local
   Supabase-shaped build, not with a `pg_dump` from a hosted project.
3. **Storage:** the orders list returns no media, but order detail and the
   gallery do. Signed URLs need the object-storage migration.
4. **Deployment of the backend** outside local compose (BACKEND.md).
5. **The read/write split.** The cut-over reads (orders list, balance, welcome
   credits, profile name) come from PostgreSQL. The writes that change them
   (request submission, purchase completion, profile creation) still go to
   Supabase. On one running system the two diverge, so production needs those
   writes moved or a final copy at the cutover freeze before switching any of
   these reads.

### V0.1.47: write foundation, re-audit of 0012/0013

The tool's pinned migration set is now 0001–0013. Both new migrations were
re-audited against the mapping:

- **0012** adds `internal_write_nonces`, a target-only table with no Supabase
  counterpart. It is never copied (listed in `EXCLUDED`), starts empty, holds
  only opaque nonces, and is not part of reconciliation. Nonces never need to
  survive a cutover: every one expires within a minute of use.
- **0013** is a column-level grant; it changes no data or column.

Drift after V0.1.47, per domain (nothing below is deployed):

| Domain | Reads | Writes | State |
|---|---|---|---|
| parent display name | PostgreSQL (V0.1.46) | PostgreSQL: `PATCH /v1/parent/profile`, **backend only**, no product path calls it | internally consistent in PostgreSQL; no live Supabase write exists for it either (no profile-edit UI). Profile *creation* (signup, consent) still writes Supabase |
| candy balance | PostgreSQL | Supabase (purchase completion, request submission) | **drifts** |
| welcome credits | PostgreSQL | Supabase (request submission) | **drifts** |
| orders list | PostgreSQL | Supabase (request submission, admin status) | **drifts** |
| consent | Supabase | Supabase | consistent (old path) |
| everything else | Supabase | Supabase | consistent (old path) |

The read/write split (blocker 5) is therefore **not** solved by V0.1.47. The
final copy at the write freeze, or moving those writes, is still required.

### V0.1.48: consent cutover, re-audit of 0014

The pinned set is now 0001–0014 (`EXPECTED_TARGET_MIGRATIONS`). **0014** adds
one function (`record_parent_consent_trusted`) and its EXECUTE grant: no table
and no column, so the mapping is unchanged. `parent_profiles.consent_granted`
and `consent_granted_at` were already copied verbatim and still are; copied
values are never regenerated or defaulted.

Proven (`consent-cutover-db.test.ts`, new fixture
`tests/fixtures/data-copy/parent-consent-extra.sql` with two un-consented
parents and one grant time with microseconds): source `false`/NULL → target
`false`/NULL; source `true` → target `true` with the identical timestamp
(`2026-08-05 09:05:00.123456+00`); every copied row's pair equals the source.
The CLI (`npm run db:copy`) also completed against a 0001–0014 target in the
Docker proof.

One more Supabase migration exists since V0.1.48,
`20261022100000_request_rpc_consent_gate_moved.sql`. It changes only a
function body (not copied: functions come from the target's own migrations),
so the source schema shape the tool reads is unchanged.

Drift after V0.1.48 (nothing below is deployed):

| Domain | Reads | Writes | State |
|---|---|---|---|
| **consent** | **PostgreSQL** (every gate) | **PostgreSQL** (`POST /api/parent-consent`) | **consistent in PostgreSQL**. Supabase's column is no longer read or written by the app (its value freezes at the cutover) |
| profile creation | — | Supabase (signup completion, dev signup) | a parent who signs up after the copy has no PostgreSQL identity/profile: every PostgreSQL-backed route answers 403 `identity_not_linked` for them, consent included (blocker 6) |
| request submission | consent gate PostgreSQL; the rest Supabase | Supabase | mixed by design (temporary) |
| candy balance, welcome credits, orders list | PostgreSQL | Supabase | **drifts** (blocker 5) |
| everything else | Supabase | Supabase | consistent (old path) |

Blocker 6 (new wording of an existing gap): identity and profile provisioning
for NEW accounts. The copy links every account that exists at copy time; an
account created afterwards exists only in Supabase until signup itself moves
(or a provisioning step links it). Consent cannot be granted for such an
account in V0.1.48 (403), whereas the old route created the profile on the
spot.
