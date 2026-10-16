# Plain PostgreSQL baseline (V0.1.38)

`database/migrations/` is a clean baseline of Cartoona's database for **plain
PostgreSQL 17**. It contains the domain schema and the transaction-critical
business logic, with **no dependency on Supabase Auth, Supabase Storage, RLS
helpers or Supabase database roles**.

> **Status: used by one route.** The app still uses Supabase for its database,
> Auth and Storage, except `/api/creation-pricing` (below). V0.1.39 added a data-access layer (`lib/db`, `lib/repositories`;
> see [POSTGRES_DATA_ACCESS.md](POSTGRES_DATA_ACCESS.md)), and since V0.1.41
> the Fastify backend serves one route (`/api/creation-pricing`) from it
> ([ROUTE_CUTOVER.md](ROUTE_CUTOVER.md)). No production data has been copied.

## Why a new baseline

The 45 files in `supabase/migrations/` record how the Supabase database was
built. They assume Supabase-managed pieces: `auth.users`, `auth.uid()`,
`auth.jwt()`, `auth.sessions`, `storage.objects`, the
`anon`/`authenticated`/`service_role` roles and the `extensions` schema. None of
those exist on plain PostgreSQL, and recreating fake versions would carry the
coupling forward instead of removing it.

The baseline is the **final state** of that chain, not a concatenation:

1. The real Supabase chain was applied in order to a throwaway local
   PostgreSQL 17, over the minimal stub in `tests/helpers/supabase-stub.sql`.
2. The resulting `public` schema was dumped, and every object was routed into
   the files below.
3. Each Supabase-specific piece was removed or replaced by an exact, asserted
   edit. These are listed in [Schema parity](#schema-parity).

**The historical Supabase migrations are untouched** and still describe
production. Until cutover, any new Supabase migration that changes the domain
schema must be mirrored as a new `database/migrations/NNNN_*.sql` file. The
parity test (below) rebuilds the Supabase schema from `supabase/migrations` on
every run and fails until the two agree again.

## Layout

| File | Contents |
|---|---|
| `0001_extensions.sql` | `pgcrypto` in `public`, used for `gen_random_bytes()`. `gen_random_uuid()` is core PostgreSQL. |
| `0002_tables.sql` | 31 tables, primary/unique/check constraints, 32 indexes, foreign keys, comments |
| `0003_identity.sql` | `users.id` default, and the new `user_identities` table |
| `0004_helpers_and_triggers.sql` | 5 helper functions, 8 trigger functions, 22 triggers |
| `0005_business_functions.sql` | 24 transaction-critical `*_trusted` functions |
| `0006_append_only_guards.sql` | Append-only triggers that replace RLS-only immutability |
| `0007_privileges.sql` | `REVOKE EXECUTE … FROM PUBLIC` on all functions, now and by default |
| `0008_reference_data.sql` | Pricing catalog, candy packages, characters and the three singletons (25 rows) |
| `0009_application_role.sql` | V0.1.39: the `cartoona_app` NOLOGIN group role and its least-privilege grants (no password) |

Applied migrations are recorded in `public.schema_migrations` (version and
sha256). Never edit an applied file; add a new one.

## Create, migrate and reset a local database

The `postgres` compose service from V0.1.37 is the target. With a host `psql`:

```bash
docker compose up -d postgres
DATABASE_URL="postgresql://cartoona:<password>@localhost:5433/cartoona" scripts/db/migrate-local.sh
```

Without a host `psql`, run psql inside the container. Address the database by
its compose name; the container's own password is used:

```bash
PSQL=scripts/db/psql-docker.sh \
DATABASE_URL=postgresql://cartoona@postgres:5432/cartoona scripts/db/migrate-local.sh
```

Throwaway database (create, migrate, drop). This never touches `cartoona`:

```bash
docker compose exec postgres psql -U cartoona -d postgres -c "create database cartoona_schema_test"
PSQL=scripts/db/psql-docker.sh \
DATABASE_URL=postgresql://cartoona@postgres:5432/cartoona_schema_test scripts/db/migrate-local.sh
docker compose exec postgres psql -U cartoona -d postgres -c "drop database cartoona_schema_test with (force)"
```

To reset the local `cartoona` database, drop and recreate it the same way, then
migrate again. `docker compose down -v` also works, but it deletes the whole
volume.

### Runner safety

`scripts/db/migrate-local.sh` fails closed (exit 2, nothing applied) when:

- `DATABASE_URL` is missing, or not exactly `postgres[ql]://user[:pw]@host[:port]/db`;
- the host is anything other than `localhost`, `127.0.0.1`, `[::1]` or the compose service `postgres`;
- the URL contains a Supabase host (`supabase.co`, `supabase.com`, `pooler.`) or a known Cartoona project ref (production, migration-test, disposable, and whatever `supabase/.temp/project-ref` holds);
- the URL has query parameters, which can override the host, or lists several hosts;
- `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE` or `PGSERVICE` is set, so the target would be ambiguous;
- the database is `postgres`, `template0` or `template1`.

It prints `user@host:port/db` before acting and never prints the password. The
password reaches psql through `PGPASSWORD`, never on a command line. `--check`
validates and prints the target without connecting. The script reads no
`.env` file and contains no credentials.

## Running the tests

```bash
npm test                                         # static guards, no database
docker compose up -d postgres
CARTOONA_PLAIN_PG=docker npx vitest run tests/unit/plain-postgres-db.test.ts
```

- `tests/unit/plain-postgres-static.test.ts` always runs. It checks that the
  migrations contain no `auth.*`, `storage.*`, Supabase role, policy or
  `extensions.` reference, that the essential tables, constraints and functions
  are present, and that the runner refuses every unsafe target listed above.
- `tests/unit/plain-postgres-db.test.ts` is opt-in. It creates `plain_<id>` and
  `ref_<id>` in the local container, applies the baseline through the real
  runner, and rebuilds the Supabase reference from `supabase/migrations`. It
  then runs real SQL, with genuinely concurrent sessions held at an
  advisory-lock barrier, and drops both databases afterwards.

---

## Canonical domain-table inventory

Derived from the migrated catalog. The columns are: number of columns, primary
key, FK targets, unique constraints or unique indexes, CHECK constraints,
non-PK indexes, triggers, and functions that read or write the table.

| Table | Cols | PK | FK → | Uniq | Checks | Idx | Triggers | Functions |
|---|---|---|---|---|---|---|---|---|
| `audit_logs` | 7 | id | — | 0 | 0 | 0 | audit_logs_append_only, audit_logs_truncate_block | — |
| `candy_packages` | 10 | id | — | 0 | 3 | 0 | candy_packages_set_updated_at | create_coupon_trusted, update_coupon_trusted |
| `candy_purchases` | 20 | id | candy_packages, parent_profiles, payment_attempts | 0 | 7 | 1 | candy_purchases_set_updated_at | apply_coupon_to_purchase_trusted, complete_candy_purchase_trusted, create_payment_attempt_trusted, record_payment_attempt_session_trusted, validate_coupon_for_purchase_trusted |
| `candy_transactions` | 9 | id | candy_wallets | 1 | 2 | 2 | prevent_candy_transaction_mutation | complete_candy_purchase_trusted, create_parent_request_trusted |
| `candy_wallets` | 5 | id | parent_profiles | 1 | 1 | 1 | candy_wallets_set_updated_at | complete_candy_purchase_trusted, create_parent_request_trusted, ensure_parent_candy_wallet |
| `characters` | 8 | id | — | 0 | 0 | 0 | — | create_parent_request_trusted |
| `child_profiles` | 7 | id | parent_profiles | 0 | 0 | 1 | — | — |
| `coupon_package_rules` | 2 | coupon_id, package_id | candy_packages, coupons | 0 | 0 | 1 | — | apply_coupon_to_purchase_trusted, create_coupon_trusted, update_coupon_trusted, validate_coupon_for_purchase_trusted |
| `coupon_redemptions` | 16 | id | candy_purchases, coupons, parent_profiles | 2 | 8 | 4 | — | apply_coupon_to_purchase_trusted, update_coupon_trusted, validate_coupon_for_purchase_trusted |
| `coupons` | 16 | id | users | 1 | 9 | 2 | coupons_set_updated_at | apply_coupon_to_purchase_trusted, create_coupon_trusted, update_coupon_trusted, validate_coupon_for_purchase_trusted |
| `creation_pricing` | 6 | id | — | 1 | 2 | 1 | creation_pricing_set_updated_at | create_parent_request_trusted |
| `drawing_animation_requests` | 7 | id | orders | 1 | 0 | 1 | — | create_parent_request_trusted |
| `examples` | 12 | id | characters | 0 | 2 | 2 | examples_set_updated_at | — |
| `homepage_content` | 7 | id | users | 1 | 3 | 1 | homepage_content_set_updated_at | update_homepage_content_trusted |
| `homepage_hero_layout` | 7 | id | users | 1 | 3 | 1 | homepage_hero_layout_set_updated_at | record_homepage_media_replacement_trusted, update_homepage_hero_layout_trusted |
| `homepage_media_assets` | 12 | id | users | 1 | 9 | 1 | homepage_media_assets_set_updated_at | delete_homepage_media_trusted, record_homepage_media_replacement_trusted |
| `media_assets` | 15 | id | orders, users | 0 | 10 | 2 | media_assets_set_updated_at | approve_final_media_trusted, create_parent_request_trusted, record_final_media_trusted, supersede_final_media_trusted, update_order_status_trusted |
| `moderation_logs` | 7 | id | users | 0 | 0 | 0 | moderation_logs_append_only, moderation_logs_truncate_block | — |
| `order_status_history` | 8 | id | orders, users | 0 | 4 | 1 | order_status_history_append_only_trigger, order_status_history_truncate_block | get_order_status_history_admin_trusted, get_parent_order_status_history_trusted, get_parent_orders_delivered_at_trusted, update_order_status_trusted |
| `orders` | 15 | id | characters, parent_profiles, users | 1 | 6 | 2 | — | create_parent_request_trusted, get_order_status_history_admin_trusted, get_parent_order_status_history_trusted, get_parent_orders_delivered_at_trusted, record_final_media_trusted, update_order_status_trusted |
| `parent_profiles` | 8 | id | users | 2 | 2 | 2 | assign_parent_referral_code, ensure_parent_candy_wallet, grant_parent_welcome_image_credits, prevent_parent_referral_code_change | bind_parent_referral_code_trusted, create_parent_request_trusted, generate_parent_referral_code, get_admin_referral_overview_trusted, get_admin_referral_relationships_trusted, get_parent_referral_summary_trusted |
| `parent_welcome_credit_usages` | 4 | id | orders, parent_welcome_credits | 1 | 0 | 2 | parent_welcome_credit_usages_append_only, parent_welcome_credit_usages_truncate_block | create_parent_request_trusted |
| `parent_welcome_credits` | 5 | parent_id | parent_profiles | 0 | 3 | 0 | parent_welcome_credits_set_updated_at | create_parent_request_trusted, grant_parent_welcome_image_credits |
| `payment_attempts` | 21 | id | candy_purchases | 5 | 7 | 8 | payment_attempts_set_updated_at | create_payment_attempt_trusted, record_payment_attempt_session_trusted |
| `payment_webhook_events` | 11 | id | candy_purchases, payment_attempts | 1 | 4 | 4 | — | — |
| `referral_binding_rate_limits` | 4 | parent_id | parent_profiles | 0 | 1 | 0 | — | check_referral_binding_rate_limit |
| `referral_program_settings` | 6 | id | users | 0 | 2 | 0 | referral_program_settings_set_updated_at | bind_parent_referral_code_trusted, get_admin_referral_overview_trusted, get_parent_referral_summary_trusted, update_admin_referral_program_settings_trusted |
| `referral_program_settings_history` | 7 | id | users | 0 | 3 | 2 | trg_prevent_settings_history_delete, trg_prevent_settings_history_update | get_admin_referral_overview_trusted, update_admin_referral_program_settings_trusted |
| `referral_relationships` | 6 | id | parent_profiles | 1 | 3 | 3 | — | bind_parent_referral_code_trusted, get_admin_referral_overview_trusted, get_admin_referral_relationships_trusted, get_parent_referral_summary_trusted |
| `user_identities` | 5 | id | users | 1 | 2 | 2 | — | — |
| `users` | 6 | id | — | 0 | 1 | 0 | — | bind_parent_referral_code_trusted, create_parent_request_trusted, get_admin_referral_overview_trusted, get_admin_referral_relationships_trusted, get_order_status_history_admin_trusted, get_parent_referral_summary_trusted, grant_parent_welcome_image_credits, is_admin_user_id, update_admin_referral_program_settings_trusted |
| `video_requests` | 10 | id | orders | 1 | 1 | 1 | — | create_parent_request_trusted |

`schema_migrations` belongs to the runner and is not a domain table.

## Auth decoupling

- **`public.users` is Cartoona's user table.** Its foreign key to the Supabase
  auth user (`ON DELETE CASCADE`) is removed. `id` stays a UUID primary key and
  now defaults to `gen_random_uuid()`. `role`, `email`, `deleted_at` and the
  timestamps are unchanged.
- **No signup trigger.** Supabase created `public.users` from a trigger on its
  auth table (`handle_new_user`: `id`, `email`, `role = 'parent'`). The backend
  now inserts that row itself, in the same transaction that creates the identity.
- **`user_identities(id, user_id, provider, provider_subject, created_at)`**
  with `unique(provider, provider_subject)` records which external sign-in
  identity belongs to which user. It is needed because, without the FK, nothing
  else in the database says that a user *is* a given Supabase account. The
  data copy writes `('supabase', <auth user id>)` for every existing user, and a
  later provider (phone OTP, for example) adds its own rows without changing
  `users`. Credentials (passwords, OTP, phone verification) stay with the
  provider and never live here. No auth provider is implemented in this release.
- **`users.email` stays a non-unique contact copy**, exactly as today. Sign-in
  uniqueness was enforced by the Supabase auth table. In the plain schema it
  belongs to `user_identities`, not to an email column that phone-only users
  leave NULL.

### Functions that used to read the caller from the session

Supabase functions called `auth.uid()` inside the database. Their plain
versions take the actor explicitly, like the 16 functions that were already
`*_trusted`, and keep the same checks and results:

| Supabase (app calls today) | Plain PostgreSQL | Actor parameter |
|---|---|---|
| `bind_current_parent_referral_code(code)` | `bind_parent_referral_code_trusted` | `p_user_id` (NULL → `session_expired`) |
| `get_current_parent_referral_summary()` | `get_parent_referral_summary_trusted` | `p_user_id` |
| `get_admin_referral_overview()` | `get_admin_referral_overview_trusted` | `p_actor_user_id` (non-admin → no rows) |
| `get_admin_referral_relationships(…)` | `get_admin_referral_relationships_trusted` | `p_actor_user_id` |
| `update_admin_referral_program_settings(…)` | `update_admin_referral_program_settings_trusted` | `p_actor_user_id` (non-admin → `forbidden`) |
| `get_order_status_history_admin(order)` | `get_order_status_history_admin_trusted` | `p_actor_user_id` (non-admin → `request_forbidden`) |
| `get_parent_order_status_history(order)` | `get_parent_order_status_history_trusted` | `p_parent_profile_id` (not owner → `request_forbidden`) |
| `get_parent_orders_delivered_at(ids)` | `get_parent_orders_delivered_at_trusted` | `p_parent_profile_id` (other parents' orders filtered out) |

Removed: `current_parent_profile_id`, `is_admin`, `is_admin_or_super_admin`,
`is_parent` and `is_super_admin`, which read `auth.uid()`; `handle_new_user`;
and the legacy `create_parent_request` and `complete_candy_purchase`, which used
`auth.uid()`, are no longer called, and are replaced by their `*_trusted`
versions. `is_admin_user_id(uuid)` remains the role check. It means `admin` or
`super_admin`, the same as the removed helpers, and like them it does not look
at `deleted_at`.

## Database roles and grants

No `anon`, `authenticated` or `service_role` exists or is referenced. The
baseline grants nothing. It revokes the PostgreSQL default `EXECUTE` to
`PUBLIC` on every function, now and for future ones, because a SECURITY DEFINER
function executable by any login role would act as its owner.

V0.1.39 introduced that role as `cartoona_app` (`0009_application_role.sql`):
a NOLOGIN group role, with login roles as members created per environment by
`scripts/db/app-login-role.sh`. It currently holds `CONNECT`, `USAGE` on
`public` and `SELECT` on the seven tables the read repositories query, and
nothing else. See [POSTGRES_DATA_ACCESS.md](POSTGRES_DATA_ACCESS.md#application-role).
The grants below are added domain by domain, each in a new migration, as write
paths move over:

- `USAGE` on schema `public`;
- `EXECUTE` on the `*_trusted` business functions it calls;
- `SELECT` on the tables the repository reads;
- `INSERT`/`UPDATE` only on the tables and columns the app writes directly
  rather than through a `*_trusted` function. These are to be inventoried from
  the call sites in V0.1.39; known examples are `users` and `user_identities`
  at signup, `parent_profiles` for consent and name, `audit_logs`, and
  `examples`;
- no `UPDATE`/`DELETE` on ledgers or history. The append-only triggers refuse
  them for every role regardless, but the grant should not exist either;
- never ownership and never `BYPASSRLS`. Migrations run as the owner, not as
  the app role.

## RLS replacement plan

The baseline has **no RLS and no policies**. Every Supabase policy is
classified below. *Authorization-critical* rules decide what a caller may see
or change, and must be enforced by the backend/repository on every query:
today some reads run through the user-scoped Supabase client with no explicit
owner filter, so the policy is the only check. *Public visibility* rules are
business filters that must survive. *Defense in depth* rules duplicate a
guarantee that already exists elsewhere.

Actors: **U** = authenticated user id. **P** = that user's
`parent_profiles.id` (`user_id = U`). **admin** = `users.role IN ('admin','super_admin')`.

| Table | Policy (Supabase) | Class | Predicate the backend must enforce |
|---|---|---|---|
| `users` | select own / admin | critical | `id = U`, or admin |
| `parent_profiles` | select/insert/update own; select admin | critical | `user_id = U` (and an insert must set `user_id = U`); admin may read all |
| `orders` | select own parent / admin | critical | `parent_id = P` and role parent, or admin |
| `media_assets` | select own parent / admin | critical | order owned by P **and** (`asset_role = 'source'` **or** (`asset_role = 'final'` and `delivery_status = 'approved'` and `parent_visible`)), or admin. Unapproved finals must never reach a parent. |
| `video_requests`, `drawing_animation_requests` | select own parent / admin | critical | parent order `parent_id = P`, or admin |
| `candy_wallets` | select own / admin | critical | `parent_id = P`, or admin |
| `candy_transactions` | select own / admin | critical | wallet's `parent_id = P`, or admin |
| `candy_purchases` | select own / admin | critical | `parent_id = P`, or admin |
| `payment_attempts` | select own / admin | critical | purchase's `parent_id = P`, or admin |
| `coupon_redemptions` | select own / admin | critical | `parent_profile_id = P`, or admin |
| `parent_welcome_credits`, `parent_welcome_credit_usages` | select own / admin | critical | `parent_id = P`, or admin |
| `referral_relationships` | select own / admin | critical | `referred_parent_id = P`, or admin |
| `coupons`, `coupon_package_rules` | select admin | critical | admin only |
| `referral_program_settings_history` | select admin | critical | admin only |
| `examples` | insert/update/delete admin; select admin | critical | writes admin only |
| `characters`, `candy_packages`, `creation_pricing` | select active / admin | public visibility | non-admins see `is_active = true` rows only |
| `examples` | select published | public visibility | non-admins see `is_published = true` only |
| `homepage_content`, `homepage_media_assets`, `homepage_hero_layout` | select `true` | public visibility | readable by anyone, including anonymous visitors |
| `referral_program_settings` | select `true` (authenticated) | public visibility | readable by any signed-in user |
| all ledgers and history | no UPDATE/DELETE policy | defense in depth | now enforced by triggers (0006 plus existing ones), for every role |
| `audit_logs`, `moderation_logs` | RLS on, no policy | defense in depth | backend-only, append-only trigger |

Storage policies (on the Supabase object table) move to the storage layer. See
the next section.

## Storage decoupling

The schema stores **no Supabase storage objects** and runs no storage query. Cartoona's media metadata
already lives in Cartoona tables, so no new columns are needed:

| Table | Key column | Bucket (implicit, fixed by row type) |
|---|---|---|
| `media_assets` `type='upload'` | `file_url` = `<user id>/<order id>/<file>` | `parent-uploads` (private) |
| `media_assets` `asset_role='final'` | `file_url` = `orders/<order id>/final/<file>` | `final-deliverables` (private) |
| `examples` | `media_url`, `thumbnail_url` | `example-media` (public) |
| `homepage_media_assets` | `storage_path` | `homepage-media` (public) |

`mime_type`, `byte_size`, `original_filename`, `asset_role`, `delivery_status`
and `parent_visible` already cover the provider-neutral metadata. `file_url` is
an object **key**, not a URL; the name is kept for parity. The
`generated-media` bucket is unused by the app. Signed URLs are issued by the
backend from (bucket, key).

Storage rules that become backend/storage-layer checks:

- parent uploads: the key's first segment must be U, and only parents may upload, read or delete their own folder;
- final deliverables: admins read and write; a parent reads a final only if it
  is an approved, parent-visible final of an order they own (this was
  `is_parent_approved_final_deliverable`, now removed);
- example and homepage media are public reads with admin-only writes.

### Request contract: `create_parent_request_trusted`

The function signature gains `p_file_mime_type text DEFAULT NULL`, appended at
the end so existing positional calls keep working. The database **no longer
reads storage**. When `p_file_path` is given, the backend must, **before**
calling:

1. confirm the object exists in `parent-uploads` at exactly `p_file_path`,
2. confirm the upload completed (the provider reports the object, not a pending multipart upload),
3. confirm it belongs to this parent and order (the key starts with `<user id>/<order id>/`),
4. read its MIME type **from the provider's object metadata** and pass it as
   `p_file_mime_type`, never a client-supplied value.

The database still enforces everything it can verify itself: a relative path,
no traversal, the `<parent's user id>/<order id>/` prefix (derived from the
trusted profile, so one parent cannot attach another parent's file), the image
MIME allow-list (`image/jpeg`, `image/png`, `image/webp`), "drawing animation
requires a file", and every order, pricing, wallet and credit rule. Missing
metadata → `request_file_not_found`; bad MIME → `request_file_type_invalid`.
These are the same error codes as before.

### Final-media contract: `record_final_media_trusted`

The backend verifies that the object exists in `final-deliverables` and that
its stored MIME type equals `p_mime_type`, then calls the function. The
database still enforces the admin role, the allowed order status, the
`orders/<order id>/final/` prefix, no traversal, a non-empty MIME type and a
non-negative size. `approve_final_media_trusted` and
`supersede_final_media_trusted` never touched storage and are unchanged.

## Session lifetime: replacement boundary

`get_current_parent_session_policy()`, which reads the auth session table and the JWT
`session_id` claim, is **not ported**. The plain schema contains no session
logic. The 30-day non-sliding parent session limit moves to the future
auth/backend layer. Callers that need a replacement during migration (all via
`checkCurrentParentSessionLifetime` in `lib/auth/parent-session-lifetime.ts`):

- `middleware.ts`, `lib/parent/parent-request-context.ts`, `app/(auth)/complete-request/page.tsx`
- `app/api/requests`, `app/api/parent-consent`, `app/api/parent/gallery`,
  `app/api/parent/password`, `app/api/parent/orders/[orderId]/final-media`
- `app/api/candy-purchases`, `…/[id]/complete`, `…/[id]/coupon`, `app/api/coupons/validate`
- `app/api/referrals`, `app/api/referrals/bind`

## Extensions

Only `pgcrypto`, created `WITH SCHEMA public`, for `gen_random_bytes()` in
`generate_parent_referral_code` (previously `extensions.gen_random_bytes`).
`gen_random_uuid()` is core PostgreSQL. No `uuid-ossp`, `citext`, `pg_trgm`
or `vector` is used by any migration.

## Transaction-critical logic preserved

| Guarantee | Where | Proven by |
|---|---|---|
| One order per `(parent_id, submission_key)`; replays return the original | partial unique index plus `ON CONFLICT` plus a re-check after the wallet lock | sequential replay; 10 concurrent same-key calls → 1 order |
| Wallet locked `FOR UPDATE`, then welcome credits locked `FOR UPDATE` (fixed order) | `create_parent_request_trusted` | 5 concurrent requests / 3 credits → exactly 3. Removing the locks fails this test. |
| Welcome credit first for images, candy fallback, video/animation candy-only | same | credit/candy ordering tests; DB CHECK `image_only` |
| Exactly one payment source, rolled back with the order | same transaction | insufficient-funds tests create nothing |
| No negative balance / no credit overspend | CHECK constraints plus guarded decrement | 8 concurrent candy requests for 3 → 3, others `INSUFFICIENT_CANDIES` |
| Candy ledger append-only | `prevent_candy_transaction_mutation` | update/delete refused |
| Order history append-only (cascade allowed) | `order_status_history_append_only` | update/delete/truncate refused; order delete cascades |
| Order status optimistic concurrency | `update_order_status_trusted` | 4 concurrent admins → 1 wins, 3 `request_status_conflict` |
| Coupon optimistic concurrency | `update_coupon_trusted` | 4 concurrent edits from one snapshot → 1 wins, 3 `coupon_admin_conflict` |
| Referral settings optimistic concurrency and immutable history | `update_admin_referral_program_settings_trusted` plus history triggers | stale snapshot → `conflict`; history immutable |
| One profile, wallet, grant and referral code per user | unique constraints plus `AFTER INSERT` triggers | 8 concurrent profile creates → 1 |
| Audit log / moderation log / credit usage append-only | **new** `append_only_guard` triggers | update/delete/truncate refused; cascade allowed |

Purchase completion (`complete_candy_purchase_trusted`), coupon application
(`apply_coupon_to_purchase_trusted`), payment attempts and the homepage CMS
functions are carried over byte-identically. The parity test checks this by
comparing the md5 of each function's source.

## Schema parity

Checked mechanically by `plain-postgres-db.test.ts` against the live Supabase chain.

| Domain | Status | Notes |
|---|---|---|
| All 31 domain tables, all columns | **identical** | except `users.id`, which gains a `gen_random_uuid()` default (intentional: users are created without an external id) |
| Constraints (CHECK, unique, PK, FK) | **identical** | except `users_id_fkey → auth.users`, which is **no longer required**. One CHECK is reprinted `(a AND b) AND c` → `a AND b AND c`, the same predicate. |
| Indexes | **identical** | |
| Triggers | **identical** plus 6 | **intentionally added**: append-only guards on `audit_logs`, `moderation_logs` and `parent_welcome_credit_usages` (previously RLS/grant-only) |
| `user_identities` | **intentionally added** | provider-neutral identity mapping |
| 23 business, helper and trigger functions | **identical** (same source md5) | |
| `create_parent_request_trusted`, `record_final_media_trusted` | **intentionally changed** | storage lookups replaced by the backend contracts above |
| `generate_parent_referral_code` | **intentionally changed** | `extensions.gen_random_bytes` → `public.gen_random_bytes` |
| `update_order_status_trusted`, `update_homepage_content_trusted`, `record_homepage_media_replacement_trusted` | **identical behaviour** | one comment line inside the body reworded (it named a Supabase role) |
| 8 `auth.uid()` functions | **intentionally changed** | explicit-actor `*_trusted` variants (table above) |
| `is_admin*`, `is_parent`, `is_super_admin`, `current_parent_profile_id`, `is_parent_approved_final_deliverable`, `handle_new_user` | **no longer required** | session-claim and storage-policy helpers |
| `create_parent_request`, `complete_candy_purchase` | **no longer required** | legacy, not called; superseded by `*_trusted` |
| `get_current_parent_session_policy` | **deferred** | session lifetime moves to the auth layer |
| 48 table policies and 19 storage policies, RLS enablement | **deferred** | to the backend and storage layer (RLS plan above) |
| Grants to Supabase roles | **no longer required** | app-role grants deferred to V0.1.39 |
| Storage buckets (5) | **deferred** | storage provider configuration, not database rows |
| Reference rows | **identical values** | fresh ids per environment, as in Supabase |

## Data-copy mapping (design only, nothing copied)

Copy order follows foreign keys. **Every primary key is copied unchanged**:
orders, media, ledger entries, purchases, payment attempts, coupons, referral
rows and audit entries are all referenced by id: from each other, from storage
object keys (`<user id>/<order id>/…`, `orders/<order id>/final/…`), from
payment providers and from URLs.

| Supabase source | Plain target | Notes |
|---|---|---|
| `auth.users` × `public.users` | `public.users` | copy `public.users` as-is: `id` is the auth user id and **must stay identical**, because storage keys and every FK use it |
| `auth.users.id` | `user_identities ('supabase', id)` | one row per user. Phone and email credentials stay with the auth provider. |
| `parent_profiles`, `child_profiles` | same | disable the `AFTER INSERT` triggers during the copy (`session_replication_role = replica`), otherwise a second wallet, grant and referral code would be generated; copy `candy_wallets`, `parent_welcome_credits` and `referral_code` from the source |
| `characters`, `creation_pricing`, `candy_packages`, `referral_program_settings`, `homepage_*` | same | **replace** the baseline's reference rows (truncate first); orders and purchases reference production ids |
| `orders`, `video_requests`, `drawing_animation_requests` | same | ids unchanged; `submission_key` preserved for idempotency |
| `media_assets` | same | `file_url` keys unchanged; objects are copied to the new storage provider under the **same keys** |
| `order_status_history` | same | copy with triggers disabled (append-only blocks nothing on INSERT, but keep one copy path) |
| `candy_wallets`, `candy_transactions` | same | ledger copied verbatim; verify `balance = sum(amount)` per wallet after the copy |
| `parent_welcome_credits`, `parent_welcome_credit_usages` | same | verify `used_count = count(usages)` per parent |
| `candy_purchases`, `payment_attempts`, `payment_webhook_events` | same | provider references unchanged |
| `coupons`, `coupon_package_rules`, `coupon_redemptions` | same | |
| `referral_*` | same | |
| `audit_logs`, `moderation_logs` | same | INSERT only; the append-only triggers permit it |
| `storage.objects` (5 buckets) | object storage, not the database | copy objects under unchanged keys |
| `auth.sessions`, `auth.identities`, other auth tables | not copied | sessions are re-established with the new auth layer |

## Remaining blockers before the app can use this database

1. **Data-access layer:** done in V0.1.39 for reads (`pg` pool, `cartoona_app` role, read repositories with explicit actors). Write repositories and their grants follow per domain; see [POSTGRES_DATA_ACCESS.md](POSTGRES_DATA_ACCESS.md#before-the-first-route-cuts-over).
2. **Call-site changes:** the 8 renamed explicit-actor functions, and `p_file_mime_type` supplied by the request route after storage verification.
3. **Auth:** user creation and identity resolution (`user_identities`), plus a replacement for the parent session-lifetime check and its 15 call sites. Supabase Auth can stay in front temporarily, with its user id resolved through `user_identities`.
4. **Storage:** the object-storage provider, signed URLs, and the storage access rules above.
5. **Data copy:** the copy procedure above, with balance, credit and history verification.
6. **Mirroring:** any Supabase migration added before cutover must get a matching `database/migrations` file; the parity test enforces this.
