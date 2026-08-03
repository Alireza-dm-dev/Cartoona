import type { CouponDiscountInput, CouponDiscountResult } from "@/lib/coupons/types";
import type { CouponDiscountType } from "@/types/database";
import {
  COUPON_CODE_MAX_LENGTH,
  COUPON_CODE_MIN_LENGTH,
  COUPON_CODE_PATTERN,
  PERCENTAGE_BASIS_POINTS_MAX,
  PERCENTAGE_BASIS_POINTS_MIN,
} from "@/lib/coupons/types";

/**
 * Normalizes a raw user-entered coupon code:
 * trims surrounding whitespace and uppercases.
 * Returns "" for non-string input (never throws).
 */
export function normalizeCouponCode(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase();
}

/**
 * Validates a normalized code: safe characters only (A-Z, 0-9, hyphen,
 * underscore) and length 3-32. Does NOT include whitespace or Persian digits.
 */
export function isValidCouponCode(code: string): boolean {
  if (typeof code !== "string") return false;
  if (code.length < COUPON_CODE_MIN_LENGTH || code.length > COUPON_CODE_MAX_LENGTH) return false;
  return COUPON_CODE_PATTERN.test(code);
}

/**
 * Full code check from raw input (normalize + validate).
 */
export function isValidRawCouponCode(value: string | null | undefined): boolean {
  return isValidCouponCode(normalizeCouponCode(value));
}

export function isCouponDiscountType(value: string | null | undefined): value is CouponDiscountType {
  return value === "percentage" || value === "fixed_amount";
}

/**
 * Validates a percentage discount value expressed in integer basis points.
 * Min 1, max 10000 (10000 bps = 100%).
 */
export function isValidPercentageBasisPoints(value: number | null | undefined): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PERCENTAGE_BASIS_POINTS_MIN &&
    value <= PERCENTAGE_BASIS_POINTS_MAX
  );
}

/**
 * Validates a fixed-amount discount value: positive integer IRR.
 */
export function isValidFixedDiscountValue(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Percentage discount using integer arithmetic only (floor).
 *   discount = floor(original * basisPoints / 10000)
 * The caller guarantees 1 <= basisPoints <= 10000, so the result is never
 * negative. Result is an integer (no floating-point money).
 */
export function calculatePercentageDiscount(originalPriceAmount: number, basisPoints: number): number {
  return Math.floor((originalPriceAmount * basisPoints) / 10000);
}

/**
 * Fixed-amount discount: min(discountValue, originalPriceAmount).
 * Never exceeds the original price, so the result is never negative.
 */
export function calculateFixedDiscount(originalPriceAmount: number, discountValue: number): number {
  return Math.min(discountValue, originalPriceAmount);
}

/**
 * Computes the discount for a coupon against an original price using integer
 * arithmetic. Applies maximum_discount_amount as a cap AFTER the type-specific
 * calculation. Final = original − discount, never negative.
 */
export function calculateCouponDiscount(input: CouponDiscountInput): CouponDiscountResult {
  const rawDiscount =
    input.discountType === "percentage"
      ? calculatePercentageDiscount(input.originalPriceAmount, input.discountValue)
      : calculateFixedDiscount(input.originalPriceAmount, input.discountValue);

  const capped =
    input.maximumDiscountAmount !== null && input.maximumDiscountAmount !== undefined
      ? Math.min(rawDiscount, input.maximumDiscountAmount)
      : rawDiscount;

  const discountAmount = Math.max(0, capped);
  const finalPriceAmount = Math.max(0, input.originalPriceAmount - discountAmount);
  return { discountAmount, finalPriceAmount };
}

/**
 * Checks the optional minimum purchase amount (checked BEFORE discount).
 */
export function meetsMinimumPurchaseAmount(
  originalPriceAmount: number,
  minimumPurchaseAmount: number | null | undefined,
): boolean {
  if (minimumPurchaseAmount === null || minimumPurchaseAmount === undefined) return true;
  return originalPriceAmount >= minimumPurchaseAmount;
}

/**
 * Evaluates the date window. Returns true when the coupon may be used now.
 */
export function isWithinDateWindow(
  startsAt: string | null | undefined,
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const t = now.getTime();
  if (startsAt) {
    const start = new Date(startsAt).getTime();
    if (Number.isFinite(start) && t < start) return false;
  }
  if (expiresAt) {
    const end = new Date(expiresAt).getTime();
    if (Number.isFinite(end) && t > end) return false;
  }
  return true;
}

/**
 * Validates an idempotency key: required, 1-255 chars after trim, and not a
 * pure timestamp/number. Matches the payment-attempt idempotency conventions.
 */
export function isValidIdempotencyKey(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 255) return false;
  if (/^[0-9]+$/.test(trimmed)) return false;
  return true;
}

export const COUPON_IRR_CURRENCY = "IRR";

/**
 * Asserts the amount stays an integer IRR value and is never rescaled.
 * Throws in development if a non-integer leaks in (guards against
 * floating-point money creeping into calculations).
 */
export function assertIntegerIrAmount(value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error("Coupon amount must remain an integer IRR value.");
  }
  return value;
}
