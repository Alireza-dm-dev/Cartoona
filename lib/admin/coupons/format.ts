import type { AdminCouponListItem, AdminCouponStatus } from "@/lib/admin/coupons/types";
import { deriveCouponStatus } from "@/lib/admin/coupons/status";
import type { CouponDiscountType } from "@/types/database";

// ── Persian / fa-IR formatting helpers ───────────────────────────────────────
// All amounts are integer RIAL (IRR) — never converted to toman, never floats.

const numberFormatter = new Intl.NumberFormat("fa-IR");
const percentFormatter = new Intl.NumberFormat("fa-IR", {
  maximumFractionDigits: 1,
});

export function formatIrAmount(value: number): string {
  return `${numberFormatter.format(value)} ریال`;
}

export function formatPercent(basisPoints: number): string {
  return `${percentFormatter.format(basisPoints / 100)}٪`;
}

export function formatCount(value: number): string {
  return numberFormatter.format(value);
}

export const discountTypeLabels: Record<CouponDiscountType, string> = {
  percentage: "درصدی",
  fixed_amount: "مبلغ ثابت",
};

export const statusLabels: Record<AdminCouponStatus, string> = {
  active: "فعال",
  inactive: "غیرفعال",
  scheduled: "زمان‌بندی‌شده",
  expired: "منقضی‌شده",
};

export const statusVariants: Record<AdminCouponStatus, "success" | "default" | "warning" | "danger"> = {
  active: "success",
  inactive: "default",
  scheduled: "warning",
  expired: "danger",
};

/** "۱۰٪" for percentage (1000 bps), "۵۰٬۰۰۰ ریال" for fixed. */
export function discountSummary(coupon: {
  discountType: CouponDiscountType;
  discountValue: number;
}): string {
  if (coupon.discountType === "percentage") {
    return formatPercent(coupon.discountValue);
  }
  return formatIrAmount(coupon.discountValue);
}

/** Secondary line: «حداکثر تخفیف: ...» when a cap is set. */
export function maximumDiscountSummary(coupon: { maximumDiscountAmount: number | null }): string | null {
  if (coupon.maximumDiscountAmount === null || coupon.maximumDiscountAmount === undefined) {
    return null;
  }
  return `حداکثر تخفیف: ${formatIrAmount(coupon.maximumDiscountAmount)}`;
}

/**
 * «استفاده قطعی: ۲ از ۱۰۰» — redeemedCount of the limit. «نامحدود» when no
 * limit. Cancelled redemptions are never counted toward limits.
 */
export function usageSummary(coupon: {
  redeemedCount: number;
  globalUsageLimit: number | null;
}): string {
  const used = formatCount(coupon.redeemedCount);
  if (coupon.globalUsageLimit === null || coupon.globalUsageLimit === undefined) {
    return `استفاده قطعی: ${used} (نامحدود)`;
  }
  return `استفاده قطعی: ${used} از ${formatCount(coupon.globalUsageLimit)}`;
}

/** Optional «رزروشده: ۳» line shown only when reserved redemptions exist. */
export function reservedSummary(coupon: { reservedCount: number }): string | null {
  if (coupon.reservedCount > 0) {
    return `رزروشده: ${formatCount(coupon.reservedCount)}`;
  }
  return null;
}

/** Convenience wrapper computing the derived status for a list/detail item. */
export function couponStatus(coupon: {
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
}, now: Date = new Date()): AdminCouponStatus {
  return deriveCouponStatus(coupon.isActive, coupon.startsAt, coupon.expiresAt, now);
}

export function toListItemStatus(
  coupon: Pick<AdminCouponListItem, "isActive" | "startsAt" | "expiresAt">,
  now: Date = new Date(),
): AdminCouponStatus {
  return deriveCouponStatus(coupon.isActive, coupon.startsAt, coupon.expiresAt, now);
}
