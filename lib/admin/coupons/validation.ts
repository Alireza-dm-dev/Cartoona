import {
  normalizeCouponCode,
  isValidCouponCode,
  isCouponDiscountType,
  isValidPercentageBasisPoints,
  isValidFixedDiscountValue,
} from "@/lib/coupons/rules";
import type {
  AdminCouponCreateInput,
  AdminCouponDiscountTypeFilter,
  AdminCouponStatusFilter,
} from "@/lib/admin/coupons/types";
import type { CouponDiscountType } from "@/types/database";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;
export const MAX_SEARCH_LENGTH = 100;

export const COUPON_NAME_MAX_LENGTH = 120;
export const COUPON_DESCRIPTION_MAX_LENGTH = 1000;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value.trim());
}

// ── List query parameter parsing ─────────────────────────────────────────────

export interface ParsedAdminCouponListParams {
  search: string | null;
  status: AdminCouponStatusFilter;
  discountType: AdminCouponDiscountTypeFilter;
  page: number;
  pageSize: number;
}

function firstString(value: string | null): string | null {
  return value;
}

function isStatusFilter(value: string | null): value is AdminCouponStatusFilter {
  return (
    value === "all" ||
    value === "active" ||
    value === "inactive" ||
    value === "scheduled" ||
    value === "expired"
  );
}

function isDiscountTypeFilter(value: string | null): value is AdminCouponDiscountTypeFilter {
  return value === "all" || value === "percentage" || value === "fixed_amount";
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export function parseAdminCouponListParams(url: URL): ParsedAdminCouponListParams {
  const rawSearch = firstString(url.searchParams.get("search"));
  const search = rawSearch ? rawSearch.trim().slice(0, MAX_SEARCH_LENGTH) : null;

  const rawStatus = firstString(url.searchParams.get("status"));
  const status: AdminCouponStatusFilter = isStatusFilter(rawStatus) ? rawStatus : "all";

  const rawDiscount = firstString(url.searchParams.get("discountType"));
  const discountType: AdminCouponDiscountTypeFilter = isDiscountTypeFilter(rawDiscount)
    ? rawDiscount
    : "all";

  const page = parsePositiveInt(firstString(url.searchParams.get("page")), 1);
  const pageSize = Math.min(
    parsePositiveInt(firstString(url.searchParams.get("pageSize")), DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  return { search, status, discountType, page, pageSize };
}

// ── Create / update validation ───────────────────────────────────────────────
// Field-level errors keyed by field name. Mirrors the DB CHECK constraints so
// the server can return specific Persian messages before calling the RPC.

export interface AdminCouponFieldErrors {
  code?: string;
  name?: string;
  description?: string;
  discountType?: string;
  discountValue?: string;
  startsAt?: string;
  expiresAt?: string;
  globalUsageLimit?: string;
  perParentUsageLimit?: string;
  minimumPurchaseAmount?: string;
  maximumDiscountAmount?: string;
  packageIds?: string;
}

export function validateCouponCode(code: string): string | null {
  const normalized = normalizeCouponCode(code);
  if (!isValidCouponCode(normalized)) {
    return "فرمت کد تخفیف معتبر نیست.";
  }
  return null;
}

export function normalizeAdminCouponCode(code: string): string {
  return normalizeCouponCode(code);
}

function isNullablePositiveInt(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNullableNonNegativeInt(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseIsoDate(value: unknown): { ok: boolean; iso: string | null } {
  if (value === null) return { ok: true, iso: null };
  if (typeof value !== "string") return { ok: false, iso: null };
  const ts = new Date(value);
  if (isNaN(ts.getTime())) return { ok: false, iso: null };
  return { ok: true, iso: ts.toISOString() };
}

/**
 * Validates a coupon create/update body. Returns either the field errors or a
 * normalized AdminCouponCreateInput ready to pass to the trusted RPC.
 */
export function validateCouponInput(body: unknown): {
  ok: true;
  input: AdminCouponCreateInput;
} | {
  ok: false;
  errors: AdminCouponFieldErrors;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: { code: "درخواست نامعتبر است." } };
  }

  const b = body as Record<string, unknown>;
  const errors: AdminCouponFieldErrors = {};

  // code
  const code = typeof b.code === "string" ? normalizeAdminCouponCode(b.code) : "";
  const codeError = validateCouponCode(code || "");
  if (codeError) errors.code = codeError;

  // name
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) {
    errors.name = "نام داخلی الزامی است.";
  } else if (name.length > COUPON_NAME_MAX_LENGTH) {
    errors.name = `نام داخلی حداکثر ${COUPON_NAME_MAX_LENGTH} کاراکتر می‌تواند باشد.`;
  }

  // description
  const description =
    typeof b.description === "string" ? b.description.trim() : null;
  if (
    description !== null &&
    description.length > COUPON_DESCRIPTION_MAX_LENGTH
  ) {
    errors.description = `توضیحات حداکثر ${COUPON_DESCRIPTION_MAX_LENGTH} کاراکتر می‌تواند باشد.`;
  }

  // discountType
  const discountTypeValue: unknown = b.discountType;
  const discountType = typeof discountTypeValue === "string" ? discountTypeValue : null;
  if (!isCouponDiscountType(discountType)) {
    errors.discountType = "نوع تخفیف معتبر نیست.";
  }

  // discountValue
  const discountValue: number | null =
    typeof b.discountValue === "number" ? b.discountValue : null;
  if (discountType === "percentage") {
    if (!isValidPercentageBasisPoints(discountValue)) {
      errors.discountValue = "درصد تخفیف باید بیشتر از صفر و حداکثر ۱۰۰ باشد.";
    }
  } else if (discountType === "fixed_amount") {
    if (!isValidFixedDiscountValue(discountValue)) {
      errors.discountValue = "مبلغ تخفیف باید بیشتر از صفر باشد.";
    }
  }

  // dates
  const startsAt = parseIsoDate(b.startsAt);
  const expiresAt = parseIsoDate(b.expiresAt);
  if (!startsAt.ok) errors.startsAt = "تاریخ شروع معتبر نیست.";
  if (!expiresAt.ok) errors.expiresAt = "تاریخ پایان معتبر نیست.";
  if (
    startsAt.ok &&
    expiresAt.ok &&
    startsAt.iso &&
    expiresAt.iso &&
    new Date(expiresAt.iso) <= new Date(startsAt.iso)
  ) {
    errors.expiresAt = "تاریخ پایان باید بعد از تاریخ شروع باشد.";
  }

  // limits
  if (!isNullablePositiveInt(b.globalUsageLimit)) {
    errors.globalUsageLimit = "حداکثر استفاده کلی باید عددی بزرگ‌تر از صفر باشد.";
  }
  if (!isNullablePositiveInt(b.perParentUsageLimit)) {
    errors.perParentUsageLimit = "حداکثر استفاده برای هر والد باید عددی بزرگ‌تر از صفر باشد.";
  }
  if (!isNullableNonNegativeInt(b.minimumPurchaseAmount)) {
    errors.minimumPurchaseAmount = "حداقل مبلغ خرید باید عددی نامنفی باشد.";
  }
  if (!isNullablePositiveInt(b.maximumDiscountAmount)) {
    errors.maximumDiscountAmount = "حداکثر مبلغ تخفیف باید عددی بزرگ‌تر از صفر باشد.";
  }

  // packageIds
  if (!Array.isArray(b.packageIds)) {
    errors.packageIds = "بسته‌های انتخابی معتبر نیستند.";
  } else if (b.packageIds.some((p) => !isUuid(p))) {
    errors.packageIds = "یکی از بسته‌های انتخاب‌شده معتبر نیست.";
  }

  const hasErrors = Object.keys(errors).length > 0;
  if (hasErrors) return { ok: false, errors };

  return {
    ok: true,
    input: {
      code,
      name,
      description,
      discountType: discountType as CouponDiscountType,
      discountValue: discountValue as number,
      isActive: b.isActive === true,
      startsAt: startsAt.iso,
      expiresAt: expiresAt.iso,
      globalUsageLimit: b.globalUsageLimit === null ? null : (b.globalUsageLimit as number),
      perParentUsageLimit: b.perParentUsageLimit === null ? null : (b.perParentUsageLimit as number),
      minimumPurchaseAmount:
        b.minimumPurchaseAmount === null ? null : (b.minimumPurchaseAmount as number),
      maximumDiscountAmount:
        b.maximumDiscountAmount === null ? null : (b.maximumDiscountAmount as number),
      packageIds: (b.packageIds as unknown[]).filter(isUuid),
    },
  };
}
