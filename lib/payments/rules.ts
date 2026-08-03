import type { DbPaymentAttempt } from "@/types/database";
import type {
  PaymentAttemptStatusLabel,
  PaymentAttemptSummary,
  PaymentAttemptTerminalStatus,
} from "@/lib/payments/types";

const ATTEMPT_STATUS_SET: ReadonlySet<string> = new Set([
  "created",
  "awaiting_payment",
  "processing",
  "verified",
  "failed",
  "cancelled",
  "expired",
]);

const TERMINAL_ATTEMPT_STATUS: readonly PaymentAttemptTerminalStatus[] = [
  "verified",
  "failed",
  "cancelled",
  "expired",
];

export function isPaymentAttemptStatus(value: string | null | undefined): value is PaymentAttemptStatusLabel {
  return typeof value === "string" && ATTEMPT_STATUS_SET.has(value);
}

export function isTerminalAttemptStatus(status: PaymentAttemptStatusLabel): status is PaymentAttemptTerminalStatus {
  return (TERMINAL_ATTEMPT_STATUS as readonly string[]).includes(status);
}

export function canCreateAttemptForPurchaseStatus(purchaseStatus: string): boolean {
  return purchaseStatus === "pending" || purchaseStatus === "failed" || purchaseStatus === "expired";
}

export function amountsMatchForVerification(
  requestedAmount: number,
  requestedCurrency: string,
  verifiedAmount: number | null,
  verifiedCurrency: string | null,
): boolean {
  if (verifiedAmount === null || verifiedCurrency === null) return false;
  return requestedAmount === verifiedAmount && requestedCurrency === verifiedCurrency;
}

/**
 * The amount a payment attempt must charge for a purchase: the FINAL payable
 * amount (after any coupon discount). Falls back to price_amount only when the
 * final field is unavailable (defensive, never the authority).
 * Coupons must be applied BEFORE a payment attempt/session is created; once a
 * payment attempt exists the purchase's active_payment_attempt_id is set and
 * coupon changes are rejected by the trusted apply RPC.
 */
export function payableAmountForPurchase(purchase: {
  final_price_amount: number;
  price_amount: number;
}): number {
  const final = purchase.final_price_amount;
  if (typeof final === "number" && Number.isFinite(final) && final >= 0) return final;
  return purchase.price_amount;
}

/**
 * A coupon may not be applied (or changed) once a payment attempt exists.
 * The trusted coupon apply RPC enforces this at the database level; this pure
 * helper exists for the server-side guard and unit tests.
 */
export function canApplyCouponToPurchase(purchase: {
  status: string;
  active_payment_attempt_id: string | null;
}): boolean {
  return purchase.status === "pending" && purchase.active_payment_attempt_id === null;
}

export function isValidIdempotencyKey(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 255) return false;
  if (/^[0-9]+$/.test(trimmed)) return false;
  return true;
}

const SAFE_FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,50}$/;

export function isSafeFailureCode(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return SAFE_FAILURE_CODE_PATTERN.test(value);
}

export function toPaymentAttemptSummary(attempt: DbPaymentAttempt): PaymentAttemptSummary {
  return {
    id: attempt.id,
    purchaseId: attempt.purchase_id,
    provider: attempt.provider === "zarinpal" || attempt.provider === "nextpay" ? attempt.provider : "unknown",
    status: attempt.status,
    attemptNumber: attempt.attempt_number,
    requestedAmount: attempt.requested_amount,
    requestedCurrency: attempt.requested_currency,
    verifiedAmount: attempt.verified_amount,
    verifiedCurrency: attempt.verified_currency,
    createdAt: attempt.created_at,
    completedAt: attempt.completed_at,
  };
}
