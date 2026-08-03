# Payment Provider Architecture

> Planning document for real online payment integration.
> No provider selected. No payment SDK installed. No database changes applied.
> This document describes what must be built, in what order, and with what safety properties.

---

## Table of Contents

1. [Current Foundation](#1-current-foundation)
2. [Business Payment Lifecycle](#2-business-payment-lifecycle)
3. [Recommended Status Model](#3-recommended-status-model)
4. [Provider Adapter Design](#4-provider-adapter-design)
5. [Required Database Additions](#5-required-database-additions)
6. [Payment-Attempt Model Decision](#6-payment-attempt-model-decision)
7. [Idempotency Strategy](#7-idempotency-strategy)
8. [Amount/Currency Authority](#8-amountcurrency-authority)
9. [Rial/Toman Decision Requirement](#9-rialtoman-decision-requirement)
10. [Webhook Security](#10-webhook-security)
11. [Redirect UX](#11-redirect-ux)
12. [Reconciliation](#12-reconciliation)
13. [Refund Deferral](#13-refund-deferral)
14. [Admin Requirements](#14-admin-requirements)
15. [Environment/Secrets](#15-environmentsecrets)
16. [Testing Strategy](#16-testing-strategy)
17. [Security Blockers](#17-security-blockers)
18. [Implementation Roadmap](#18-implementation-roadmap)

---

## 1. Current Foundation

### 1.1 Tables Created (migration `20260729100000`)

**`candy_packages`** — read-only catalog with 3 seed rows (استارتر 100/50000, رشد 300/135000, ممتاز 700/280000 IRR). RLS: authenticated users see active packages only. Admins see all. No client INSERT/UPDATE/DELETE.

**`candy_purchases`** — per-purchase record with `id`, `parent_id`, `package_id`, `candy_amount`, `price_amount`, `currency`, `status`, `payment_reference`, `created_at`, `updated_at`, `paid_at`. Since `20260801100000` it also stores explicit pricing snapshots `original_price_amount`, `discount_amount`, `final_price_amount` (invariant: `original = price_amount` and `original − discount = final`; see `docs/COUPON_ARCHITECTURE.md`). Statuses: `pending`, `paid`, `failed`, `cancelled`. RLS: parent sees own purchases only. No direct client writes — only via API route.

**`candy_wallets`** (from `20260726100000`) — one wallet per parent. RLS: parent sees own. Writes only via SECURITY DEFINER RPCs.

**`candy_transactions`** (from `20260726100000`) — append-only ledger. Immutable trigger. Partial unique index on `idempotency_key`. RLS: parent sees own.

### 1.2 API Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/candy-packages` | GET | Public (via Supabase client — 401 without cookie) | Active packages |
| `/api/candy-purchases` | GET | Parent | Wallet + purchase history |
| `/api/candy-purchases` | POST | Parent | Create pending purchase |
| `/api/candy-purchases/[id]/complete` | POST | Parent | Dev-only simulated completion |

### 1.3 Current Purchase Lifecycle

```
[Select Package] → POST /api/candy-purchases({ package_id })
                   → Server snapshots price/candy/currency from candy_packages
                   → INSERT candy_purchases (status='pending')
                   → Returns purchase ID

[Dev Only] → POST /api/candy-purchases/[id]/complete
            → API route checks NODE_ENV !== "production"
            → Calls complete_candy_purchase RPC:
              1. auth.uid() check
              2. parent role check
              3. Resolve parent_id from parent_profiles
              4. FOR UPDATE lock purchase row
              5. Verify ownership (parent_id match)
              6. Verify status='pending'
              7. UPDATE purchase → 'paid', paid_at=now()
              8. FOR UPDATE lock wallet
              9. UPDATE wallet balance += candy_amount
              10. INSERT ledger entry (type='purchase', idempotency_key='purchase_credit:<id>')
              11. Return purchase state
```

### 1.4 Current Financial Authority Boundaries

- **Server-side money decisions**: Package price snapshot, wallet credit, ledger insert
- **Provider interaction**: None (zero provider code exists)
- **Secrets**: `SUPABASE_SECRET_KEY` (service role) in `lib/supabase/admin.ts`

### 1.5 Current Idempotency Protection

- `candy_transactions.idempotency_key` with `UNIQUE` partial index (non-null only)
- Key format: `purchase_credit:<purchase_id>`
- RPC handles idempotent return: if already `paid` with existing ledger entry, returns current state without re-crediting

### 1.6 Current Gaps Preventing Real Payment Integration

| # | Gap | Impact |
|---|---|---|
| G1 | No provider session storage | Cannot track active checkout |
| G2 | No webhook endpoint | Provider cannot confirm payment |
| G3 | No server-to-server verification | Browser redirect alone could trigger credit |
| G4 | `complete_candy_purchase` GRANTed to `authenticated` | Direct Supabase REST call bypasses API route guard |
| G5 | RPC has no environment check | Knows it is dev-only only through COMMENT |
| G6 | No payment_provider field | Cannot distinguish providers |
| G7 | No provider_session_id or provider_transaction_id | Cannot reconcile provider data |
| G8 | No status for "awaiting provider" | No `awaiting_payment`, `processing`, `verification_pending` |
| G9 | No failed_at, cancelled_at, expired_at | Cannot track timing |
| G10 | No payment_attempt_count | Cannot throttle retries |
| G11 | No checkout_url field | Cannot store provider redirect URL |
| G12 | No provider_verified_at | Cannot audit server-to-server verification |
| G13 | Rial/toman ambiguity | `price_amount` documented as "Rials" but some UI plans show "تومان" |
| G14 | No reconciliation job | Pending purchases remain pending forever |
| G15 | No admin payment view | Cannot investigate payment issues |

### 1.7 Assumptions Tied to Development Simulation

- The RPC COMMENT says `[DEVELOPMENT-ONLY]` but the RPC logic does not enforce it
- The API route's `NODE_ENV === "production"` guard is the only production block
- `payment_reference` is an arbitrary string, not a verified provider reference
- No provider SDK is needed yet

---

## 2. Business Payment Lifecycle

### 2.1 Intended Lifecycle

```
                                                      Provider
                                                      ════════
                                                        │
  1. Select Package                                     │
     │                                                  │
     ▼                                                  │
  2. POST /api/candy-purchases                          │
     → Create pending purchase                          │
     → Snapshop price/candy/currency                    │
     │                                                  │
     ▼                                                  │
  3. POST /api/candy-purchases/[id]/pay                 │
     → Call provider adapter                            │
     → Provider: createPaymentSession()                 │
     │                                                  │
     ▼                                                  │
  4. Receive from provider:                             │
     • checkout_url (redirect browser)                  │
     • provider_session_id                              │
     │                                                  │
     ▼                                                  │
  5. Save checkout_url + provider_session_id             │
     → status = 'awaiting_payment'                      │
     │                                                  │
     ▼                                                  │
  6. 302 Redirect browser → provider checkout_url       │
     │                                                  │
  ╔══════════════════════════════════════╗              │
  ║  BROWSER LEAVES CARTOONA            ║              │
  ║  (No trust in browser after this)   ║              │
  ╚══════════════════════════════════════╝              │
     │                                                  │
     │                                          Provider processes payment
     │                                                  │
     │                                     ╔══════════════════════════════╗
     │                                     ║  PROVIDER WEBHOOK           ║
     │                                     ║  POST /api/payments/        ║
     │                                     ║       webhooks/[provider]   ║
     │                                     ║  • Verify signature         ║
     │                                     ║  • Parse event              ║
     │                                     ║  • Idempotency check        ║
     │                                     ║  • Lookup purchase          ║
     │                                     ║  • Server-to-server verify  ║
     │                                     ║  • Amount match             ║
     │                                     ║  • Currency match           ║
     │                                     ║  • Mark paid                ║
     │                                     ║  • Credit wallet            ║
     │                                     ║  • Insert ledger entry      ║
     │                                     ║  • Acknowledge (200)        ║
     │                                     ╚══════════════════════════════╝
     │                                                  │
     ▼                                                  │
  7. Provider redirects browser back                     │
     → /payments/return?purchase_id=X                    │
     → Page polls internal status                        │
     → Page shows current status (paid/pending/failed)   │
     │                                                  │
     ▼                                                  │
  8. Browser sees final status                           │
     → "پرداخت موفق" or "پرداخت ناموفق"                 │
```

### 2.2 Key Boundaries

| Boundary | Trust | Action |
|---|---|---|
| Browser redirect | NEVER trusted to mark paid | Polls only, no mutation |
| Provider webhook | TRUSTED after signature verify | Marks purchase paid |
| Server-to-server verify | TRUSTED (from webhook or callback) | Double-check before wallet credit |
| Internal purchase completion | SERVER-ONLY (via RPC with service_role) | Final wallet credit |

### 2.3 Rule

> The browser redirect must never be enough to credit candies.
> Only the server-side webhook + verification flow may credit a wallet.

---

## 3. Recommended Status Model

### 3.1 Current Statuses

```
pending → paid | failed | cancelled | expired
```

### 3.2 Implemented (July 31) Status Split — Purchase vs Attempt

**Purchase-level statuses** (business set only; transient provider states do NOT appear on the purchase):

```
pending → paid | failed | cancelled | expired
```

| Purchase status | Meaning | Set By | Wallet Credit | Retry | New Purchase |
|---|---|---|---|---|---|
| `pending` | Purchase created, no active session / retry allowed | API route | No | Yes | No (this purchase is active) |
| `paid` | Payment verified, wallet credited | Trusted server (after verification) | Yes | No | Yes |
| `failed` | Entire purchase marked failed | Trusted server | No | Yes | Yes |
| `cancelled` | Parent cancelled before completing | API route (user action) | No | No | Yes |
| `expired` | Checkout session expired without payment | Trusted server / expiry job | No | Yes | Yes |

**Attempt-level statuses** (on `payment_attempts`, per retry):

```
created → awaiting_payment → processing → verified | failed | cancelled | expired
```

Transient provider states (`awaiting_payment`, `processing`, `verified`) live on the
attempt, never on the purchase. `paid`/`cancelled` purchases are terminal; `failed` and
`expired` purchases may accept a new attempt.

### 3.3 Purchase Status Transition Rules

```
pending → paid          (payment verified, wallet credited)
pending → failed        (payment declined or provider error)
pending → cancelled     (parent cancels)
pending → expired       (checkout session expired without payment)
failed  → pending       (new attempt created)
expired → pending       (new attempt created)
paid    → (terminal)
cancelled → (terminal)
```

### 3.4 Deferred Statuses (Post-MVP)

- `refunded` — after refund implementation
- `partially_refunded` — if partial refunds are supported

### 3.5 Rationale

- Transient provider states on the attempt, not the purchase — the purchase expresses
  business truth; the attempt expresses provider progress.
- `expired` is included in the foundation (rather than deferred) because checkout
  expiry must be visible to the parent for retry decisions.

---

## 4. Provider Adapter Design

### 4.1 Interface

```typescript
// lib/payments/provider.ts — no provider SDK imports

export interface PaymentProvider {
  /** Create a payment session and return checkout URL */
  createPaymentSession(
    input: CreatePaymentSessionInput
  ): Promise<CreatePaymentSessionResult>

  /** Verify payment status directly with provider (server-to-server) */
  verifyPayment(
    input: VerifyPaymentInput
  ): Promise<VerifyPaymentResult>

  /** Parse and validate an incoming webhook event */
  parseWebhook(
    input: ParseWebhookInput
  ): Promise<PaymentWebhookEvent>

  /** Request a refund (post-MVP) */
  refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentResult>
}
```

### 4.2 Provider-Neutral Types

```typescript
// lib/payments/types.ts

export interface CreatePaymentSessionInput {
  purchaseId: string
  amount: number         // In smallest currency unit
  currency: string       // ISO 4217
  description: string
  callbackUrl: string    // Cartoona return URL
  webhookUrl: string     // Cartoona webhook URL
}

export interface CreatePaymentSessionResult {
  checkoutUrl: string
  providerSessionId: string
  expiresAt: string | null
}

export interface VerifyPaymentInput {
  providerSessionId: string
  providerTransactionId?: string
}

export interface VerifyPaymentResult {
  status: ProviderPaymentStatus
  providerTransactionId: string | null
  paidAmount: number | null
  paidCurrency: string | null
  payerId: string | null       // Provider account identifier
  verifiedAt: string
}

export type ProviderPaymentStatus =
  | "paid"
  | "pending"
  | "failed"
  | "refunded"
  | "expired"

export interface ParseWebhookInput {
  body: string        // Raw body
  headers: Record<string, string>
  signature?: string
}

export interface PaymentWebhookEvent {
  eventId: string
  eventType: string
  providerSessionId: string
  providerTransactionId: string | null
  amount: number | null
  currency: string | null
  status: ProviderPaymentStatus
  rawEvent: Record<string, unknown>  // For audit only, not for business logic
}

export interface RefundPaymentInput {
  providerTransactionId: string
  amount: number        // Full or partial in smallest unit
  reason: string
}

export interface RefundPaymentResult {
  providerRefundId: string
  status: "refunded" | "partial_refunded" | "rejected"
}
```

### 4.3 Adapter Registration

```typescript
// lib/payments/registry.ts
// Maps provider name → adapter implementation

import type { PaymentProvider } from "./provider"

const registry = new Map<string, () => PaymentProvider>()

export function registerProvider(name: string, factory: () => PaymentProvider): void {
  registry.set(name, factory)
}

export function getProvider(name: string): PaymentProvider {
  const factory = registry.get(name)
  if (!factory) throw new Error(`Payment provider "${name}" not registered`)
  return factory()
}
```

### 4.4 Design Rules

- Page components import only `lib/payments/types.ts`, never provider-specific types
- API routes call `getProvider("name")` — no direct SDK calls
- Database stores only `payment_provider` (text name), `provider_session_id`, `provider_transaction_id`
- Secrets stay in server-only environment variables
- Provider replacement means writing a new adapter and changing the registered name — wallet/ledger logic is untouched

---

## 5. Required Database Additions

### 5.1 A. Implemented (migration `20260731110000`)

Provider-specific session/transaction/checkout state is **not** on the purchase — it
lives on `payment_attempts` (see §6). Only true purchase-level fields were added to
`candy_purchases`:

| Column | Type | Purpose |
|---|---|---|
| `active_payment_attempt_id` | `UUID` | FK → payment_attempts (ON DELETE SET NULL) — pointer to current attempt |
| `payment_provider` | `TEXT` | Provider engaged for the current attempt |
| `provider_verified_at` | `TIMESTAMPTZ` | When server-to-server verification completed |
| `expires_at` | `TIMESTAMPTZ` | When the current checkout expires |
| `cancelled_at` | `TIMESTAMPTZ` | When the parent cancelled |
| `failed_at` | `TIMESTAMPTZ` | When the entire purchase was marked failed |

### 5.2 B. Useful Later

- `provider_metadata` (`JSONB`) — provider-specific non-sensitive data for support
- `refund_status` — when refunds are implemented
- `refund_amount` — when partial refunds are supported

### 5.3 C. Must Never Store

- Card numbers, CVV, PAN
- Raw provider secrets, API keys, tokens
- Full raw webhook payloads
- Authentication tokens or session cookies

### 5.4 Status Constraint (implemented)

The purchase-level status is the business set only — transient provider states live on
`payment_attempts`:

```sql
CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'expired'))
```

---

## 6. Payment-Attempt Model Decision

### 6.1 Decision (July 31, Implemented): Separate `payment_attempts` Table

**Adopted.** A separate `payment_attempts` table is the foundation model (migration
`20260731110000_provider_neutral_payment_foundation.sql`). This supersedes the earlier
flat `payment_attempt_count` recommendation in this section. A purchase is a business
purchase that may be retried; every attempt to pay it is a `payment_attempts` row.

### 6.2 Why a separate table (supersedes the earlier flat-count recommendation)

| Concern | Decision |
|---|---|
| User retries after failed | New `payment_attempts` row (next `attempt_number`), same purchase |
| Expired provider session | Attempt → `expired`; user can retry same purchase (purchase stays retryable) |
| Provider switching during retry | Supported naturally — provider is per-attempt, not per-purchase |
| Auditability | Full per-attempt session/transaction/verification/failure history |
| Duplicate callbacks | `payment_webhook_events` dedup + ledger `purchase_credit:` idempotency |
| Refunds | Apply against the single purchase; attempt history preserved |
| Support investigations | Per-attempt provider response history is available |

### 6.3 Implemented `payment_attempts` Fields

| Column | Purpose |
|---|---|
| `id` | PK |
| `purchase_id` | FK → candy_purchases (ON DELETE CASCADE) |
| `provider` | Provider-neutral name (e.g. `zarinpal`, `nextpay`) |
| `status` | `created → awaiting_payment → processing → verified \| failed \| cancelled \| expired` |
| `provider_session_id` | Provider checkout/session reference (unique per provider) |
| `provider_transaction_id` | Provider transaction reference (unique per provider) |
| `provider_payment_reference` | Provider-issued payment reference (authority/invoice) |
| `checkout_url`, `checkout_expires_at` | Provider redirect for this attempt |
| `requested_amount`, `requested_currency` | Copied from purchase snapshot (never caller input); integer Rial |
| `verified_amount`, `verified_currency`, `provider_verified_at` | Set by server-side verification |
| `failure_code`, `failure_message_safe` | Safe failure info (never raw payloads) |
| `attempt_number` | 1-based ordinal, unique per purchase |
| `idempotency_key` | Attempt-creation idempotency, unique per purchase |
| `created_at`, `updated_at`, `completed_at` | Timestamps |

Key constraints: `payment_attempts_purchase_attempt_unique` (purchase_id, attempt_number),
`payment_attempts_purchase_idempotency_unique` (purchase_id, idempotency_key), partial
unique `(provider, provider_session_id)` / `(provider, provider_transaction_id)`,
and `idx_payment_attempts_verified_once` (at most one verified attempt per purchase).

### 6.4 `payment_webhook_events` (implemented)

Provider webhook dedup table. `UNIQUE(provider, provider_event_id)` checked BEFORE any
financial mutation. `processing_status` = `received → processed | ignored | failed`.
Never stores raw payloads, signatures, secrets, or card data. No browser access at all
(no policies; verified no anon/authenticated grants).

### 6.5 Access Model (implemented)

- Parents: SELECT attempts of their own purchases only (RLS via candy_purchases →
  parent_profiles → `auth.uid()`).
- Admin/super_admin: SELECT all attempts (read-only). No browser writes.
- Writes happen only through trusted service-role-only RPCs:
  `create_payment_attempt_trusted(...)` and `record_payment_attempt_session_trusted(...)`
  (SECURITY DEFINER, `search_path=''`, EXECUTE granted only to `service_role`).

---

## 7. Idempotency Strategy

### 7.1 Layer-by-Layer

| Layer | Key | Mechanism |
|---|---|---|
| 1. Create purchase | Client-generated `idempotency_key` (optional) | `UNIQUE` constraint on insert with key |
| 2. Create provider session | `provider_session_id` unique per purchase | DB constraint or idempotent provider API call |
| 3. Process webhook | `provider_event_id` | Store processed event IDs, reject duplicates |
| 4. Verify provider payment | `provider_transaction_id` | DB lookup before marking paid |
| 5. Mark purchase paid | `status` check + `FOR UPDATE` lock | Atomic: only `pending`/`awaiting_payment` → `paid` |
| 6. Credit wallet | `purchase_credit:<purchase_id>` | Existing partial unique index on `candy_transactions.idempotency_key` |
| 7. Retry failed callback | Event ID dedup + idempotent RPC | Same event → same result, no double-credit |

### 7.2 Existing Protection Confirmed

```
purchase_credit:<purchase_id>
```

This remains the final wallet-credit protection. The `complete_candy_purchase` RPC shows the correct pattern:
1. Check if already paid
2. Look up existing ledger entry by `idempotency_key`
3. If found, return current state without re-crediting
4. If not found, proceed with credit

### 7.3 Gaps

- No client-side idempotency key for `POST /api/candy-purchases` — duplicate requests could create multiple pending purchases
- No dedup table for webhook events — duplicate webhooks could trigger multiple verifications (though idempotent wallet credit prevents double-pay)

Add a `processed_webhook_events` table:

```sql
CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
  id TEXT PRIMARY KEY,  -- Provider event ID
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Or use a simpler approach: store the provider event ID in `candy_purchases.provider_metadata` as JSONB and check before processing.

---

## 8. Amount/Currency Authority

### 8.1 Source of Truth

| Field | Source | When Set | Who Sets |
|---|---|---|---|
| Package candy amount | `candy_packages.candy_amount` | At purchase creation | Server (API route) |
| Package price (original) | `candy_packages.price_amount` | At purchase creation | Server (API route) |
| Original price snapshot | `candy_purchases.original_price_amount` | At purchase creation | Server (API route) |
| Coupon discount | `candy_purchases.discount_amount` | At coupon apply | Trusted coupon RPC |
| Final payable amount | `candy_purchases.final_price_amount` | At creation (= original), then coupon apply | Server + trusted coupon RPC |
| Currency | `candy_packages.currency` | At purchase creation | Server (API route) |
| Provider charge amount | Purchase `final_price_amount` snapshot | At provider session creation | Server (uses `candy_purchases.final_price_amount`) |
| Wallet credit amount | Purchase snapshot | At payment completion | RPC (uses `candy_purchases.candy_amount`) |

### 8.2 Policy

1. **Browser sends only package ID.** No price, no currency, no candy amount.
2. **Server snapshots** `candy_amount`, `price_amount`, `original_price_amount`, `discount_amount`, `final_price_amount`, `currency` at purchase creation time. `price_amount` equals `original_price_amount` (pre-discount snapshot).
3. **Coupon apply** happens only while the purchase is `pending` and has no payment attempt. The trusted coupon RPC updates `discount_amount`/`final_price_amount` atomically.
4. **Provider request** uses `candy_purchases.final_price_amount` (the payable snapshot, not `price_amount`). Never charge the pre-discount price.
5. **Webhook verification** compares `paid_amount` and `paid_currency` from provider with `candy_purchases.final_price_amount` and `candy_purchases.currency`. Mismatch → reject and flag for admin review.
6. **Wallet credit** uses `candy_purchases.candy_amount` (the snapshot, not the current package price).
7. **Later package price change** does not alter existing purchases. Each purchase has its own immutable snapshot.
8. **Once a payment attempt exists** (`active_payment_attempt_id` set), coupon validation/apply is rejected (`coupon_purchase_has_payment_attempt`) — a provider session must never carry a stale price.

### 8.3 Current Schema Audit

The current `candy_purchases` already stores `candy_amount`, `price_amount`, `currency` as snapshots. The `POST /api/candy-purchases` route already reads from `candy_packages` and inserts the snapshot. **This satisfies the policy.** No schema change needed for amount authority.

### 8.4 Missing Check

The webhook handler must verify `paid_amount === candy_purchases.final_price_amount` and `paid_currency === candy_purchases.currency`. This check does not exist yet (no webhook handler exists). The comparison must use `final_price_amount` (the payable amount after any coupon discount), not `price_amount`.

### 8.5 Zero-Final-Price (Free) Purchases

A valid coupon can reduce `final_price_amount` to `0` (100% percentage coupon, or a
fixed discount ≥ the original price). The current foundation has **no trusted
free-completion flow**: the dev-only completion route is simulated, and
redemption `reserved → redeemed` promotion is deferred. Therefore:

- The parent billing UI detects `final_price_amount === 0` on an applied coupon
  and shows the deferred notice: «مبلغ نهایی این خرید صفر شده است. تکمیل این نوع خرید پس از افزودن جریان تأیید رایگان فعال خواهد شد.»
- The coupon may still be applied (snapshot + redemption row); only completion
  is blocked.
- **Future work:** a trusted service-role RPC that (a) verifies the purchase is
  the parent's own and still `pending` with `final_price_amount = 0`, (b) marks
  it `paid`, (c) credits candies, and (d) promotes the redemption to `redeemed`
  — atomically. This must be EXECUTE service-role only, like the coupon RPCs.
  Do NOT reuse the dev completion route for this.
- If `final_price_amount` is ever `0` with a payment attempt, the provider
  integration must refuse to create a session (nothing to charge).

---

## 9. Rial/Toman Decision

### 9.1 Current State

| Location | Value | Display |
|---|---|---|
| `candy_packages.price_amount` | 50000, 135000, 280000 | Documented as "Rials" in DB comment |
| `payment_attempts.requested_amount` | Copied from purchase snapshot | Integer Rial (IRR) |
| UI (billing page) | `toLocaleString("fa-IR")` + "ریال" | Displayed as Rials |
| UI (marketing/pricing page) | `priceToman` field in `config/plans.ts` | Displayed as "تومان" |
| `candy_packages.currency` | `'IRR'` | ISO 4217 code for Rial |

### 9.2 Finding

There is a discrepancy:

1. The database stores values and labels them as **IRR (Rial)** — ISO 4217 standard.
2. The marketing pricing page (`config/plans.ts`) uses **قیمت به تومان** and labels prices as "تومان".
3. The billing page displays package prices as "ریال" (Rial).

### 9.3 Examples

| Package | DB `price_amount` | DB `currency` | Billing UI Display | Marketing UI Display |
|---|---|---|---|---|
| Starter | 50000 | IRR | ۵۰,۰۰۰ ریال | ۹۰۰,۰۰۰ تومان |
| Growth | 135000 | IRR | ۱۳۵,۰۰۰ ریال | — |
| Premium | 280000 | IRR | ۲۸۰,۰۰۰ ریال | — |

Note: The marketing page values (`config/plans.ts`) are completely different numbers from the database values. The plans page displays `priceToman` values that do not correspond to the `candy_packages` values. This is a separate pre-existing concern (the marketing page uses hardcoded plan configs, not live database pricing).

### 9.4 Decision (Implemented July 31)

**Option C adopted**: store all amounts as integer Rial (ISO `IRR`), and let the provider
adapter convert to whatever unit the provider expects.

- `price_amount` / `requested_amount` = integer rial value (e.g., 50000 = 50,000 Rials)
- `currency` = `'IRR'`
- Provider charge amount = rial value (adapter converts if the provider expects another unit)
- UI displays raw rial value with "ریال" label

**Do not** rename to toman, convert, rescale, or change the unit in the database. This is
now enforced by documentation in the payment migration comments; no schema constraint is
needed since the unit is a convention, not a type.

### 9.5 Remaining Work

Package amounts remain placeholders — they require commercial approval before provider
launch. The marketing page `config/plans.ts` is a separate concern (hardcoded values to be
replaced when live pricing is finalized).

---

## 10. Webhook Security

### 10.1 Endpoint Design

```
POST /api/payments/webhooks/[provider]
```

- No authentication cookies — uses provider signature verification only
- Must handle raw request body (some providers require exact body for signature verification)
- Must respond quickly (200 within provider timeout)
- Never trust redirect query parameters

### 10.2 Required Controls

| Control | Implementation |
|---|---|
| Signature verification | Compare provider signature header against computed HMAC of raw body using webhook secret |
| Raw body handling | `request.text()` before any JSON parsing (if provider signs raw body) |
| Timestamp/replay protection | Reject events older than 5 minutes (configurable) |
| Event ID idempotency | Check `processed_webhook_events` table before processing |
| Server-side verification | Call `provider.verifyPayment()` after webhook, before marking paid |
| Amount comparison | `paid_amount === purchase.price_amount` (strict equality) |
| Currency comparison | `paid_currency === purchase.currency` (case-sensitive) |
| Unknown event handling | Log and acknowledge (200) — do not reject the webhook |
| Fast acknowledgment | Return 200 before or after processing (prefer after, within timeout) |
| Retry-safe processing | Idempotent — duplicate events return same result |
| No browser auth dependency | Signature verification replaces cookie-based auth |
| No payload logging | Log event ID and outcome only, not raw body (may contain card data) |

### 10.3 Safe Responses

| Scenario | HTTP Status | Body |
|---|---|---|
| Valid new event | 200 | `{"status": "processed", "purchase_id": "..."}` |
| Duplicate event | 200 | `{"status": "duplicate", "purchase_id": "..."}` |
| Invalid signature | 401 | `{"error": "invalid_signature"}` |
| Unknown purchase | 200 | `{"status": "purchase_not_found"}` (acknowledge to provider but flag for review) |
| Amount mismatch | 200 | `{"status": "amount_mismatch", "expected": X, "received": Y}` (flag for review) |
| Currency mismatch | 200 | `{"status": "currency_mismatch"}` (flag for review) |
| Already paid purchase | 200 | `{"status": "already_paid"}` |
| Provider verification temp failure | 500 | Provider will retry |

### 10.4 Database Storage for Webhooks

Minimal logging to `candy_purchases.provider_metadata` (JSONB):

```json
{
  "last_webhook": {
    "event_id": "...",
    "event_type": "...",
    "received_at": "...",
    "status": "processed"
  }
}
```

Or a separate `payment_webhook_log` table for full audit trail (post-MVP).

---

## 11. Redirect UX

### 11.1 Future Routes

| Route | Purpose |
|---|---|
| `POST /api/candy-purchases/[id]/pay` | Create provider session, return checkout URL |
| `/payments/return?purchase_id=X` | Provider redirects browser here after payment |
| `/payments/result/[id]` | Final payment status page |

### 11.2 Customer States

| State | Persian Label | Display |
|---|---|---|
| Redirecting to provider | "در حال انتقال به درگاه پرداخت" | Spinner + automatic redirect |
| Awaiting payment | "در انتظار تأیید پرداخت" | Polling page |
| Payment successful | "پرداخت با موفقیت انجام شد" | Success checkmark + wallet updated |
| Payment failed | "پرداخت ناموفق بود" | Error message + retry button |
| Payment cancelled | "پرداخت لغو شد" | Info message |
| Status unknown (polling) | "وضعیت پرداخت هنوز مشخص نیست" | Spinner + "لطفاً صبر کنید" |

### 11.3 Return Page Behavior

The return page (`/payments/return`) must:

1. Extract `purchase_id` from URL query parameters
2. Call `GET /api/candy-purchases/[id]/status` (read-only) to check current status
3. If `paid` → show success page
4. If `failed` → show failure page with retry
5. If `awaiting_payment` → poll every 3 seconds for up to 30 seconds
6. If still `awaiting_payment` after 30 seconds → show "وضعیت پرداخت هنوز مشخص نیست" with a manual refresh button
7. NEVER mark purchase paid based on URL parameters
8. NEVER trust query parameters for amount, status, or reference

### 11.4 Payment Start Endpoint

```
POST /api/candy-purchases/[id]/pay
```

Request: (empty body or minimal)
Response:
```json
{
  "checkout_url": "https://provider.checkout/..."
}
```

The client (browser or server) redirects to `checkout_url`. The purchase status is updated to `awaiting_payment` before the redirect.

---

## 12. Reconciliation

### 12.1 Scenarios and Handling

| Scenario | Handling |
|---|---|
| Provider says paid but webhook missed | Reconciliation job queries provider for recent transactions, compares with `candy_purchases` |
| Webhook arrives before browser redirect | Webhook marks paid. Browser redirect sees `paid` status → success page (happy case) |
| Duplicate webhooks | Event ID dedup + idempotent wallet credit — no double pay |
| Browser closes before returning | Purchase will be `awaiting_payment` or `paid` pending reconciliation |
| Provider verification fails temporarily | Webhook returns 500, provider retries |
| Purchase remains pending too long | Daily reconciliation job: expire purchases > 24 hours in `awaiting_payment` |
| Provider session expires | Provider returns error on redirect — mark `failed` with `last_payment_error_code` |
| User retries payment | New `awaiting_payment` attempt, `payment_attempt_count` incremented |
| Wallet credit succeeds but response times out | RPC is idempotent — client retries will see current state without double-credit |
| Support needs to investigate | Admin view shows status, timestamps, provider refs, attempt count, last error |

### 12.2 Reconciliation Job (Post-MVP)

A scheduled job (e.g., cron job or Vercel Cron) that:

1. Finds purchases in `awaiting_payment` older than configured threshold (e.g., 2 hours)
2. For each, calls `provider.verifyPayment()` to check actual status
3. Updates purchase status based on provider response
4. Logs reconciliation results

### 12.3 Pending-Purchase Expiry

A daily job that marks purchases stuck in `awaiting_payment` > 24 hours as `failed` with `last_payment_error_code = 'session_expired'`. This is separate from the reconciliation job.

### 12.4 Admin Retry Action

Manual endpoint (admin-only) to retry a failed purchase:
```
POST /api/admin/payments/[id]/retry
```
Re-creates provider session, updates status to `awaiting_payment`.

### 12.5 Audit Logging

All payment state transitions should be logged:
- Who/what triggered the transition (webhook, API, admin, cron)
- Previous status → new status
- Provider event ID (if applicable)
- Timestamp

---

## 13. Refund Deferral

### 13.1 Recommendation: Defer Refunds to Post-MVP

Real refunds are out of scope for the first provider integration.

### 13.2 Rationale

- MVP focus is one-directional: parent pays → candies credited
- Refund logic adds significant complexity: wallet balance checks, negative ledger entries, partial amounts, support approval
- First provider integration should be as simple as possible

### 13.3 Future Refund Rules

| Scenario | Policy |
|---|---|
| Refund before candies spent | Full refund, reverse wallet credit via negative ledger entry |
| Refund after some candies spent | Partial refund for unused candies only |
| Wallet insufficient for reversal | Manual fulfillment — refund via provider, negative wallet balance (or manual credit) |
| Full vs partial refund | Partial refunds allowable, recorded in `candy_purchases` |
| Manual support approval | Admin-only refund endpoint, requires notes |

### 13.4 Ledger for Refunds (Future)

```
type = 'refund', amount = +X (credit back to wallet)
```

The `candy_transactions` type enum already includes `'refund'`. No schema change needed for the type, but a refund RPC would need to verify:
- Wallet exists
- Provider transaction ID exists
- Not already refunded
- Refund amount does not exceed original paid amount

---

## 14. Admin Requirements

### 14.1 Minimum Future Admin Payment View

Admin should see at a glance:

| Field | Source |
|---|---|
| Purchase ID | `candy_purchases.id` |
| Status | `candy_purchases.status` |
| Parent name | `parent_profiles.full_name` via join |
| Package name | `candy_packages.name` via join |
| Candy amount | `candy_purchases.candy_amount` (snapshot) |
| Price | `candy_purchases.price_amount` + `currency` |
| Payment provider | `candy_purchases.payment_provider` |
| Provider session ID | `candy_purchases.provider_session_id` |
| Provider transaction ID | `candy_purchases.provider_transaction_id` |
| Created at | `candy_purchases.created_at` |
| Paid at / Failed at / Cancelled at | respective timestamp columns |
| Provider verified at | `candy_purchases.provider_verified_at` |
| Attempt count | `candy_purchases.payment_attempt_count` |
| Last error code | `candy_purchases.last_payment_error_code` |
| Wallet credited? | Join to `candy_transactions` for this purchase ID |

### 14.2 Admin Must NOT See

- Card numbers, CVV, or any PAN
- Provider API keys or secrets
- Raw authentication tokens
- Sensitive raw webhook payloads
- Database connection strings

### 14.3 Admin Actions (Post-MVP)

- View purchase details
- Retry a failed purchase (create new provider session)
- Mark a purchase as failed for manual intervention
- View reconciliation history
- Initiate refund (post-MVP)

---

## 15. Environment/Secrets

### 15.1 Required Future Variables

| Variable | Server-Only? | Purpose |
|---|---|---|
| `PAYMENT_PROVIDER` | Yes (server) | Active provider name ('zarinpal', 'nextpay', etc.) |
| `PAYMENT_MERCHANT_ID` | Yes (server) | Provider merchant/account identifier |
| `PAYMENT_API_KEY` | Yes (server) | Provider secret/API key |
| `PAYMENT_WEBHOOK_SECRET` | Yes (server) | Secret for verifying webhook signatures |
| `PAYMENT_RETURN_URL` | Yes (server) | Cartoona return URL (where provider sends browser back) |
| `PAYMENT_WEBHOOK_URL` | Yes (server) | Cartoona webhook URL (may differ from return URL) |
| `PAYMENT_MODE` | Yes (server) | `"test"` or `"live"` |

### 15.2 Naming Pattern

All payment variables prefixed with `PAYMENT_` for clear grouping.

### 15.3 Startup Validation

On application startup, validate:

```typescript
function validatePaymentConfig(): void {
  if (!process.env.PAYMENT_PROVIDER) {
    throw new Error("PAYMENT_PROVIDER is required")
  }
  if (!process.env.PAYMENT_MERCHANT_ID) {
    throw new Error("PAYMENT_MERCHANT_ID is required")
  }
  if (!process.env.PAYMENT_API_KEY) {
    throw new Error("PAYMENT_API_KEY is required")
  }
  if (!process.env.PAYMENT_WEBHOOK_SECRET) {
    throw new Error("PAYMENT_WEBHOOK_SECRET is required")
  }
  if (process.env.PAYMENT_MODE !== "test" && process.env.PAYMENT_MODE !== "live") {
    throw new Error("PAYMENT_MODE must be 'test' or 'live'")
  }
  if (process.env.PAYMENT_MODE === "live" && !process.env.PAYMENT_WEBHOOK_URL) {
    throw new Error("PAYMENT_WEBHOOK_URL is required in live mode")
  }
  if (process.env.PAYMENT_MODE === "live" && !process.env.PAYMENT_RETURN_URL) {
    throw new Error("PAYMENT_RETURN_URL is required in live mode")
  }
}
```

### 15.4 Security Rules

- `PAYMENT_API_KEY` and `PAYMENT_WEBHOOK_SECRET` must never appear in:
  - Client-side code
  - Logs (redact on output)
  - Database
  - Error messages
  - Documentation
  - Test files
- `PAYMENT_MODE === "live"` with missing secrets → application must fail to start (fail closed)
- Test provider credentials must never be configured when `PAYMENT_MODE === "live"`

### 15.5 Current Validation Audit

Current environment validation (`lib/supabase/env.ts`) validates `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` at startup. Payment configuration should follow the same pattern but in a separate module (`lib/payments/config.ts`).

---

## 16. Testing Strategy

### 16.1 Test Layers

| Layer | What | Tool | Runs Against |
|---|---|---|---|
| 1. Unit tests | Amount matching, status transitions, provider response mapping, idempotency logic | Vitest | Local (mocked) |
| 2. Adapter contract tests | Provider requests mocked, no real network | Vitest | Local (mocked) |
| 3. Webhook route tests | Valid signature, invalid signature, duplicate event, amount mismatch, retry | Playwright | Local dev server (mocked provider) |
| 4. DB integration tests | Atomic paid transition, one wallet credit, cross-user protection | Vitest + supabase | Disposable/test database only |
| 5. Sandbox provider tests | End-to-end with provider test environment | Playwright | Separate test env only |
| 6. Production smoke tests | Read-only — configuration and health checks | Playwright | Main project (read-only) |

### 16.2 Guard Enforcement

All tests in layers 3, 4, and 5 must use `assertSafeDatabaseTarget()` to block execution against the main Supabase project.

### 16.3 Mocked Provider Adapter for Tests

```typescript
// lib/payments/__mocks__/mock-provider.ts
// Simulates all provider states without real network calls
```

### 16.4 Specific Test Cases

**Unit tests:**
- `createPaymentSession` returns expected shape
- `verifyPayment` returns correct status mapping
- `parseWebhook` accepts valid signature, rejects invalid
- `parseWebhook` extracts event ID correctly
- Status transitions: each allowed transition, each disallowed transition
- Idempotency: same key → no double-credit

**Webhook route tests:**
- Valid signature + valid event → 200, purchase marked paid
- Invalid signature → 401
- Unknown event type → 200 (acknowledge)
- Duplicate event (same event ID) → 200 (duplicate)
- Amount mismatch → 200 (flagged)
- Provider retry (same event after temporary 500) → 200
- No signature header → 401

**DB integration tests (disposable target only):**
- Create purchase → provider session → complete → wallet credited exactly once
- Cross-user: cannot credit another parent's wallet
- Atomic: concurrent completion only credits once
- Revert: cancelled or failed purchase does not credit wallet

---

## 17. Security Blockers

### 17.1 ~~BLOCKER~~ RESOLVED: `complete_candy_purchase` RPC Was Callable Directly

**Status: RESOLVED** (migration `20260730100000`, applied July 30 2026)

**Original finding:**
Line 343 of `20260729100000_candy_purchase_foundation.sql` had:
```sql
GRANT EXECUTE ON FUNCTION public.complete_candy_purchase(UUID, TEXT) TO authenticated;
```
Every authenticated Supabase user could call this RPC directly via REST API, bypassing the `NODE_ENV` guard in the Next.js route.

**Remediation applied:**

1. **New trusted RPC** `complete_candy_purchase_trusted(UUID, UUID, TEXT)` created. It accepts a verified `parent_profile_id` (resolved server-side by the API route) instead of relying on `auth.uid()`. This RPC is callable only by `service_role`.

2. **Old RPC privileges revoked** — both old and new functions now have:
   ```sql
   REVOKE ALL ON FUNCTION ... FROM PUBLIC;
   REVOKE ALL ON FUNCTION ... FROM anon;
   REVOKE ALL ON FUNCTION ... FROM authenticated;
   -- Only for the trusted RPC:
   GRANT EXECUTE ON FUNCTION ... TO service_role;
   ```

3. **API route updated** to use `createAdminSupabaseClient()` (service-role key) for the RPC call.

4. **Ownership preserved** — the API route authenticates the parent via `getUser()` and `parent_session_lifetime`, resolves `parent_profile_id`, and passes it to the trusted RPC. The RPC double-checks ownership via `FOR UPDATE` + `parent_id` comparison.

**Verified privileges (July 30 2026):**
- anon key → `permission denied` on both functions
- service_role key → trusted function reaches purchase logic (not blocked by auth checks)

### 17.2 Final Trusted Completion Boundary

```
Browser POST /api/candy-purchases/[id]/complete
  → Server authenticates parent (getUser, role, session lifetime)
  → Server resolves parent_profile_id from database
  → Server calls complete_candy_purchase_trusted via service_role key
  → RPC verifies purchase ownership against the provided parent_profile_id
  → RPC credits wallet (FOR UPDATE, idempotent)
  → Server returns result
```

Real provider verification will later use the same trusted boundary. The webhook handler will call the same service-role-only RPC after provider signature verification and server-to-server amount comparison.

### 17.3 For Real Payment Flow

Real payment completion will use the same trusted RPC `complete_candy_purchase_trusted` (or an equivalent replacement) called exclusively by service-role server code after provider verification. No browser-authenticated role will ever receive EXECUTE permission.

### 17.4 Foundation RPCs Already Service-Role-Only (July 31 2026)

`create_payment_attempt_trusted` and `record_payment_attempt_session_trusted` follow the
same trusted boundary from day one: SECURITY DEFINER, `SET search_path = ''`, EXECUTE
revoked from `PUBLIC`/`anon`/`authenticated` and granted only to `service_role` (verified
in the main project). A future payment-start endpoint will call them via
`createAdminSupabaseClient()`, and the RPCs reject browser invocation outright.

---

## 18. Implementation Roadmap

### ~~Stage 1~~ COMPLETED — Security Correction

**Business result:** Dev-only completion cannot be exploited.

**Scope:**
- Remove `GRANT EXECUTE TO authenticated` from `complete_candy_purchase`
- Add `REVOKE EXECUTE FROM authenticated`
- Update API route to use `createAdminSupabaseClient()` for RPC call
- Verify direct Supabase REST calls to the RPC now fail with 401/404

**Migration:** `20260730100000_restrict_candy_purchase_completion.sql`

**Applied:** July 30 2026

**Verification:**
- ✅ `authenticated` role cannot execute either completion function
- ✅ `anon` role cannot execute either completion function
- ✅ `service_role` can execute the trusted function
- ✅ API route uses admin client (service_role) for the RPC call
- ✅ Ownership preserved via server-resolved parent_profile_id
- ✅ Explicit simulation flag `CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION`
- ✅ 16 payment-simulation-policy unit tests added and passing
- ✅ 69/69 unit tests total
- ✅ 26/26 migrations local=remote
- ✅ Zero database mutation during remediation

---

### Stage 2: Provider-Neutral Schema Additions

**Business result:** Database can store provider session data.

**Migration:** `20260731110000_provider_neutral_payment_foundation.sql`

**Applied:** July 31 2026 — **COMPLETE**

**Scope (as implemented):**
- New `payment_attempts` table — per-attempt provider state (session, transaction, checkout URL, verification, failure), `attempt_number` + `idempotency_key` unique per purchase, partial unique provider-session/transaction indexes, at-most-one-verified partial unique index
- New `payment_webhook_events` table — provider webhook dedup, `UNIQUE(provider, provider_event_id)`, no raw payloads, no browser access
- `candy_purchases` additions — `active_payment_attempt_id` (FK → payment_attempts, ON DELETE SET NULL), `payment_provider`, `provider_verified_at`, `expires_at`, `cancelled_at`, `failed_at`
- Purchase status CHECK extended to `('pending','paid','failed','cancelled','expired')`; transient states live on attempts only
- RLS — parents read own attempts, admins read all, no browser writes
- Trusted service-role-only RPCs `create_payment_attempt_trusted` + `record_payment_attempt_session_trusted`
- TypeScript types in `types/database.ts` and `lib/payments/types.ts`; pure rules in `lib/payments/rules.ts` (+16 unit tests)

**Acceptance criteria:**
- ✅ New tables/columns present with correct constraints and indexes (verified on main project)
- ✅ New statuses accepted; existing purchases unaffected (0 purchases, no data mutation)
- ✅ RLS policies cover new tables; no anon/authenticated grants on webhook table
- ✅ 28/28 migrations local=remote

**Deferred from original scope (correctly moved to attempts):**
`provider_session_id`, `provider_transaction_id`, `checkout_url`, `checkout_expires_at`,
`payment_attempt_count`, `last_payment_error_code` were originally listed as
`candy_purchases` columns. Per the §6 attempt-model decision they now live on
`payment_attempts`.

---

### Stage 3: Provider Interface and Mocked Adapter

**Business result:** Provider-agnostic adapter layer exists and can be tested.

**Scope:**
- Create `lib/payments/provider.ts` — interface
- Create `lib/payments/types.ts` — provider-neutral types (foundation subset already exists — `types.ts` + `rules.ts`)
- Create `lib/payments/registry.ts` — adapter registry
- Create `lib/payments/config.ts` — environment validation
- Create `lib/payments/__mocks__/mock-provider.ts` — test adapter
- Write unit tests for adapter contract
- Write unit tests for amount matching, status transitions, idempotency

**Migration:** No

**Test DB needed:** No (unit tests, mocked)

**Acceptance criteria:**
- All unit tests pass
- Mock provider returns expected shapes
- Missing env vars throw at startup
- Adapter registry works with registered mock

---

### Stage 4: Selected Provider Integration

**Business result:** Real provider sessions can be created.

**Scope:**
- Install provider SDK (one `npm install`)
- Implement `PaymentProvider` adapter for selected provider
- Create `POST /api/candy-purchases/[id]/pay` endpoint
- Update `POST /api/candy-purchases` to return `checkout_url`
- Create payment redirect flow
- Register adapter in registry

**Migration:** No (schema from Stage 2 already supports it)

**Test DB needed:** Yes (sandbox provider testing)

**Acceptance criteria:**
- Provider session created successfully
- Browser redirects to provider checkout
- Checkout URL expires correctly
- Payment attempt count increments on retry

---

### Stage 5: Webhook and Verification

**Business result:** Server-side payment confirmation without trusting browser.

**Scope:**
- Create `POST /api/payments/webhooks/[provider]` endpoint
- Implement signature verification
- Implement event ID dedup
- Implement server-to-server verification
- Implement amount/currency checks
- Create completion RPC (service-role-only) that credits wallet
- Remove dev-only completion route or gate behind `DEV` flag
- Wire webhook → verification → purchase completion → wallet credit

**Migration:** Yes (new completion RPC replacing dev-only; grant only to service_role)

**Test DB needed:** Yes (disposable) — webhook flow must be tested end-to-end

**Acceptance criteria:**
- Valid webhook → purchase marked paid, wallet credited exactly once
- Invalid signature → 401
- Duplicate event → 200 (idempotent)
- Amount mismatch → 200 (flagged, not credited)
- Direct RPC call by authenticated user → rejected

---

### Stage 6: Payment-Result UX

**Business result:** Parents see clear payment status.

**Scope:**
- Create `/payments/return` page (polling)
- Create `/payments/result/[id]` page (terminal states)
- Add redirect flow from API to provider
- Add "در حال انتقال به درگاه" spinner
- Add "پرداخت موفق" success view
- Add "پرداخت ناموفق" error view with retry
- Add polling logic with timeout and fallback
- Update billing dashboard to show `awaiting_payment` purchases

**Migration:** No

**Test DB needed:** No (mock provider)

**Acceptance criteria:**
- Return page shows correct status for each state
- Polling stops when purchase reaches terminal state
- Retry button creates new provider session
- "وضعیت پرداخت هنوز مشخص نیست" shows when polling times out

---

### Stage 7: Admin Payment Visibility

**Business result:** Support team can investigate payments.

**Scope:**
- Add admin-only `GET /api/admin/payments` endpoint
- Add admin-only `GET /api/admin/payments/[id]` detail endpoint
- Add admin-only `POST /api/admin/payments/[id]/retry` endpoint
- Create admin UI for payment list and detail view
- Show wallet credit status (ledger lookup)
- Add filter by status, provider, date range

**Migration:** No

**Test DB needed:** Yes (if testing mutation endpoints)

**Acceptance criteria:**
- Admin sees all purchases with status and provider info
- Admin can retry a failed purchase
- Admin cannot see card data or secrets
- Non-admin users cannot access admin endpoints

---

### Stage 8: Reconciliation and Operational Tooling

**Business result:** Stuck payments auto-resolve.

**Scope:**
- Create reconciliation job (cron or scheduled)
- Create pending-purchase expiry job
- Add `processed_webhook_events` cleanup job
- Add admin alerting for amount/currency mismatches
- Add audit log for payment state transitions

**Migration:** Possibly — reconciliation log table

**Test DB needed:** Yes (disposable) — test reconciliation logic

**Acceptance criteria:**
- Stuck `awaiting_payment` purchases are reconciled after threshold
- Expired sessions auto-fail after 24 hours
- Amount mismatch is flagged and not silent
- Audit log captures all transitions

---

## Summary of Stages

| Stage | Name | Migration | Test DB | Dependencies |
|---|---|---|---|---|---|
| 1 | Security Correction ✅ | `20260730100000` | No | None |
| 2 | Schema Additions | Yes | Yes | Stage 1 |
| 3 | Provider Interface | No | No | None |
| 4 | Provider Integration | No | Yes | Stages 2, 3 |
| 5 | Webhook & Verification | Yes | Yes | Stages 2, 3, 4 |
| 6 | Payment UX | No | No | Stage 5 |
| 7 | Admin Visibility | No | Yes | Stages 2, 5 |
| 8 | Reconciliation | Maybe | Yes | Stages 4, 5 |

---

## Files Inspected

- `supabase/migrations/20260729100000_candy_purchase_foundation.sql`
- `supabase/migrations/20260726100000_harden_candy_wallet_ledger.sql`
- `supabase/migrations/20260726110000_atomic_request_candy_debit.sql`
- `app/api/candy-packages/route.ts`
- `app/api/candy-purchases/route.ts`
- `app/api/candy-purchases/[id]/complete/route.ts`
- `lib/candy-purchases/types.ts`
- `components/dashboard/billing/candy-billing-dashboard.tsx`
- `components/dashboard/billing/candy-balance-card.tsx`
- `components/dashboard/billing/candy-package-card.tsx`
- `components/dashboard/billing/candy-purchase-confirmation.tsx`
- `components/dashboard/billing/candy-purchase-history.tsx`
- `types/database.ts`
- `lib/supabase/server.ts`
- `lib/supabase/admin.ts`
- `lib/supabase/env.ts`
- `lib/auth/parent-access.ts`
- `lib/auth/admin-role.ts`
- `middleware.ts`
- `config/plans.ts`
- `docs/TEST_DATABASE.md`
- `.claude/summary.md`
- `app/(dashboard)/dashboard/billing/page.tsx`
- `app/(marketing)/pricing/page.tsx`

## Validation Results (updated July 30 2026)

| Check | Result |
|---|---|
| `npm test` | 69/69 pass (3 files) |
| `npm run lint` | 0 errors, 27 warnings (pre-existing) |
| `npx next build` | Succeeds |
| Guard unit tests | 33/33 pass |
| Guard smoke tests | 10/10 pass |
| `npx supabase migration list` | 26/26 local=remote |
| `npx supabase db push --dry-run` | Remote database is up to date |
| Privilege: anon key → old function | `permission denied` |
| Privilege: anon key → trusted function | `permission denied` |
| Privilege: service_role → trusted function | `purchase_not_found` (reachable) |
| Non-mutation: wallet, ledger, purchases, orders | Zero changes |

## Files Modified

| File | Change |
|---|---|
| `docs/PAYMENT_PROVIDER_ARCHITECTURE.md` | Blockers section updated, Stage 1 marked completed |
| `supabase/migrations/20260730100000_restrict_candy_purchase_completion.sql` | Created |
| `app/api/candy-purchases/[id]/complete/route.ts` | Trusted admin client, env-var simulation policy |
| `app/(dashboard)/dashboard/billing/page.tsx` | Server-derived simulation flag |
| `components/dashboard/billing/candy-billing-dashboard.tsx` | Server prop replaces hostname check |
| `tests/unit/payment-simulation-policy.test.ts` | Created (16 test cases) |
| `.env.local.example` | Added CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION |
| `.env.example` | Added CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION |
