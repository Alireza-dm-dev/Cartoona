import type { AdminCouponApiErrorCode } from "@/lib/admin/coupons/types";

export interface AdminCouponRpcError {
  code: AdminCouponApiErrorCode;
  message: string;
  status: number;
}

/**
 * Maps an admin coupon trusted-RPC raised exception (message = error code) to
 * a safe Admin-facing HTTP error with a Persian message. Unknown codes fall
 * back to a generic 500 — raw database strings are never exposed.
 */
export function mapAdminCouponRpcError(message: unknown): AdminCouponRpcError {
  const code = typeof message === "string" ? message : "unknown_error";

  switch (code) {
    case "coupon_admin_forbidden":
      return { code: "COUPON_INVALID", status: 403, message: "شما مجوز انجام این عملیات را ندارید." };

    case "coupon_admin_duplicate_code":
      return { code: "COUPON_DUPLICATE_CODE", status: 409, message: "این کد تخفیف قبلاً ثبت شده است." };

    case "coupon_admin_not_found":
      return { code: "COUPON_NOT_FOUND", status: 404, message: "کد تخفیف مورد نظر یافت نشد." };

    case "coupon_admin_conflict":
      return {
        code: "COUPON_CONFLICT",
        status: 409,
        message: "این کد توسط مدیر دیگری تغییر کرده است. اطلاعات جدید را دوباره بارگذاری کنید.",
      };

    case "coupon_admin_immutable_discount":
      return {
        code: "COUPON_DISCOUNT_IMMUTABLE",
        status: 409,
        message: "این کد قبلاً استفاده شده است و امکان تغییر مبلغ یا نوع تخفیف وجود ندارد.",
      };

    case "coupon_admin_usage_limit_conflict":
      return {
        code: "COUPON_USAGE_LIMIT_CONFLICT",
        status: 409,
        message: "محدودیت جدید از تعداد استفاده‌های فعلی کمتر است.",
      };

    case "coupon_admin_invalid_package":
      return { code: "COUPON_PACKAGE_INVALID", status: 422, message: "یکی از بسته‌های انتخاب‌شده معتبر نیست." };

    case "coupon_admin_invalid":
      return { code: "COUPON_INVALID", status: 422, message: "اطلاعات کد تخفیف معتبر نیست." };

    default:
      return { code: "COUPON_UNKNOWN_ERROR", status: 500, message: "خطای داخلی سرور رخ داد." };
  }
}
