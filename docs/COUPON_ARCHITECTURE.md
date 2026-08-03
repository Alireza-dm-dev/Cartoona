# Coupon Architecture

> Server-authoritative coupon system for candy-package purchases.
> Implemented: migration `20260801100000_coupon_foundation.sql` (Aug 1 2026).
> Admin management: migration `20260801110000_admin_coupon_management.sql` (Aug 1 2026).
> No real payment provider, no parent coupon-history UI, no refunds,
> no banners/campaigns, no browser writes, no coupon deletion, no new package
> prices, no seed coupons.

---

## Table of Contents

1. [Design Goals](#1-design-goals)
2. [Monetary Policy](#2-monetary-policy)
3. [Coupon Code Rules](#3-coupon-code-rules)
4. [Discount Rules](#4-discount-rules)
5. [Data Model](#5-data-model)
6. [Purchase Price Snapshots](#6-purchase-price-snapshots)
7. [RLS and Access Model](#7-rls-and-access-model)
8. [Trusted RPCs](#8-trusted-rpcs)
9. [API Routes](#9-api-routes)
10. [Redemption Lifecycle](#10-redemption-lifecycle)
11. [Usage Limits](#11-usage-limits)
12. [Package Eligibility](#12-package-eligibility)
13. [Idempotency](#13-idempotency)
14. [Payment-Attempt Compatibility](#14-payment-attempt-compatibility)
15. [Error Handling and Enumeration Protection](#15-error-handling-and-enumeration-protection)
16. [Admin Coupon Management](#16-admin-coupon-management)
17. [Testing](#17-testing)
18. [Explicitly Out of Scope](#18-explicitly-out-of-scope)

---

## 1. Design Goals

- **Server authority**: every coupon decision (validation, discount calculation,
  application) happens in the database via service-role-only trusted RPCs. The
  browser never computes discounts or supplies prices.
- **No coupon enumeration**: parents cannot query the coupon catalogue or
  distinguish "code exists but inactive" from "code does not exist".
- **One coupon per purchase**: enforced by `UNIQUE (purchase_id)` on
  `coupon_redemptions`. No stacking.
- **Explicit pricing snapshots**: a purchase stores original price, discount,
  and final payable amount. Payment providers charge the final amount.
- **Idempotent, atomic apply**: retrying with the same idempotency key returns
  the existing redemption; the purchase lock serializes concurrent applies.

## 2. Monetary Policy

All stored amounts are **integer RIAL (IRR)**. Do not convert, rename to
toman, or rescale — enforced by documentation and by integer-only helper logic.

- `candy_packages.price_amount` — original package price (IRR), the "snapshot"
- `candy_purchases.price_amount` — backward-compatible alias of the original
  package price at purchase time
- `candy_purchases.original_price_amount` — explicit pre-discount price
- `candy_purchases.discount_amount` — coupon discount applied (0 = none)
- `candy_purchases.final_price_amount` — payable amount after discount
- `coupon_redemptions.*` — the same amounts snapshotted at apply time

Invariant (database CHECK on `candy_purchases`):

```
original_price_amount = price_amount
AND original_price_amount - discount_amount = final_price_amount
```

Percentage discounts are expressed as **integer basis points**:
1000 bp = 10%, 10000 bp = 100%. `discount_value` for `percentage` is 1..10000.

## 3. Coupon Code Rules

| Rule | Value |
|---|---|
| Charset | Uppercase `A-Z`, `0-9`, `-`, `_` |
| Length | 3 to 32 chars |
| Normalization | Trim surrounding whitespace, then uppercase |
| Storage | Always stored normalized (`code = upper(trim(code))`) |
| Uniqueness | DB `UNIQUE` on `coupons.code` (case-insensitive by normalization) |
| No spaces / Persian digits / wildcards | Enforced by DB CHECK regex `^[A-Z0-9_-]{3,32}$` |

The TS helpers live in `lib/coupons/rules.ts` (`normalizeCouponCode`,
`isValidCouponCode`, `isValidRawCouponCode`). The RPCs re-validate the
normalized code server-side; the API routes reject malformed codes before
calling the RPC.

## 4. Discount Rules

`calculate_coupon_discount(p_discount_type, p_discount_value, p_original_price, p_maximum_discount_amount)`
is a pure `IMMUTABLE` SQL function (mirrored in TS by `calculateCouponDiscount`):

```
percentage: discount = floor(original * basis_points / 10000)
            then cap by maximum_discount_amount when present
fixed:      discount = min(discount_value, original)
            then cap by maximum_discount_amount when present
final:      original - discount  (never negative)
```

- Integer division (floor), no floating point anywhere.
- If the computed discount is `<= 0` the code is rejected
  (`coupon_zero_discount`) — a coupon must never zero-value a coupon silently.
- A fixed coupon larger than the price clamps to the price (final = 0).
- A 100% percentage coupon (10000 bp) yields final = 0, which is allowed.
- `minimum_purchase_amount` is checked against the ORIGINAL price **before**
  discount.

## 5. Data Model

### `coupons`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `code` | TEXT | normalized, unique |
| `name` | TEXT | non-empty |
| `description` | TEXT | |
| `discount_type` | TEXT | `percentage` \| `fixed_amount` |
| `discount_value` | INTEGER | bp for percentage, IRR for fixed |
| `is_active` | BOOLEAN | admin toggle |
| `starts_at` / `expires_at` | TIMESTAMPTZ | date window (`expires_at > starts_at`) |
| `global_usage_limit` | INTEGER | NULL = unlimited |
| `per_parent_usage_limit` | INTEGER | NULL = unlimited |
| `minimum_purchase_amount` | INTEGER | NULL = none |
| `maximum_discount_amount` | INTEGER | NULL = no cap |
| `created_by_user_id` | UUID → users | admin who created it, SET NULL |
| timestamps | | `updated_at` via `set_updated_at()` |

### `coupon_package_rules`

Zero rows for a coupon ⇒ applies to **all** active packages. One or more rows
⇒ applies **only** to those packages. Stores package IDs only — never
duplicated price/candy amounts. Both FKs `ON DELETE CASCADE`.

### `coupon_redemptions`

One row per coupon applied to a purchase. Full snapshot of the applied
discount at apply time. `status` = `reserved` | `redeemed` | `cancelled`.
`UNIQUE (purchase_id)` (one coupon per purchase) and
`UNIQUE (purchase_id, idempotency_key)` (idempotent apply).

## 6. Purchase Price Snapshots

`candy_purchases` gained (migration `20260801100000`):

- `original_price_amount` INTEGER NOT NULL (> 0)
- `discount_amount` INTEGER NOT NULL DEFAULT 0 (>= 0)
- `final_price_amount` INTEGER NOT NULL (>= 0)
- Invariant CHECK as in §2
- Safe backfill for non-empty environments:
  existing purchases get `original = final = price_amount`, `discount = 0`

`POST /api/candy-purchases` now writes the new snapshot columns at creation
(original = final = package price, discount = 0).

## 7. RLS and Access Model

| Table | RLS | Browser access |
|---|---|---|
| `coupons` | admin SELECT all (`is_admin_or_super_admin()`), no writes | no parent read/write |
| `coupon_package_rules` | admin SELECT all, no writes | no parent read/write |
| `coupon_redemptions` | parent SELECT own (`parent_profile_id = current_parent_profile_id()`), admin SELECT all, no writes | parents read only their own future history; no writes |

Grants: `SELECT` on the three tables to `authenticated` (policies decide
visibility). `REVOKE ALL` from `anon`/`authenticated` for writes.

## 8. Trusted RPCs

Both RPCs: `SECURITY DEFINER`, `SET search_path = ''`, all references
`public.*`-qualified, `REVOKE ALL FROM PUBLIC/anon/authenticated`,
`GRANT EXECUTE TO service_role`. Invoked by API routes through
`createAdminSupabaseClient()`.

### `validate_coupon_for_purchase_trusted(parent_profile_id, purchase_id, coupon_code)`

READ-ONLY. No lock, no writes, no redemptions created. Full validation:
input checks → normalize code → load purchase → ownership → status `pending` →
no payment attempt → no existing coupon → load coupon → active/dates →
limits (reserved+redeemed) → package eligibility → minimum amount → compute
discount → reject zero discount. Returns safe result.

### `apply_coupon_to_purchase_trusted(parent_profile_id, purchase_id, coupon_code, idempotency_key)`

ATOMIC. Locks the purchase `FOR UPDATE`, idempotency lookup
`(purchase_id, idempotency_key)` first, re-validates everything inside the
transaction, inserts the redemption (`status = 'reserved'`), updates
`candy_purchases.discount_amount`/`final_price_amount`, returns the applied
result. Never creates a payment attempt, never touches wallet/ledger.

The discount is computed by the trusted RPC using the pure helper — the
browser could not influence it even if it tried.

## 9. API Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/coupons/validate` | POST | Parent | Read-only validation → returns computed discount |
| `/api/candy-purchases/[id]/coupon` | POST | Parent | Atomic apply with idempotency key |

Both: JSON only, `MAX_BODY_BYTES = 1024`, unknown-field rejection, no
client-supplied parent/package/price values, `Cache-Control: no-store` +
`X-Content-Type-Options: nosniff`. Errors mapped through `mapCouponRpcError`.

- Validate body: `{ purchase_id, code }`
- Apply body: `{ code, idempotency_key }`

### Parent-facing response shapes (no internal IDs)

Both coupon endpoints return only safe, operational fields to the parent. The
trusted RPC results still carry `coupon_id` / `redemption_id` internally, but
the public serializers in `lib/coupons/types.ts` (`toCouponValidationResult`,
`toAppliedCouponResult`) deliberately drop them.

- Validate `200`:
  ```json
  { "coupon": { "normalizedCode": "WELCOME10", "discountType": "percentage",
    "originalPriceAmount": 50000, "discountAmount": 5000,
    "finalPriceAmount": 45000, "currency": "IRR" } }
  ```
- Apply `200`:
  ```json
  { "coupon": { "normalizedCode": "WELCOME10", "discountType": "percentage",
    "discountValue": 1000, "originalPriceAmount": 50000,
    "discountAmount": 5000, "finalPriceAmount": 45000,
    "currency": "IRR", "status": "reserved" } }
  ```

## 10. Redemption Lifecycle

```
reserved  → redeemed   (purchase paid + verified — deferred to a later task)
reserved  → cancelled  (purchase cancelled/expired; reservation released)
```

- Apply inserts `reserved`. Promotion to `redeemed` happens only after a
  verified payment (future).
- A cancelled/expired purchase's redemption can later be `cancelled` to
  release its usage-limit count. **No auto-release job in this task.**
- `redeemed` and `cancelled` are terminal here; `reserved` is transient.

## 11. Usage Limits

- `global_usage_limit` — count across all parents.
- `per_parent_usage_limit` — count per parent profile.
- Both count redemptions with `status IN ('reserved', 'redeemed')`.
  Cancelled redemptions release their count.
- Limits are enforced read-only in validation and re-checked under the
  purchase lock in apply.

## 12. Package Eligibility

- No `coupon_package_rules` rows for a coupon ⇒ valid for all active packages.
- Rows present ⇒ the purchase's `package_id` must be among them.

## 13. Idempotency

- `apply_coupon_to_purchase_trusted` is idempotent on
  `(purchase_id, idempotency_key)`: retrying returns the existing redemption.
- `idempotency_key` rules: 1..255 chars, must not be all digits (same policy
  as payment attempts), validated in `lib/coupons/rules.ts`
  (`isValidIdempotencyKey`).
- A DIFFERENT coupon on an already-discounted purchase is rejected
  (`coupon_already_applied`).

## 14. Payment-Attempt Compatibility

- Coupons must be applied **before** a payment attempt/session is created.
- Once `active_payment_attempt_id` is set on the purchase, both RPCs reject
  coupon validation/apply (`coupon_purchase_has_payment_attempt`).
- Payment attempts must charge `final_price_amount`, never `price_amount`.
  Helper: `payableAmountForPurchase()` in `lib/payments/rules.ts`.
- Server-side guard: `canApplyCouponToPurchase()` in `lib/payments/rules.ts`
  (purchase status `pending` AND no active attempt).
- When a coupon is applied, the pending purchase's `final_price_amount`
  reflects the discounted price; provider verification must compare against
  `final_price_amount`.

## 15. Error Handling and Enumeration Protection

RPC errors are raised via `RAISE EXCEPTION '<code>' USING HINT = '<hint>'`.
The API maps the code through `mapCouponRpcError` to a safe Persian message.

Enumeration protection: unknown, inactive, not-started, and expired codes all
return the same non-enumerating message:
«این کد تخفیف معتبر نیست.» (404). Raw database strings and hints are never
exposed to the client.

## 16. Admin Coupon Management

Implemented by migration `20260801110000_admin_coupon_management.sql`.
Admins create and update coupons through the browser. The browser never writes
to the coupon tables directly (RLS is SELECT-only); all mutations go through
service-role-only trusted RPCs that re-verify the admin role server-side.

### Admin boundary

- **Auth:** `requireAdminCouponsAuth()` — server supabase client + `getUser()` +
  `users.role` via `isAdminRole()` (admin/super_admin). 401 unauth, 403 non-admin.
- **Admin pages** (`/admin/coupons`, `/admin/coupons/new`, `/admin/coupons/[couponId]`)
  live inside the existing admin layout that already enforces the role; per-page
  data loads use the server supabase client. Admin routes do NOT run the parent
  session-lifetime check.
- **API routes** (`/api/admin/coupons`, `/api/admin/coupons/[id]`): JSON-only,
  body-size capped at 4096 bytes, `Cache-Control: no-store` +
  `X-Content-Type-Options: nosniff`, `NO DELETE` endpoint.

### Trusted RPCs (Part 3)

- `public.is_admin_user_id(UUID)` — `SECURITY DEFINER`, service_role-only,
  verifies the passed user id has an admin role. Does not read `auth.uid()`.
- `create_coupon_trusted(...)` / `update_coupon_trusted(...)` — both
  `SECURITY DEFINER SET search_path=''`, public-qualified, service_role-only
  EXECUTE. Re-verify admin role via the helper, normalize the code in-database,
  and mutate ONLY coupon tables (never wallet/purchase/payment/redemption).
- Create inserts coupon + package rules atomically.
- Update locks the row `FOR UPDATE`, requires an exact `expectedUpdatedAt`
  (optimistic concurrency) else raises `coupon_admin_conflict` (→ 409), and
  returns `(coupon_id, code)`.

### Update policy

| Field | Before any usage | After reserved/redeemed redemptions |
|---|---|---|
| code | mutable | immutable |
| discount_type / discount_value | mutable | immutable (raises `coupon_admin_immutable_discount`, 409) |
| is_active, dates, name, description | mutable | mutable |
| usage limits | mutable (must stay ≥ current usage, else `coupon_admin_usage_limit_conflict`, 409) | same |
| package rules | mutable | mutable (redemptions keep their snapshots; the UI confirms) |

### Status derivation (never stored)

`deriveCouponStatus(isActive, startsAt, expiresAt)` in `lib/admin/coupons/status.ts`:

```
inactive   — is_active = false (admin toggle takes priority)
scheduled  — active and starts_at in the future
expired    — active and expires_at passed (strict after)
active     — active, started, not expired
```

### Usage counts

Derived from `coupon_redemptions`: `reservedCount`, `redeemedCount`,
`cancelledCount`. Limits count reserved+redeemed; cancelled releases its count.
List/detail responses never include redemption IDs or parent identities.

### Files

- `lib/admin/coupons/{types,status,validation,queries,service,errors,format,use-admin-coupons}.ts`
- `app/api/admin/coupons/route.ts` (GET/POST), `app/api/admin/coupons/[id]/route.ts` (GET/PATCH)
- `app/admin/coupons/{page.tsx,new/page.tsx,[couponId]/page.tsx}`
- `components/admin/coupons/{coupon-form.tsx,coupon-status-badge.tsx,confirm-dialog.tsx}`
- `lib/supabase/admin.ts` — `createAdminSupabaseClient()` (service-role)

## 17. Parent Billing Integration (read model)

`GET /api/candy-purchases` returns the parent-facing billing summary with safe,
server-derived coupon and payment fields. The browser never receives internal
IDs (`coupon_id`, `redemption_id`, `payment_attempt_id`, provider session or
transaction IDs, `parent_id`, `wallet_id`) or raw database fields.

Per-purchase fields (`lib/candy-purchases/types.ts` →
`ParentCandyPurchaseSummary`):

| Field | Source | Notes |
|---|---|---|
| `originalPriceAmount` / `discountAmount` / `finalPriceAmount` | `candy_purchases` snapshot columns | Always present, integer IRR |
| `couponApplied` | `coupon_redemptions` row with status `reserved`/`redeemed` | **Not** derived from `discountAmount > 0` (a valid coupon may round to zero discount) |
| `couponCodeSnapshot` | `coupon_redemptions.normalized_code_snapshot` | Historical, survives later coupon edits/deactivation |
| `couponName` | `coupons.name` via a limited service-role lookup | Only the display name; never internal config |
| `couponStatus` | `coupon_redemptions.status` | `reserved` / `redeemed` / `cancelled` / `null` |
| `paymentStarted` | existence of any `payment_attempts` row | boolean only; attempt details never returned |
| `status` | `candy_purchases.status` | includes `expired` |

`toParentCandyPurchaseSummary(row, packageName)` is the single serializer; unit
tests in `tests/unit/candy-purchase-read-model.test.ts` lock down the safe
surface (no internal IDs, zero-discount coupon still `couponApplied`, `expired`
mapping, `paymentStarted` boolean).

### Pending-purchase coupon UI

`components/dashboard/billing/pending-purchase-card.tsx` renders each pending
purchase with a coupon entry:

- Validate (read-only `POST /api/coupons/validate`) → live preview of
  original / discount / final amounts.
- Apply (`POST /api/candy-purchases/[id]/coupon`) with a **single stable
  idempotency key per apply action**, reused across retries (never a bare
  timestamp). After success the parent re-fetches the billing read model.
- Applied state is locked: «برای هر خرید فقط یک کد تخفیف قابل استفاده است.»
- `paymentStarted === true` hides the coupon input (payment already began).
- Non-`pending`/`expired` purchases never render coupon controls.
- Zero-final-price purchase shows the deferred-completion notice instead of any
  payment/completion action (free confirmation flow is out of scope).

### Client error mapping

The parent UI never re-derives messages. It renders the `message` already
produced by `mapCouponRpcError` on the server (single source of truth). The
enumeration-protection message «این کد تخفیف معتبر نیست.» is shared by
not-found / inactive / not-started / expired codes, exactly as in section 15.

## 18. Testing

- Pure unit tests: `tests/unit/coupon-rules.test.ts` (142 tests) — code
  normalization, discount math (floor, cap, clamp, never-negative), minimum
  amount, date window, idempotency keys, error mapping (incl. the
  non-enumerating message), public serialization (no internal IDs), integer-only
  IRR, and payment-attempt compatibility.
- Pure unit tests: `tests/unit/candy-purchase-read-model.test.ts` (8 tests) —
  parent billing read-model serializer: pricing snapshots, coupon snapshots,
  `couponApplied` from the authoritative redemption (incl. zero-discount),
  `paymentStarted` boolean, `expired` mapping, and exclusion of every internal ID
  from the serialized JSON. Safe to run anywhere (no database).
- Pure unit tests: `tests/unit/admin-coupons.test.ts` (33 tests) — status
  derivation, fa-IR formatting, list param parsing, input validation, and
  admin RPC error mapping. Safe to run anywhere (no database).
- Guarded stateful tests: `tests/e2e/coupon-api.spec.ts` — blocked by
  `assertSafeDatabaseTarget()` against the main project; designed for a
  disposable/local target only. Covers enumeration protection, no browser
  writes, RPC privilege denial, validation/apply behavior, limits, package
  rules, inactive/not-started/expired, clamping, unknown-field rejection, and
  auth rejection.
- Guarded stateful Admin API tests: `tests/e2e/admin-coupons-api.spec.ts`
  (18 scenarios) — creates real coupons via the Admin API on a disposable/local
  target only. Covers auth guard (401/403), create, duplicate-code 409, field
  validation 422, list filters + pagination cap, detail, update + optimistic
  concurrency 409, scheduled status, package rules, invalid package, public-role
  RPC denial, and no-redemption-id leakage. **Status: guarded, unexecuted.**
- Mocked UI tests: `tests/e2e/admin-coupons-dashboard.spec.ts` (40 scenarios)
  — uses `page.route` to mock `/api/admin/coupons*`; creates only a synthetic
  admin Auth user (cleaned up). No coupon rows are ever created on any target.
  Covers list table/cards, filters, pagination, empty/filtered-empty/error
  states, create form validation + normalize + submit, edit prefill,
  immutable fields for used coupons, expectedUpdatedAt on PATCH, the confirm
  dialog (deactivate/limit/package), conflict message, and field-error render.
- Migration state after this task: 30/30 (was 29/29).

## 19. Explicitly Out of Scope

- Parent coupon-history UI (RLS already allows parent to read own
  redemptions, but no UI exists)
- Parent checkout coupon input (the apply/validate RPCs exist; the billing
  page does not yet expose a coupon field)
- Bale payment and verified redemption promotion
- Referral auto-rewards
- Refunds, banners, campaigns
- Browser writes to coupon tables (forbidden by RLS)
- Coupon deletion (only toggle `is_active`; no DELETE endpoint)
- Free-candy / first-order / geographic restrictions, coupon stacking
- New package prices or changes to existing prices
- Promotion of redemptions to `redeemed` (deferred to the payment-verified
  task)
