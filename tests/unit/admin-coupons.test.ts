import { describe, test, expect } from "vitest";
import { deriveCouponStatus } from "@/lib/admin/coupons/status";
import {
  formatIrAmount,
  formatPercent,
  formatCount,
  discountSummary,
  maximumDiscountSummary,
  usageSummary,
  reservedSummary,
  toListItemStatus,
} from "@/lib/admin/coupons/format";
import {
  parseAdminCouponListParams,
  validateCouponInput,
  isUuid,
} from "@/lib/admin/coupons/validation";
import { mapAdminCouponRpcError } from "@/lib/admin/coupons/errors";

const NOW = new Date("2026-08-01T12:00:00.000Z");

describe("deriveCouponStatus", () => {
  test("1. inactive wins over all timing states", () => {
    expect(deriveCouponStatus(false, null, null, NOW)).toBe("inactive");
    expect(deriveCouponStatus(false, "2026-09-01T00:00:00.000Z", null, NOW)).toBe("inactive");
    expect(deriveCouponStatus(false, null, "2026-07-01T00:00:00.000Z", NOW)).toBe("inactive");
  });

  test("2. active with future start is scheduled", () => {
    expect(deriveCouponStatus(true, "2026-09-01T00:00:00.000Z", null, NOW)).toBe("scheduled");
  });

  test("3. active with past expiry is expired", () => {
    expect(deriveCouponStatus(true, null, "2026-07-01T00:00:00.000Z", NOW)).toBe("expired");
    expect(deriveCouponStatus(true, "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", NOW)).toBe("expired");
  });

  test("4. active without timing windows is active", () => {
    expect(deriveCouponStatus(true, null, null, NOW)).toBe("active");
    expect(deriveCouponStatus(true, "2026-06-01T00:00:00.000Z", null, NOW)).toBe("active");
    expect(deriveCouponStatus(true, null, "2026-09-01T00:00:00.000Z", NOW)).toBe("active");
    expect(deriveCouponStatus(true, "2026-06-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", NOW)).toBe("active");
  });

  test("5. boundary: starts exactly at now is not scheduled (strict before)", () => {
    expect(deriveCouponStatus(true, NOW.toISOString(), null, NOW)).toBe("active");
  });

  test("6. boundary: expires exactly at now is still active (strict after)", () => {
    expect(deriveCouponStatus(true, null, NOW.toISOString(), NOW)).toBe("active");
    expect(
      deriveCouponStatus(true, null, new Date(NOW.getTime() - 1).toISOString(), NOW),
    ).toBe("expired");
  });
});

describe("format helpers", () => {
  test("7. formatIrAmount renders fa-IR with Rial suffix", () => {
    expect(formatIrAmount(0)).toBe("۰ ریال");
    expect(formatIrAmount(50000)).toBe("۵۰٬۰۰۰ ریال");
    expect(formatIrAmount(1234567)).toBe("۱٬۲۳۴٬۵۶۷ ریال");
  });

  test("8. formatPercent renders basis points / 100 as percent", () => {
    expect(formatPercent(1000)).toBe("۱۰٪");
    expect(formatPercent(1250)).toBe("۱۲٫۵٪");
    expect(formatPercent(10000)).toBe("۱۰۰٪");
  });

  test("9. formatCount renders fa-IR grouping", () => {
    expect(formatCount(3)).toBe("۳");
    expect(formatCount(100)).toBe("۱۰۰");
    expect(formatCount(1234)).toBe("۱٬۲۳۴");
  });

  test("10. discountSummary handles both types", () => {
    expect(discountSummary({ discountType: "percentage", discountValue: 1000 })).toBe("۱۰٪");
    expect(discountSummary({ discountType: "fixed_amount", discountValue: 50000 })).toBe("۵۰٬۰۰۰ ریال");
  });

  test("11. maximumDiscountSummary returns null when no cap", () => {
    expect(maximumDiscountSummary({ maximumDiscountAmount: null })).toBeNull();
    expect(maximumDiscountSummary({ maximumDiscountAmount: undefined as unknown as null })).toBeNull();
  });

  test("12. maximumDiscountSummary renders cap", () => {
    expect(maximumDiscountSummary({ maximumDiscountAmount: 100000 })).toBe("حداکثر تخفیف: ۱۰۰٬۰۰۰ ریال");
  });

  test("13. usageSummary unlimited when no global limit", () => {
    expect(usageSummary({ redeemedCount: 2, globalUsageLimit: null })).toBe("استفاده قطعی: ۲ (نامحدود)");
  });

  test("14. usageSummary bounded when limit set", () => {
    expect(usageSummary({ redeemedCount: 2, globalUsageLimit: 100 })).toBe("استفاده قطعی: ۲ از ۱۰۰");
  });

  test("15. reservedSummary hidden when no reserved", () => {
    expect(reservedSummary({ reservedCount: 0 })).toBeNull();
    expect(reservedSummary({ reservedCount: 3 })).toBe("رزروشده: ۳");
  });

  test("16. toListItemStatus matches deriveCouponStatus", () => {
    expect(toListItemStatus({ isActive: true, startsAt: null, expiresAt: null }, NOW)).toBe("active");
    expect(
      toListItemStatus(
        { isActive: true, startsAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
        NOW,
      ),
    ).toBe("scheduled");
  });
});

describe("parseAdminCouponListParams", () => {
  function url(qs: string): URL {
    return new URL(`https://example.com/api/admin/coupons?${qs}`);
  }

  test("17. defaults when no query params", () => {
    const p = parseAdminCouponListParams(url(""));
    expect(p).toEqual({ search: null, status: "all", discountType: "all", page: 1, pageSize: 25 });
  });

  test("18. trims search and caps at 100 chars", () => {
    const long = "x".repeat(200);
    const p = parseAdminCouponListParams(url(`search=${long}`));
    expect(p.search).toBe("x".repeat(100));
    expect(parseAdminCouponListParams(url("search=  hello  ")).search).toBe("hello");
  });

  test("19. unknown status/discountType fall back to all", () => {
    expect(parseAdminCouponListParams(url("status=bogus")).status).toBe("all");
    expect(parseAdminCouponListParams(url("discountType=whatever")).discountType).toBe("all");
  });

  test("20. page and pageSize parsed with max clamp", () => {
    expect(parseAdminCouponListParams(url("page=3&pageSize=10")).page).toBe(3);
    expect(parseAdminCouponListParams(url("page=3&pageSize=10")).pageSize).toBe(10);
    expect(parseAdminCouponListParams(url("page=abc")).page).toBe(1);
    expect(parseAdminCouponListParams(url("pageSize=999")).pageSize).toBe(50);
  });
});

describe("isUuid", () => {
  test("21. accepts canonical uuids only", () => {
    expect(isUuid("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).toBe(true);
    expect(isUuid("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("validateCouponInput", () => {
  const base = {
    code: "SUMMER50",
    name: "تخفیف تابستان",
    description: null,
    discountType: "percentage",
    discountValue: 5000,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    globalUsageLimit: null,
    perParentUsageLimit: null,
    minimumPurchaseAmount: 0,
    maximumDiscountAmount: null,
    packageIds: [],
  };

  test("22. accepts a valid input and normalizes the code", () => {
    const res = validateCouponInput({ ...base, code: "  summer-50  " });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.code).toBe("SUMMER-50");
      expect(res.input.minimumPurchaseAmount).toBe(0);
    }
  });

  test("23. percentage discountValue is basis points (1..10000)", () => {
    expect(validateCouponInput({ ...base, discountValue: 0 }).ok).toBe(false);
    expect(validateCouponInput({ ...base, discountValue: 10001 }).ok).toBe(false);
    expect(validateCouponInput({ ...base, discountValue: 250 }).ok).toBe(true);
  });

  test("24. fixed_amount discountValue must be positive integer", () => {
    const fixed = { ...base, discountType: "fixed_amount", discountValue: 50000 };
    expect(validateCouponInput(fixed).ok).toBe(true);
    expect(validateCouponInput({ ...fixed, discountValue: 0 }).ok).toBe(false);
    expect(validateCouponInput({ ...fixed, discountValue: -5 }).ok).toBe(false);
  });

  test("25. expiresAt must be after startsAt", () => {
    const res = validateCouponInput({
      ...base,
      startsAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.expiresAt).toBeDefined();
  });

  test("26. nullable limits validated", () => {
    expect(validateCouponInput({ ...base, globalUsageLimit: 0 }).ok).toBe(false);
    expect(validateCouponInput({ ...base, perParentUsageLimit: -1 }).ok).toBe(false);
    expect(validateCouponInput({ ...base, maximumDiscountAmount: 0 }).ok).toBe(false);
    expect(validateCouponInput({ ...base, minimumPurchaseAmount: -1 }).ok).toBe(false);
    expect(validateCouponInput({ ...base, minimumPurchaseAmount: 0 }).ok).toBe(true);
  });

  test("27. packageIds must be uuid array", () => {
    const res = validateCouponInput({ ...base, packageIds: ["nope"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.packageIds).toBeDefined();
  });

  test("28. non-object body rejected", () => {
    expect(validateCouponInput("string").ok).toBe(false);
    expect(validateCouponInput(null).ok).toBe(false);
    expect(validateCouponInput([1, 2]).ok).toBe(false);
  });
});

describe("mapAdminCouponRpcError", () => {
  test("29. duplicate code maps to 409 with Persian message", () => {
    const r = mapAdminCouponRpcError("coupon_admin_duplicate_code");
    expect(r.code).toBe("COUPON_DUPLICATE_CODE");
    expect(r.status).toBe(409);
    expect(r.message).toBe("این کد تخفیف قبلاً ثبت شده است.");
  });

  test("30. conflict maps to 409 with reload message", () => {
    const r = mapAdminCouponRpcError("coupon_admin_conflict");
    expect(r.code).toBe("COUPON_CONFLICT");
    expect(r.status).toBe(409);
    expect(r.message).toContain("مدیر دیگری تغییر کرده");
  });

  test("31. usage limit conflict maps to specific message", () => {
    const r = mapAdminCouponRpcError("coupon_admin_usage_limit_conflict");
    expect(r.code).toBe("COUPON_USAGE_LIMIT_CONFLICT");
    expect(r.message).toBe("محدودیت جدید از تعداد استفاده‌های فعلی کمتر است.");
  });

  test("32. not found maps to 404", () => {
    const r = mapAdminCouponRpcError("coupon_admin_not_found");
    expect(r.code).toBe("COUPON_NOT_FOUND");
    expect(r.status).toBe(404);
  });

  test("33. unknown messages map to generic 500 without leaking", () => {
    const r = mapAdminCouponRpcError("fatal database stack trace");
    expect(r.code).toBe("COUPON_UNKNOWN_ERROR");
    expect(r.status).toBe(500);
    expect(r.message).toContain("خطای داخلی");
  });
});
