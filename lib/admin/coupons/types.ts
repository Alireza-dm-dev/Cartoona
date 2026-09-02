import type { CouponDiscountType } from "@/types/database";

// ── Admin coupon management types ────────────────────────────────────────────
// Server-safe shapes exposed by /api/admin/coupons. No parent identities, no
// redemption IDs, no raw database errors, no internal fields.

/** Derived status — computed, never stored. See deriveCouponStatus(). */
export type AdminCouponStatus = "active" | "inactive" | "scheduled" | "expired";

/** List filter values (URL query). "all" = no filter. */
export type AdminCouponStatusFilter = "all" | AdminCouponStatus;
export type AdminCouponDiscountTypeFilter = "all" | CouponDiscountType;

export interface AdminCouponListItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discountType: CouponDiscountType;
  discountValue: number;
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  status: AdminCouponStatus;
  globalUsageLimit: number | null;
  perParentUsageLimit: number | null;
  minimumPurchaseAmount: number | null;
  maximumDiscountAmount: number | null;
  /** Empty array = applies to all packages. */
  packageIds: string[];
  /** Package display names aligned with packageIds (or empty). */
  packageNames: string[];
  /** Usage counts derived from coupon_redemptions. Cancelled is not counted
   *  toward limits; kept for admin display only. */
  reservedCount: number;
  redeemedCount: number;
  cancelledCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCouponDetail extends AdminCouponListItem {
  createdBy: {
    id: string;
    email: string;
  } | null;
}

export interface AdminCouponCreateInput {
  code: string;
  name: string;
  description: string | null;
  discountType: CouponDiscountType;
  /** Percentage: integer basis points (1..10000). Fixed: integer RIAL > 0. */
  discountValue: number;
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  globalUsageLimit: number | null;
  perParentUsageLimit: number | null;
  minimumPurchaseAmount: number | null;
  maximumDiscountAmount: number | null;
  /** Empty array = applies to all packages. */
  packageIds: string[];
}

export interface AdminCouponUpdateInput extends AdminCouponCreateInput {
  /** Optimistic concurrency: exact updatedAt of the loaded coupon. */
  expectedUpdatedAt: string;
}

export interface AdminCouponPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminCouponListResponse {
  coupons: AdminCouponListItem[];
  pagination: AdminCouponPagination;
}

export interface AdminCouponCreateResponse {
  coupon: AdminCouponDetail;
}

export interface AdminCouponUpdateResponse {
  coupon: AdminCouponDetail;
}

export type AdminCouponApiErrorCode =
  | "COUPON_NOT_FOUND"
  | "COUPON_CONFLICT"
  | "COUPON_DUPLICATE_CODE"
  | "COUPON_INVALID"
  | "COUPON_DISCOUNT_IMMUTABLE"
  | "COUPON_USAGE_LIMIT_CONFLICT"
  | "COUPON_PACKAGE_INVALID"
  | "COUPON_UNKNOWN_ERROR";

export interface AdminCouponErrorResponse {
  error: string;
  code: AdminCouponApiErrorCode;
}
