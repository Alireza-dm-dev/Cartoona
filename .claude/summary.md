# Cartoona — Session Summary

## Project State
- **Phase:** MVP 0 (Foundation) — 43 routes (30 pages + 13 API endpoints), all functional at the foundation level
- **Supabase project:** `oucyhmrnzahlhqjfqcge` — live PostgreSQL + Storage connected
- **Auth:** Working parent/admin authentication with phone/password login; development demo-login; middleware-protected admin and dashboard routes
- **Session:** 30-day non-sliding parent session lifetime enforcement (`get_current_parent_session_policy` RPC)
- **Storage:** Private `parent-uploads` and `generated-media` buckets; public `example-media` bucket
- **Database:** 30 migrations applied (local = remote 30/30), latest applied: `20260801110000_admin_coupon_management.sql`; +1 local-only pending: `20260801120000_request_fulfilment_workflow.sql` (31 local / 30 remote until pushed)

## Live APIs
- `POST /api/requests` — Multipart form submission
- `GET /api/creation-pricing` — Active pricing catalog
- `POST /api/demo-login`, `POST /api/logout`, `POST /api/parent-consent`, `POST /api/parent/password`
- `GET /api/referrals`, `POST /api/referrals/bind`
- `GET /api/admin/referrals`, `PATCH /api/admin/referrals/settings`
- `GET /api/dev/parent-auth`, `GET /api/dev/supabase-check`
- CRUD /api/admin/examples, publish, media
- `POST /api/candy-purchases` — Create pending purchase (parent auth)
- `POST /api/candy-purchases/[id]/complete` — [DEV-ONLY] Simulated payment completion

## Admin Referral Management (July 28)
- Migration `20260727120000_admin_referral_management.sql`
- GET/PATCH admin referral endpoints with full validation, error privacy, admin-only access
- Types in `lib/referrals/admin-types.ts`

## Parent Candy & Payment Page (July 30)
- `GET /api/candy-packages` — public read-only active package catalog (cacheable 5 min)
- `GET /api/candy-purchases` — authenticated parent wallet + purchase history (no-cache)
- `POST /api/candy-purchases` — creates pending purchase (only package_id sent client-side)
- `POST /api/candy-purchases/[id]/complete` — [DEV-ONLY] simulated payment completion
- **Security remediated:** RPC is no longer directly callable by authenticated role. Uses trusted server-only RPC via admin client.
- Production block: `CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION` must be `"true"` and `NODE_ENV` must not be `"production"`.
- UI is Persian RTL with: wallet balance card, package catalog (3-column grid), confirmation dialog, dev-only completion panel, responsive purchase history (table → cards on mobile)
- 28 mocked UI tests (guarded — requires disposable target)
- Components: `candy-balance-card`, `candy-package-card`, `candy-purchase-confirmation`, `candy-purchase-history`, `candy-billing-dashboard`
- Types: `lib/candy-purchases/types.ts`
- No real payment gateway yet. Completion is a dev simulation only.
- Stateful purchase API tests (10 scenarios) remain pending without safe disposable target.

## Database Foundations
- Candy wallet + ledger, atomic order debit, creation pricing catalog
- Parent profiles with consent, characters, child profiles, orders, media, moderation
- Examples CMS with storage bucket
- Storage RLS, role helpers, referral binding/rate-limiting
- Referral dashboard at `/dashboard/referrals`

## Test-Isolation & Guard Hardening (July 28, two phases)

### Phase 1 — Guard foundation + flaky fixes
- `tests/helpers/assert-safe-database-target.ts` — identifies target, blocks main project
- Guard unit tests (11 cases) + smoke test
- Flaky referral-dashboard tests: replaced `ensureBoundState()` timeout with API-based pre-binding
- Flaky login-destination tests: cookie clearing + single navigation
- 6 stateful suites guarded with module-scope or beforeAll throw
- Env loading fix: all specs load `.env.local` into `process.env` before guard

### Phase 2 — Tightened guard + data cleanup
- **Guard now rejects arbitrary non-main `*.supabase.co` projects** — initial implementation
- **Cartoona Migration Test project** `guhhlshjvmiwwmixiulk` is always forbidden
- **URL/ref disagreement fails closed** — mismatch produces `unknown` rejection
- 5 target kinds: `main`, `forbidden_known_project`, `local`, `explicit_disposable`, `unknown`
- Guard unit tests expanded to 17 cases; smoke test covers 8 scenarios
- **Removed 2 synthetic referral_relationships rows** (migration `20260727122000`)
- Both rows were from unguarded test execution — orphaned after cascade-deleted test users
- Settings, codes, wallets, and pricing all verified unchanged
- 24 migrations now in sync (local=remote)

### Phase 3 — Every identifier must agree (July 29)
- **No environment variable receives silent priority.** All of `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, and `CARTOONA_TEST_SUPABASE_PROJECT_REF` are
  collected and cross-checked. Any disagreement returns `kind = "unknown"` and is rejected.
- **Strict URL validation**: paths, queries, fragments, and credentials are rejected.
  Only clean `https://<ref>.supabase.co` or `http://localhost:<port>` URLs accepted.
- **Loopback equivalence**: `localhost`, `127.0.0.1`, and `[::1]` treated as equivalent,
  but ports must match across all local identifiers.
- **Main or Migration Test hidden behind any identifier** is detected and blocked.
  A disposable-looking identifier cannot hide a forbidden project ref.
- **Guard unit tests expanded to 33 cases** covering: forbidden-project hiding,
  URL/ref disagreement, local/hosted mix, port mismatch, empty/whitespace vars,
  URL component rejection, lookalike hosts, uppercase normalization, duplicate URLs,
  cross-swapped NEXT_PUBLIC/SUPABASE_URL roles.
- **Smoke tests updated to 10 scenarios** including forbidden-project hiding, local/hosted
  conflict, equivalent local hosts, and different local ports.
- **login-destinations.spec.ts** guard moved from `test.beforeAll` to module-scope throw
  for consistency with the other 5 stateful suites.

### Phase 4 — Pre-launch cleanup (July 29)
- **One-time cleanup migration** `20260727123000_remove_all_synthetic_test_data.sql`
  removed all proven synthetic artifacts from the main project.
- **97 synthetic auth users** removed (preserving 2 real administrative accounts).
- **75 synthetic parent_profiles, 75 candy_wallets, 102 referral_relationships** removed.
- **Deterministic predicate** based on 7 known synthetic email domains. No broad
  "all except two" deletion. Safe no-op on clean environments. Fails closed on
  unexpected state.
- **Referral settings** (enabled, 1500bps) and **creation pricing** (9 rows) preserved.
- **Forensic audit** documented at `docs/FORENSIC_AUDIT.md`.
- Parent/customer tables reset to clean pre-launch state: 0 profiles, 0 wallets,
  0 relationships, 0 orders, 0 children, 0 media.

## Phase 5 — Payment-Completion Security Fix (July 30)
- **Blocker resolved:** `complete_candy_purchase` was `GRANT EXECUTE TO authenticated` — any parent with a Supabase auth session could call it directly via REST API, bypassing the `NODE_ENV` guard.
- **Migration** `20260730100000_restrict_candy_purchase_completion.sql`:
  - Created `complete_candy_purchase_trusted(UUID, UUID, TEXT)` — accepts verified `parent_profile_id` instead of relying on `auth.uid()`
  - Revoked EXECUTE from `PUBLIC`, `anon`, `authenticated` on both functions
  - Granted EXECUTE only to `service_role` on the trusted function
- **API route updated** to use `createAdminSupabaseClient()` (service_role key) for the RPC call. Ownership preserved via server-resolved `parent_profile_id`.
- **Explicit simulation flag** `CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION` — production always disabled; non-production requires `"true"`.
- **Client UI** now receives simulation capability as a server prop (replaces fragile `window.location.hostname === "localhost"`).
- **16 unit tests** added for simulation-policy behavior (69/69 total).
- **Verified privileges:** anon/authenticated → `permission denied`; service_role → trusted function reachable.
- **Zero database mutation** during remediation — all counts unchanged (0 wallets, 0 purchases, 0 transactions).
- **26/26 migrations** local=remote.
- **Stateful payment tests** remain pending without a safe disposable target.

## Phase 6 — Parent Request Creation Security Fix (July 31)
- **Known-debt resolved:** `create_parent_request` was `GRANT EXECUTE TO authenticated` + `auth.uid()` — browser sessions could invoke the atomic order+debit RPC directly, bypassing the API route's session-lifetime policy.
- **Migration** `20260731100000_restrict_parent_request_creation.sql`:
  - Created `create_parent_request_trusted(p_parent_profile_id UUID, ...)` — accepts verified `parent_profile_id` instead of relying on `auth.uid()`; same validations, catalog pricing, wallet lock, atomic debit, ledger insert; file-path prefix check binds to the parent's real auth user id (derived from `parent_profiles.user_id`)
  - Revoked EXECUTE from `PUBLIC`, `anon`, `authenticated` on both functions
  - Granted EXECUTE only to `service_role` on the trusted function
- **API route updated** (`app/api/requests/route.ts`) to call the trusted RPC via `createAdminSupabaseClient()`; file upload still uses the user session.
- **Error mapping extracted** to `lib/requests/request-rpc-error.ts` (pure function) + 8 unit tests.
- **Verified privileges:** anon → `permission denied` on both functions; service_role → trusted function reachable; old function unusable by service_role (`request_unauthenticated`).
- **Zero database mutation** during remediation (DDL-only migration).
- **27/27 migrations** local=remote.

## Phase 7 — Provider-Neutral Payment Foundation (July 31)
- **Migration** `20260731110000_provider_neutral_payment_foundation.sql` (DDL-only, zero production data mutation):
  - `payment_attempts` — one row per attempt to pay a candy purchase; provider session/transaction/checkout/verification/failure state isolated per attempt; `attempt_number` + `idempotency_key` unique per purchase; partial unique provider-session/transaction indexes; `idx_payment_attempts_verified_once` enforces at most one verified attempt; CHECK on status/amounts/currency/failure_message_safe; `set_updated_at` trigger
  - `payment_webhook_events` — provider webhook dedup table, `UNIQUE(provider, provider_event_id)`, no raw payloads; **no policies** → browser roles fully denied (verified: no anon/authenticated grants)
  - `candy_purchases` additions: `active_payment_attempt_id` (FK → payment_attempts ON DELETE SET NULL), `payment_provider`, `provider_verified_at`, `expires_at`, `cancelled_at`, `failed_at`; status CHECK extended with `expired`
  - Status model: purchase `pending → paid | failed | cancelled | expired` (transient provider states live on attempts); retry allowed after `failed`/`expired` (new attempt, same purchase); `paid`/`cancelled` terminal
  - RLS: parents may SELECT attempts of own purchases (join via candy_purchases → parent_profiles → auth.uid); admin/super_admin SELECT all; no browser writes
  - Trusted service-role-only RPCs: `create_payment_attempt_trusted` (locks purchase FOR UPDATE, copies amounts from purchase snapshot — never caller input, idempotent on `(purchase_id, idempotency_key)`, rejects paid/cancelled, computes next attempt_number, re-activates failed/expired) and `record_payment_attempt_session_trusted` (only from `created`, rejects session reuse). Both SECURITY DEFINER, `search_path=''`, EXECUTE only to service_role (verified)
- **Types:** `DbPaymentAttempt`, `DbPaymentWebhookEvent`, `PaymentAttemptStatus`, `PaymentWebhookProcessingStatus`, trusted-RPC param/result types, error codes in `types/database.ts`; provider-neutral app types in `lib/payments/types.ts`; pure rules in `lib/payments/rules.ts` (status/terminal checks, retry eligibility, amount+currency verification equality, idempotency-key validation, safe failure-code validation, public serialization excluding internal fields)
- **Unit tests:** `tests/unit/payment-rules.test.ts` (16 cases) — 89/89 total pass
- **Verified remote (main project):** 28/28 migrations synced; all columns/constraints/indexes/RLS/privileges match design; `payment_attempts`=0, `payment_webhook_events`=0 rows; candy_purchases/wallets/transactions/packages unchanged (3 packages, 0 purchases, 0 wallets, 0 transactions); anon has no grants on either new table
- **No real gateway integration** — no provider HTTP/SDK/webhook route/pay endpoint yet; packages remain placeholders pending commercial approval

## Phase 8 — Admin Request Queue + Detail on Real Data (Aug 1)
- **Goal:** Replace mock/sample data in the two Admin request pages with real read-only Supabase data. No mutations, no status updates, no media uploads, no payments.
- **No migration needed** — schema fully supports the pages today (28/28 migrations unchanged).
- **Read-only architecture:** Server Components + `createServerSupabaseClient()` (RLS-backed user session, admin SELECT-all via `is_admin()`). No service-role reads for ordinary admin pages.
- **New `lib/admin/requests/`:** `types.ts` (UI models only — no raw paths), `mappers.ts` (Persian type/status/moderation labels, safe parent/child fallbacks: «بدون پروفایل کودک» / «حساب والد حذف شده است» / «وضعیت نامشخص»), `validation.ts` (filters, page 25/50, clampPage), `queries.ts` (queue with exact count + joins, detail with video/drawing extension rows + character).
- **New `lib/storage/private-signed-url.ts`:** 300s signed URLs, `parent-uploads` bucket, server-only, returns null on failure (never throws).
- **`app/admin/requests/page.tsx`:** real queue with type filters (همه/تصویر/ویدیو/انیمیشن نقاشی), all-8 status filters (Persian), pagination, empty/error states.
- **`app/admin/requests/[requestId]/page.tsx`:** real detail — overview, parent (name/email), child fallback, type-specific rows (image/video/drawing_animation), media cards with image/video preview or download via signed URLs; signing failure → «فایل در حال حاضر در دسترس نیست.». UUID regex + `notFound()`.
- **`config/admin.ts`:** type labels shortened to تصویر/ویدیو/انیمیشن نقاشی + `UNKNOWN_REQUEST_TYPE_LABEL`.
- **Tests:** `tests/unit/admin-requests.test.ts` (26 cases) — 115/115 total pass. Guard unit suite (33) unchanged/passing.
- **Verified:** `next build` succeeds; lint 0 errors; 28/28 migrations synced; zero DB mutation (all count checks unchanged); no mock data remains in `app/admin/requests/`; no storage paths/IDs/secrets in public models.

## Phase 9 — Coupon Foundation (Aug 1)
- **Goal:** Server-authoritative coupon system for candy-package purchases: coupons / coupon_package_rules / coupon_redemptions tables, explicit purchase price snapshots, integer discount math, service-role-only validate/apply trusted RPCs, `POST /api/coupons/validate` (read-only) + `POST /api/candy-purchases/[id]/coupon` (atomic, idempotent), pure unit tests + guarded stateful e2e.
- **Migration** `20260801100000_coupon_foundation.sql` (DDL-only; **written but NOT yet applied to main** — 28/28 remote, 29 local):
  - `coupons` — normalized code (`upper(trim(code))`, regex `^[A-Z0-9_-]{3,32}$`, DB-unique), `percentage` (integer basis points 1..10000) | `fixed_amount` (integer IRR), date window, global/per-parent limits, minimum amount, max discount cap, `idx_coupons_active_lookup`, `set_updated_at` trigger; **zero seed rows**
  - `coupon_package_rules` — PK(coupon_id, package_id), both FK CASCADE; zero rows = all packages
  - `coupon_redemptions` — full snapshot at apply time; status `reserved|redeemed|cancelled`; price-consistency CHECK; `UNIQUE(purchase_id)` (one coupon per purchase) + `UNIQUE(purchase_id, idempotency_key)` (idempotent apply)
  - `candy_purchases` additions: `original_price_amount` (NOT NULL), `discount_amount` (NOT NULL DEFAULT 0), `final_price_amount` (NOT NULL) + safe backfill + invariant CHECK `original_price_amount = price_amount AND original − discount = final`; `price_amount` remains the pre-discount snapshot
  - RLS: coupons+rules admin SELECT-all only (no parent enumeration), redemptions parent SELECT-own + admin SELECT-all; no browser writes to any coupon table
  - `calculate_coupon_discount(...)` pure IMMUTABLE integer helper (percentage floor; fixed min; max cap; never negative)
  - `validate_coupon_for_purchase_trusted(UUID,UUID,TEXT)` — read-only (no lock, no writes); `apply_coupon_to_purchase_trusted(UUID,UUID,TEXT,TEXT)` — atomic (FOR UPDATE, idempotent, insert redemption + update purchase amounts); both REVOKEd from PUBLIC/anon/authenticated, GRANTed only to service_role
  - Coupon-before-attempt rule: both RPCs reject once `active_payment_attempt_id` is set (`coupon_purchase_has_payment_attempt`); payment attempts must charge `final_price_amount`
  - Error codes raised lowercase + non-enumerating message for unknown/inactive/not-started/expired: «این کد تخفیف معتبر نیست.»
- **Routes:** `app/api/coupons/validate/route.ts` (body `{purchase_id, code}`, JSON-only ≤1024B, unknown-field rejection, no client prices) and `app/api/candy-purchases/[id]/coupon/route.ts` (body `{code, idempotency_key}`); both parent-auth + role + session-lifetime, call trusted RPCs via `createAdminSupabaseClient()`, map errors via `lib/coupons/errors.ts`.
- **`app/api/candy-purchases/route.ts`** now writes `original_price_amount`/`discount_amount:0`/`final_price_amount` at creation.
- **`lib/coupons/`:** `types.ts` (constants, public result shapes, `toCouponValidationResult`/`toAppliedCouponResult`), `rules.ts` (normalize, code/idempotency-key/amount validation, integer discount math, date window, minimum amount), `errors.ts` (`mapCouponRpcError` → safe Persian + status). **`lib/payments/rules.ts`** gained `payableAmountForPurchase()` (provider must charge `final_price_amount`) + `canApplyCouponToPurchase()`.
- **Tests:** `tests/unit/coupon-rules.test.ts` (27 cases) — **142/142 total unit pass**. `tests/e2e/coupon-api.spec.ts` (25 guarded cases) written; guard blocks against main project (verified) — requires disposable/local target to execute.
- **Verified:** `next build` succeeds; lint 0 errors (28 pre-existing warnings); migration list 28 remote / 29 local (only `20260801100000` pending); security greps clean (no browser writes to coupon tables, no leftover coupon/discount code elsewhere).
- **Deferred:** migration push to main + stateful e2e execution require approval / disposable target; redemption promotion to `redeemed` deferred to payment-verified task.

## Phase 10 — Admin Coupon Management (Aug 1)
- **Goal:** Secure Admin coupon CRUD on top of the coupon foundation: admin-only list/create/edit pages, trusted service-role create/update RPCs, immutable-after-use policy, usage counts, optimistic concurrency, package restrictions, full Persian RTL UI, mocked UI tests + guarded stateful API tests. No DELETE, no parent checkout coupon input, no Bale payment.
- **Migration** `20260801110000_admin_coupon_management.sql` (DDL-only, **APPLIED to main** — 30/30 local=remote, verified live):
  - `public.is_admin_user_id(UUID)` helper — SECURITY DEFINER, service_role-only, no `auth.uid()`
  - `create_coupon_trusted(...)` / `update_coupon_trusted(...)` — SECURITY DEFINER `SET search_path=''`, re-verify admin role inside, code normalization in-database, package rules replaced atomically, update locks `FOR UPDATE` + strict `expectedUpdatedAt` → `coupon_admin_conflict` (409), immutability after any reserved/redeemed redemption (`coupon_admin_immutable_discount`), usage-limit-vs-current checks (`coupon_admin_usage_limit_conflict`), duplicate-code-excluding-self, controlled `(coupon_id, code)` result
  - REVOKE from PUBLIC/anon/authenticated, GRANT EXECUTE to service_role only (verified live on main: only postgres + service_role have EXECUTE)
- **API:** `GET/POST /api/admin/coupons` (list w/ search+status+discountType filters, backend pagination max 50, DB-derived usage counts; JSON-only ≤4096B, no-store+nosniff, no redemption IDs/parent identities) and `GET/PATCH /api/admin/coupons/[id]` (detail w/ created-by, optimistic concurrency 409, field-error 422). **No DELETE.**
- **Service layer** `lib/admin/coupons/`: `types`, `status` (derive active/inactive/scheduled/expired — never stored), `validation` (list params + `validateCouponInput` field errors), `queries` (server-only list/detail/packages), `service` (`requireAdminCouponsAuth` 401/403, trusted-RPC calls via new `lib/supabase/admin.ts` `createAdminSupabaseClient()`), `errors` (`mapAdminCouponRpcError` → Persian + status), `format` (fa-IR IRR, percent, usage/reserved summaries), `use-admin-coupons` (client hook, 401/403 → admin-login).
- **UI:** `/admin/coupons` (filters, table→mobile cards, pagination, empty/filtered-empty/error+retry, «کد تخفیف جدید»), `/admin/coupons/new`, `/admin/coupons/[couponId]` (prefill, `expectedUpdatedAt` from loaded detail, immutable-field explanations for used coupons). `components/admin/coupons/`: `coupon-form` (all fields, code-normalization preview, percentage bp conversion, package selector, `role="switch"` toggle, native datetime/number inputs), `coupon-status-badge`, `confirm-dialog` (keyboard-accessible: focus trap, Escape, focus restore, aria). Deactivation / limit-reduction-below-usage / package-change-after-reserved all require confirm. Nav «کدهای تخفیف» added to desktop sidebar + new mobile horizontal nav in `app/admin/layout.tsx`.
- **Tests:** `tests/unit/admin-coupons.test.ts` (33 cases) — **175/175 total unit pass**. `tests/e2e/admin-coupons-dashboard.spec.ts` (40 mocked-UI scenarios via `page.route`, one synthetic admin Auth user cleaned up, no coupon rows anywhere). `tests/e2e/admin-coupons-api.spec.ts` (18 guarded stateful cases) — blocked against main, requires disposable/local target.
- **Verified:** `next build` succeeds; lint 0 errors (29 pre-existing warnings); `npx supabase migration list` 30/30; `db push --dry-run` confirmed exactly one pending before applying; main DB before/after aggregates identical (coupons=0, rules=0, redemptions=0, purchases=0, packages=3); security greps clean (no direct coupon writes in app code, no secrets in errors, no parent data in responses).
- **Deferred/blocked:** stateful Admin coupon e2e (`admin-coupons-api.spec.ts`) unexecuted pending a safe disposable/local target; parent checkout coupon input + Bale payment remain out of scope.

## Phase 11 — Parent Billing Coupon Integration (Aug 1)
- **Goal:** Surface the coupon system in the parent billing journey: extended GET read model (server-derived pricing/coupon/payment booleans), coupon validation + atomic apply on pending purchases, applied-state lock, `expired` purchase support, safe non-enumerating error display, and mocked-UI coverage. **No migration** (read model derives from existing snapshot/redemption/attempt tables).
- **GET `/api/candy-purchases` read model** now returns per purchase: `originalPriceAmount`/`discountAmount`/`finalPriceAmount` (from `candy_purchases` snapshot columns), `couponApplied` (authoritative — from a `coupon_redemptions` row in `reserved`/`redeemed`, **never** inferred from `discountAmount > 0`), `couponCodeSnapshot` + `couponStatus` (from the redemption, survives later coupon edits/deactivation), `couponName` (safe display name via a limited service-role lookup, never internal config), `paymentStarted` (boolean — existence of any `payment_attempts` row), and `status` now including `expired`. Single serializer `toParentCandyPurchaseSummary(row, packageName)` in `lib/candy-purchases/types.ts`. No internal IDs or provider state ever returned.
- **Public coupon serializers de-scoped of internal IDs** (`lib/coupons/types.ts`): `CouponValidationResult` drops `couponId`; `AppliedCouponResult` drops `redemptionId`+`couponId`. Trusted RPC result types in `types/database.ts` unchanged. Validate response: `{normalizedCode, discountType, originalPriceAmount, discountAmount, finalPriceAmount, currency}`. Apply response adds `discountValue` + `status`.
- **`expired` purchase status** added to `PurchaseStatusLabel`, history `statusConfig` («منقضیشده», default variant). Expired purchases never render coupon controls.
- **Enumeration protection preserved:** not-found/inactive/not-started/expired still share the single public message «این کد تخفیف معتبر نیست.» — server mapping unchanged; the UI renders the server-provided `message` (single source of truth, no client message re-derivation).
- **UI:** new `components/dashboard/billing/pending-purchase-card.tsx` — per-pending-purchase price breakdown, coupon input (LTR), «بررسی کد» (read-only validate → live preview) then «اعمال کد» (apply with a **single stable idempotency key reused across retries**, never timestamp-only), «پاک کردن ورودی», applied lock («برای هر خرید فقط یک کد تخفیف قابل استفاده است.»), payment-started lock, zero-final-price deferred-completion notice («...پس از افزودن جریان تأیید رایگان فعال خواهد شد.»). Rendered in `candy-billing-dashboard.tsx` under «سفارشهای در انتظار پرداخت»; shared `refreshBilling()` after create/apply/complete.
- **History** (`candy-purchase-history.tsx`) now shows final price (strikethrough original when discounted) + coupon code/name line in both table and mobile cards.
- **Tests:** new `tests/unit/candy-purchase-read-model.test.ts` (8 cases) — safe serialization, ID exclusion, `paymentStarted`/`couponApplied` booleans, zero-discount coupon still applied, `expired` mapping. `coupon-rules.test.ts` updated to assert ID exclusion in public serializers. **183/183 unit pass**; lint 0 errors (29 pre-existing warnings); `next build` succeeds; graphify updated (1594 nodes).
- **Mocked UI e2e** (`candy-billing-dashboard.spec.ts`, 28 → 39 scenarios): existing strict-mode locators made `.first()`-safe; added coupon flow mocks (`/api/coupons/validate`, coupon apply sub-route); new scenarios for validate/apply request shapes, stable idempotency key reuse on retry, applied lock, payment-started lock, expired mapping, safe error display, and format-gated validate button. Executes only with a dev server.
- **Deferred/blocked:** stateful coupon e2e still requires a disposable/local target; free (zero-final) purchase completion flow explicitly out of scope.

## Phase 12 — Request Fulfilment Workflow (Aug 1)
- **Goal:** Secure Admin request-fulfilment workflow: controlled status transitions, append-only activity history, private final-media upload/approval/supersede, parent-safe visibility. 27-part task on the main Supabase project `oucyhmrnzahlhqjfqcge`.
- **Migration** `20260801120000_request_fulfilment_workflow.sql` (written, **NOT yet applied to main** — 30/30 remote, 31 local):
  - `order_status_history` — append-only (BEFORE UPDATE/DELETE/TRUNCATE trigger raises), FK `order_id` CASCADE + `changed_by_user_id` SET NULL, status + note-length CHECKs, index `(order_id, created_at DESC)`, RLS on, no anon/authenticated grants
  - `media_assets` extension: `asset_role source|final|preview|supporting`, `delivery_status uploaded|approved|superseded`, `parent_visible`, `uploaded_by_user_id`, `original_filename`, `byte_size`, `superseded_at`, `updated_at`+trigger; invariant CHECKs (final/preview ⇒ type='generated', superseded ⇒ hidden, byte_size ≥ 0, filename ≤ 255)
  - **Parent visibility tightened:** parent `media_assets` SELECT now returns only `source` assets or `final` assets that are `approved` + `parent_visible`
  - Bucket `final-deliverables` (private, 100MiB, MIME whitelist png/jpeg/webp+mp4/webm); path `orders/<order-id>/final/<uuid>.<ext>`; admin CRUD + parent SELECT only via SECURITY DEFINER `is_parent_approved_final_deliverable(path)` (row must be an approved parent-visible final of the parent's own order)
  - Trusted service-role-only RPCs: `update_order_status_trusted` (FOR UPDATE + `expectedUpdatedAt` → `request_status_conflict` 409, transition map, ready-needs-approved-final / rejected-needs-reason, atomic order update + history insert), `record_final_media_trusted` (`uploaded`/not-visible, re-checks admin + order status + path traversal + storage object MIME), `approve_final_media_trusted` (`uploaded→approved` + parent_visible), `supersede_final_media_trusted` (`→superseded`, hidden, stamped; no delete). Read functions: `get_order_status_history_admin` (admin, internal notes) + `get_parent_order_status_history` (own order, parent-visible note only). All `SET search_path=''`, EXECUTE only to service_role.
  - **No new status values** — existing 8 suffice; no refunds; no wallet/ledger change.
- **TS single source of truth** `lib/admin/requests/workflow.ts`: `ALL_ORDER_STATUSES`, `TRANSITION_MAP`, `checkTransition`, `getAllowedNextStatuses`, `isTerminalStatus`, `canUploadFinalMedia`, `requiresApprovedFinalMedia`, `requiresRejectionReason`, `normalizeNote` (trim→NULL, 2000 max), `mapOrderStatusLabel` (Persian), `STATUS_TONES`/`mapStatusTone`; `mappers.ts` re-exports for backward compat.
- **`lib/admin/requests/`:** `media-validation.ts` (`FINAL_DELIVERABLES_BUCKET`, MIME/size caps, `buildFinalStoragePath`, `isSafeOrderId`, `sanitizeOriginalFilename`), `fulfilment-types.ts` (safe models + serializers + `parseAdminStatusUpdateInput` strict unknown-key rejection, ISO `expectedUpdatedAt`), `fulfilment-errors.ts` + `fulfilment-error-codes.ts` (RPC→HTTP/409/422/403/404/500 mapping, Persian messages, never expose RPC names/DB strings), `fulfilment-service.ts` (auth via `createServerSupabaseClient` + `isAdminRole`, trusted RPC via `createAdminSupabaseClient`, storage upload + DB-fail rollback, admin reads). `lib/storage/private-signed-url.ts` gained bucket param; `queries.ts` filters source media to `type='upload'`.
- **API routes:** `POST /api/admin/requests/[requestId]/final-media` (multipart ≤5 files), `PATCH /api/admin/requests/[requestId]/status` (JSON ≤8KiB), `PATCH /api/admin/requests/[requestId]/final-media/[assetId]` (JSON `{action:"approve"|"supersede"}` ≤512B). All `force-dynamic` + `nodejs`, admin-gated.
- **UI:** `components/admin/requests/`: `fulfilment-timeline` (server; history with Persian labels, internal + parent-visible note styling), `status-update-form` (client; allowed next statuses only, rejection reason required, `expectedUpdatedAt`), `final-media-upload` (client; upload/approve/supersede with `ConfirmDialog`, delivery badges, inline `<img>` lint suppression). Detail page wired with `loadAdminFinalMedia` + `loadAdminFulfilmentHistory`; queue page got status-dot legend + filter badges.
- **Tests:** `tests/unit/` request-workflow + final-media-validation + fulfilment-types + fulfilment-errors — **235/235 total unit pass**. `tests/e2e/admin-request-fulfilment-db.spec.ts` (11 guarded stateful) + `admin-request-fulfilment-ui.spec.ts` (10 guarded mocked-UI) written spec-only — blocked against main.
- **Verified:** `npx tsc --noEmit` clean for task files (only pre-existing errors in referral-dashboard.spec.ts / pricing-calculation.test.ts); lint 0 errors (29 pre-existing warnings); security greps clean (no SECRET_KEY/internal_note/file_url leaks in admin components).
- **Deferred/blocked:** migration push to main + stateful/mocked-UI e2e execution require approval / disposable target + dev server; parent tracking/download page is a future task reusing `get_parent_order_status_history` + `toParentFinalAssetInfo`.

## Testing
- **Unit tests:** 235/235 pass (pricing-calculation + guard + payment-simulation-policy + request-rpc-error + payment-rules + admin-requests + coupon-rules + admin-coupons + candy-purchase-read-model + request-workflow + final-media-validation + fulfilment-types + fulfilment-errors)
- **Lint:** 0 errors (29 pre-existing warnings)
- **Build:** `next build` succeeds
- **Read-only regression (main project):** 19/19 pass
- **Full stateful regression:** Requires disposable/local Supabase target — Docker unavailable, no disposable remote configured
- **Repeated flake validation:** PENDING — requires safe target
- **Coupon stateful e2e (25 cases) + Admin coupon stateful e2e (18 cases):** guarded, unexecuted — requires disposable/local target; guard verified to block against main
- **Admin coupons mocked UI e2e (40 cases) + billing mocked UI e2e (39 cases):** written; execute only with a dev server
- **Request-fulfilment e2e (11 stateful + 10 mocked-UI):** written spec-only; require disposable/local target + dev server
- **Pre-launch cleanup complete:** auth.users=2 (both admin), parent_profiles=0, wallets=0, referral_relationships=0, settings=enabled=true/1500, pricing=9 (unchanged), orders=0, children=0, coupons=0, coupon_package_rules=0, coupon_redemptions=0
- **Read-only validation confirmed:** zero database changes during validation run

## Known Debts
- `lib/candies/`, `lib/orders/`, `lib/payments/` (has `types.ts` + `rules.ts` only), `lib/stripe/`, `lib/validators/` — no business logic yet
- `tests/unit/`, `tests/integration/` — mostly empty (pricing-calculation + guard + payment-policy + payment-rules + admin-requests + coupon-rules + admin-coupons tests exist)
- `ARCHITECTURE.md`, `FEATURES.md`, `ROADMAP.md` have drifted from implementation
- `db/schema.sql` manually updated (not auto-generated)
- Docker unavailable — cannot run local Supabase for stateful Playwright tests
- No disposable remote Supabase project configured for repeated flake validation
- Stateful coupon e2e (foundation + admin) unexecuted until a safe target exists; redemption `reserved → redeemed` promotion deferred to the payment-verified task
- Zero-final-price (free) purchase completion flow does not exist yet — blocked in the UI with a deferred notice until a trusted free-confirmation flow is added
