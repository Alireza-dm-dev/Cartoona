import type { AdminCouponStatus } from "@/lib/admin/coupons/types";

/**
 * Derives the display status of a coupon from its stored state. Never stored.
 *
 *  inactive   — is_active = false (admin toggle) takes priority.
 *  scheduled  — active and starts_at is in the future.
 *  expired    — active and expires_at has passed.
 *  active     — active, started, and not expired.
 */
export function deriveCouponStatus(
  isActive: boolean,
  startsAt: string | null | undefined,
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): AdminCouponStatus {
  if (!isActive) return "inactive";
  const t = now.getTime();
  if (startsAt) {
    const start = new Date(startsAt).getTime();
    if (Number.isFinite(start) && t < start) return "scheduled";
  }
  if (expiresAt) {
    const end = new Date(expiresAt).getTime();
    if (Number.isFinite(end) && t > end) return "expired";
  }
  return "active";
}
