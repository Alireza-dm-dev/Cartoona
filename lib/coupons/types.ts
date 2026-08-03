import type {
  ApplyCouponToPurchaseResult,
  CouponDiscountType,
  CouponRedemptionStatus,
  ValidateCouponForPurchaseResult,
} from "@/types/database";

export const COUPON_CODE_MIN_LENGTH = 3;
export const COUPON_CODE_MAX_LENGTH = 32;

export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]+$/;

export const PERCENTAGE_BASIS_POINTS_MIN = 1;
export const PERCENTAGE_BASIS_POINTS_MAX = 10000;

/**
 * Public, parent-facing validation result. Internal coupon_id is intentionally
 * excluded — the browser never needs it and exposing it would leak internal
 * coupon identity. The trusted DB RPC result keeps coupon_id internally.
 */
export interface CouponValidationResult {
  normalizedCode: string;
  discountType: CouponDiscountType;
  originalPriceAmount: number;
  discountAmount: number;
  finalPriceAmount: number;
  currency: string;
}

/**
 * Public, parent-facing applied-coupon result. Internal redemption_id and
 * coupon_id are intentionally excluded (see CouponValidationResult). Only safe
 * operational fields plus the redemption status are returned.
 */
export interface AppliedCouponResult {
  normalizedCode: string;
  discountType: CouponDiscountType;
  discountValue: number;
  originalPriceAmount: number;
  discountAmount: number;
  finalPriceAmount: number;
  currency: string;
  status: CouponRedemptionStatus;
}

export interface CouponDiscountInput {
  discountType: CouponDiscountType;
  discountValue: number;
  originalPriceAmount: number;
  maximumDiscountAmount: number | null;
}

export interface CouponDiscountResult {
  discountAmount: number;
  finalPriceAmount: number;
}

// Public response shapes returned by API routes (no raw DB errors, no internal
// IDs — coupon_id / redemption_id are never exposed to the parent browser).
export interface CouponValidateResponse {
  coupon: CouponValidationResult;
}

export interface CouponApplyResponse {
  coupon: AppliedCouponResult;
}

export function toCouponValidationResult(row: ValidateCouponForPurchaseResult): CouponValidationResult {
  return {
    normalizedCode: row.normalized_code,
    discountType: row.discount_type,
    originalPriceAmount: row.original_price_amount,
    discountAmount: row.discount_amount,
    finalPriceAmount: row.final_price_amount,
    currency: row.currency,
  };
}

export function toAppliedCouponResult(row: ApplyCouponToPurchaseResult): AppliedCouponResult {
  return {
    normalizedCode: row.normalized_code,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    originalPriceAmount: row.original_price_amount,
    discountAmount: row.discount_amount,
    finalPriceAmount: row.final_price_amount,
    currency: row.currency,
    status: row.status,
  };
}
