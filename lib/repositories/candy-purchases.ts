import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Candy packages, purchases, purchase coupons and payment attempts on plain
 * PostgreSQL (V0.1.51). Every WRITE is one trusted function (migration 0017):
 * the app role has EXECUTE on those and SELECT on the read tables, and no
 * INSERT/UPDATE/DELETE on any purchase, payment, coupon, wallet or ledger
 * table. Ownership is the caller-resolved parent profile id, re-checked inside
 * every function.
 */

// ── catalog ──────────────────────────────────────────────────────────────────

export interface CandyPackageRow {
  id: string;
  name: string;
  description: string | null;
  candyAmount: number;
  priceAmount: number;
  currency: string;
  displayOrder: number;
}

const SELECT_ACTIVE_PACKAGES = `
  SELECT id, name, description, candy_amount, price_amount, currency, display_order
  FROM public.candy_packages
  WHERE is_active = true
  ORDER BY display_order ASC, id ASC`;

/** The ACTIVE catalog, in display order (the same rows the purchase function prices from). */
export async function listActiveCandyPackages(db: Queryable): Promise<CandyPackageRow[]> {
  const rows = await runQuery<{
    id: string; name: string; description: string | null; candy_amount: number; price_amount: number; currency: string; display_order: number;
  }>(db, SELECT_ACTIVE_PACKAGES);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    candyAmount: r.candy_amount,
    priceAmount: r.price_amount,
    currency: r.currency,
    displayOrder: r.display_order,
  }));
}

// ── history ──────────────────────────────────────────────────────────────────

export interface PurchaseHistoryRow {
  id: string;
  package_name: string;
  candy_amount: number;
  price_amount: number;
  original_price_amount: number;
  discount_amount: number;
  final_price_amount: number;
  currency: string;
  status: string;
  created_at: string;
  paid_at: string | null;
  coupon_code_snapshot: string | null;
  coupon_status: "reserved" | "redeemed" | "cancelled" | null;
  coupon_name: string | null;
  payment_started: boolean;
}

/**
 * One parent's purchases, newest first, with the same derived fields the
 * Supabase route assembled from four queries: package name, the coupon
 * redemption snapshot (code + status), the coupon's display NAME only, and
 * whether any payment attempt exists. No internal id (coupon, redemption,
 * attempt, provider) leaves this function.
 */
const SELECT_HISTORY = `
  SELECT p.id, coalesce(k.name, '') AS package_name, p.candy_amount, p.price_amount,
         p.original_price_amount, p.discount_amount, p.final_price_amount, p.currency, p.status,
         to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
         CASE WHEN p.paid_at IS NULL THEN NULL ELSE to_char(p.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS paid_at,
         r.normalized_code_snapshot AS coupon_code_snapshot,
         r.status AS coupon_status,
         nullif(btrim(c.name), '') AS coupon_name,
         EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.purchase_id = p.id) AS payment_started
  FROM public.candy_purchases p
  LEFT JOIN public.candy_packages k ON k.id = p.package_id
  LEFT JOIN public.coupon_redemptions r ON r.purchase_id = p.id
  LEFT JOIN public.coupons c ON c.id = r.coupon_id
  WHERE p.parent_id = $1
  ORDER BY p.created_at DESC, p.id DESC`;

export async function listParentPurchases(db: Queryable, input: { parentProfileId: string }): Promise<PurchaseHistoryRow[]> {
  const parentProfileId = requireUuid(input.parentProfileId, "parentProfileId");
  return runQuery<PurchaseHistoryRow>(db, SELECT_HISTORY, [parentProfileId]);
}

// ── writes (trusted functions) ───────────────────────────────────────────────

export interface CreatedPurchase {
  id: string;
  candy_amount: number;
  price_amount: number;
  discount_amount: number;
  final_price_amount: number;
  currency: string;
  status: string;
  created_at: string;
}

export async function createCandyPurchase(db: Queryable, input: { parentProfileId: string; packageId: string }): Promise<CreatedPurchase> {
  const parentProfileId = requireUuid(input.parentProfileId, "parentProfileId");
  const packageId = requireUuid(input.packageId, "packageId");
  const rows = await runQuery<CreatedPurchase & { created_at: string }>(
    db,
    `SELECT id, candy_amount, price_amount, discount_amount, final_price_amount, currency, status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at
     FROM public.create_candy_purchase_trusted($1, $2)`,
    [parentProfileId, packageId],
  );
  if (!rows[0]) throw new TypeError("create_candy_purchase_trusted returned no row");
  return rows[0];
}

export interface CouponValidationRow {
  normalized_code: string;
  discount_type: "percentage" | "fixed_amount";
  original_price_amount: number;
  discount_amount: number;
  final_price_amount: number;
  currency: string;
}

export async function validateCouponForPurchase(
  db: Queryable,
  input: { parentProfileId: string; purchaseId: string; code: string },
): Promise<CouponValidationRow> {
  const rows = await runQuery<CouponValidationRow>(
    db,
    `SELECT normalized_code, discount_type, original_price_amount, discount_amount, final_price_amount, currency
     FROM public.validate_coupon_for_purchase_trusted($1, $2, $3)`,
    [requireUuid(input.parentProfileId, "parentProfileId"), requireUuid(input.purchaseId, "purchaseId"), input.code],
  );
  if (!rows[0]) throw new TypeError("validate_coupon_for_purchase_trusted returned no row");
  return rows[0];
}

export interface AppliedCouponRow extends CouponValidationRow {
  discount_value: number;
  status: "reserved" | "redeemed" | "cancelled";
}

export async function applyCouponToPurchase(
  db: Queryable,
  input: { parentProfileId: string; purchaseId: string; code: string; idempotencyKey: string },
): Promise<AppliedCouponRow> {
  const rows = await runQuery<AppliedCouponRow>(
    db,
    `SELECT normalized_code, discount_type, discount_value, original_price_amount, discount_amount, final_price_amount, currency, status
     FROM public.apply_coupon_to_purchase_trusted($1, $2, $3, $4)`,
    [requireUuid(input.parentProfileId, "parentProfileId"), requireUuid(input.purchaseId, "purchaseId"), input.code, input.idempotencyKey],
  );
  if (!rows[0]) throw new TypeError("apply_coupon_to_purchase_trusted returned no row");
  return rows[0];
}

export interface PaymentAttemptRow {
  id: string;
  status: string;
  requested_amount: number;
  requested_currency: string;
  provider_session_id: string | null;
  checkout_url: string | null;
}

/** Create (or, for the same idempotency key, return) a payment attempt. Amount = the purchase's payable snapshot. */
export async function createPaymentAttempt(
  db: Queryable,
  input: { parentProfileId: string; purchaseId: string; provider: string; idempotencyKey: string; checkoutExpiresAt: string | null },
): Promise<PaymentAttemptRow> {
  const rows = await runQuery<PaymentAttemptRow>(
    db,
    `SELECT id, status, requested_amount, requested_currency, provider_session_id, checkout_url
     FROM public.create_payment_attempt_trusted($1, $2, $3, $4::timestamptz, $5)`,
    [
      requireUuid(input.purchaseId, "purchaseId"),
      requireUuid(input.parentProfileId, "parentProfileId"),
      input.provider,
      input.checkoutExpiresAt,
      input.idempotencyKey,
    ],
  );
  if (!rows[0]) throw new TypeError("create_payment_attempt_trusted returned no row");
  return rows[0];
}

/** Whether attempt `attemptId` belongs to purchase `purchaseId` of this parent. */
export async function attemptBelongsTo(
  db: Queryable,
  input: { parentProfileId: string; purchaseId: string; attemptId: string },
): Promise<boolean> {
  const rows = await runQuery<{ ok: boolean }>(
    db,
    `SELECT true AS ok FROM public.payment_attempts a JOIN public.candy_purchases p ON p.id = a.purchase_id
     WHERE a.id = $1 AND a.purchase_id = $2 AND p.parent_id = $3`,
    [requireUuid(input.attemptId, "attemptId"), requireUuid(input.purchaseId, "purchaseId"), requireUuid(input.parentProfileId, "parentProfileId")],
  );
  return rows.length === 1;
}

export async function recordAttemptSession(
  db: Queryable,
  input: { attemptId: string; providerSessionId: string; checkoutUrl: string; checkoutExpiresAt: string | null },
): Promise<PaymentAttemptRow> {
  const rows = await runQuery<PaymentAttemptRow>(
    db,
    `SELECT id, status, requested_amount, requested_currency, provider_session_id, checkout_url
     FROM public.record_payment_attempt_session_trusted($1, $2, $3, $4::timestamptz)`,
    [requireUuid(input.attemptId, "attemptId"), input.providerSessionId, input.checkoutUrl, input.checkoutExpiresAt],
  );
  if (!rows[0]) throw new TypeError("record_payment_attempt_session_trusted returned no row");
  return rows[0];
}

// ── provider events (service-authenticated only) ─────────────────────────────

export type PaymentEventOutcome =
  | "processed"
  | "duplicate_event"
  | "already_paid"
  | "attempt_not_found"
  | "amount_mismatch"
  | "currency_mismatch"
  | "purchase_cancelled"
  | "transaction_reused";

export async function confirmPaymentEvent(
  db: Queryable,
  input: { provider: string; eventId: string; sessionId: string; transactionId: string; amount: number; currency: string },
): Promise<{ outcome: PaymentEventOutcome; purchaseId: string | null }> {
  const rows = await runQuery<{ outcome: PaymentEventOutcome; purchase_id: string | null }>(
    db,
    `SELECT outcome, purchase_id FROM public.confirm_payment_attempt_trusted($1, $2, $3, $4, $5, $6)`,
    [input.provider, input.eventId, input.sessionId, input.transactionId, input.amount, input.currency],
  );
  return { outcome: rows[0].outcome, purchaseId: rows[0].purchase_id };
}

export async function failPaymentEvent(
  db: Queryable,
  input: { provider: string; eventId: string; sessionId: string; failureCode: string | null },
): Promise<{ outcome: PaymentEventOutcome; purchaseId: string | null }> {
  const rows = await runQuery<{ outcome: PaymentEventOutcome; purchase_id: string | null }>(
    db,
    `SELECT outcome, purchase_id FROM public.fail_payment_attempt_trusted($1, $2, $3, $4)`,
    [input.provider, input.eventId, input.sessionId, input.failureCode],
  );
  return { outcome: rows[0].outcome, purchaseId: rows[0].purchase_id };
}
