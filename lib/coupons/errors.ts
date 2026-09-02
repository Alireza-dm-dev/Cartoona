import type { CouponErrorCode } from "@/types/database";

export interface CouponApiError {
  code: string;
  message: string;
  status: number;
}

const SAFE_INVALID_CODE_MESSAGE = "این کد تخفیف معتبر نیست.";

/**
 * Maps a trusted-RPC error (raised exception message + hint) to a safe,
 * parent-facing HTTP error. Unknown/inactive/not-started/expired/invalid
 * coupon codes ALL return the same non-enumerating message to prevent
 * coupon enumeration. No raw database error strings are ever exposed.
 */
export function mapCouponRpcError(message: unknown): CouponApiError {
  const code = typeof message === "string" ? message : "unknown_error";

  switch (code) {
    case "coupon_parent_required":
    case "coupon_purchase_required":
    case "coupon_code_invalid":
      return { code, status: 400, message: "درخواست نامعتبر است." };

    case "coupon_purchase_not_found":
      return { code, status: 404, message: "خرید مورد نظر یافت نشد." };

    case "coupon_purchase_not_owner":
      return { code, status: 403, message: "این خرید متعلق به شما نیست." };

    case "coupon_purchase_not_pending":
      return { code, status: 409, message: "این خرید در وضعیت قابل تغییر نیست." };

    case "coupon_purchase_has_payment_attempt":
      return { code, status: 409, message: "برای این خرید فرایند پرداخت آغاز شده است." };

    case "coupon_already_applied":
      return { code, status: 409, message: "برای این خرید یک کد تخفیف اعمال شده است." };

    case "coupon_not_found":
    case "coupon_inactive":
    case "coupon_not_started":
    case "coupon_expired":
      // Non-enumerating: same safe message for all invalid/inactive states.
      return { code, status: 400, message: SAFE_INVALID_CODE_MESSAGE };

    case "coupon_usage_limit_reached":
    case "coupon_parent_limit_reached":
      return { code, status: 409, message: "سقف استفاده از این کد تخفیف تکمیل شده است." };

    case "coupon_package_not_eligible":
      return { code, status: 409, message: "این کد تخفیف برای بسته انتخابی معتبر نیست." };

    case "coupon_minimum_not_met":
      return { code, status: 409, message: "حداقل مبلغ خرید برای این کد تخفیف برآورده نشده است." };

    case "coupon_zero_discount":
      return { code, status: 409, message: "این کد تخفیف برای این مبلغ تخفیفی ایجاد نمی‌کند." };

    case "coupon_idempotency_required":
    case "coupon_idempotency_too_long":
      return { code, status: 400, message: "درخواست نامعتبر است." };

    default:
      // Fallback: still hide any raw database detail. hintText is never rendered.
      return { code: "unknown_error", status: 500, message: "خطا در اعمال کد تخفیف." };
  }
}

/**
 * Optional: derive a short stable code for client-side branching (not shown to
 * the user). Always falls back to a safe generic code.
 */
export function toPublicErrorCode(code: CouponErrorCode | "unknown_error"): string {
  if (code === "unknown_error") return "COUPON_UNKNOWN_ERROR";
  return code.toUpperCase();
}
