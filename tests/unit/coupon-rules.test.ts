import { describe, test, expect } from "vitest";
import {
  normalizeCouponCode,
  isValidCouponCode,
  isValidRawCouponCode,
  isCouponDiscountType,
  isValidPercentageBasisPoints,
  isValidFixedDiscountValue,
  calculatePercentageDiscount,
  calculateCouponDiscount,
  meetsMinimumPurchaseAmount,
  isWithinDateWindow,
  isValidIdempotencyKey,
  assertIntegerIrAmount,
} from "@/lib/coupons/rules";
import { mapCouponRpcError } from "@/lib/coupons/errors";
import { toCouponValidationResult, toAppliedCouponResult } from "@/lib/coupons/types";
import { payableAmountForPurchase, canApplyCouponToPurchase } from "@/lib/payments/rules";

describe("coupon code normalization", () => {
  test("1. uppercases code", () => {
    expect(normalizeCouponCode("welcome10")).toBe("WELCOME10");
    expect(normalizeCouponCode("Summer-20")).toBe("SUMMER-20");
  });

  test("2. trims surrounding whitespace", () => {
    expect(normalizeCouponCode("  VIP_2026  ")).toBe("VIP_2026");
    expect(normalizeCouponCode("  WELCOME10\t")).toBe("WELCOME10");
  });

  test("3. rejects invalid characters", () => {
    expect(isValidCouponCode("HELLO WORLD")).toBe(false);
    expect(isValidCouponCode("HELLO/WORLD")).toBe(false);
    expect(isValidCouponCode("HELLO.WORLD")).toBe(false);
    expect(isValidCouponCode("HELLO!")).toBe(false);
    expect(isValidCouponCode("ABCD%")).toBe(false);
    expect(isValidCouponCode("۱۲۳۴۵")).toBe(false); // Persian digits
    expect(isValidCouponCode("A B C")).toBe(false);
  });

  test("4. rejects too-short code", () => {
    expect(isValidCouponCode("AB")).toBe(false);
    expect(isValidCouponCode("")).toBe(false);
  });

  test("5. rejects too-long code", () => {
    expect(isValidCouponCode("A".repeat(33))).toBe(false);
    expect(isValidCouponCode("A".repeat(100))).toBe(false);
  });

  test("accepts valid safe-character codes", () => {
    expect(isValidCouponCode("WELCOME10")).toBe(true);
    expect(isValidCouponCode("SUMMER-20")).toBe(true);
    expect(isValidCouponCode("VIP_2026")).toBe(true);
    expect(isValidRawCouponCode(" welcome10 ")).toBe(true);
    expect(isValidRawCouponCode(null)).toBe(false);
  });
});

describe("coupon discount-value validation", () => {
  test("6. percentage basis points validation", () => {
    expect(isValidPercentageBasisPoints(1)).toBe(true);
    expect(isValidPercentageBasisPoints(1000)).toBe(true);
    expect(isValidPercentageBasisPoints(10000)).toBe(true);
    expect(isValidPercentageBasisPoints(0)).toBe(false);
    expect(isValidPercentageBasisPoints(10001)).toBe(false);
    expect(isValidPercentageBasisPoints(1000.5)).toBe(false);
    expect(isValidPercentageBasisPoints(null)).toBe(false);
  });

  test("7. fixed discount validation", () => {
    expect(isValidFixedDiscountValue(1)).toBe(true);
    expect(isValidFixedDiscountValue(50000)).toBe(true);
    expect(isValidFixedDiscountValue(0)).toBe(false);
    expect(isValidFixedDiscountValue(-5)).toBe(false);
    expect(isValidFixedDiscountValue(10.5)).toBe(false);
  });

  test("isCouponDiscountType guards the union", () => {
    expect(isCouponDiscountType("percentage")).toBe(true);
    expect(isCouponDiscountType("fixed_amount")).toBe(true);
    expect(isCouponDiscountType("bogo")).toBe(false);
    expect(isCouponDiscountType(null)).toBe(false);
  });
});

describe("discount calculation — integer arithmetic only", () => {
  test("8. 10% discount = 10% of original", () => {
    const result = calculateCouponDiscount({
      discountType: "percentage",
      discountValue: 1000,
      originalPriceAmount: 50000,
      maximumDiscountAmount: null,
    });
    expect(result.discountAmount).toBe(5000);
    expect(result.finalPriceAmount).toBe(45000);
  });

  test("9. percentage rounding is floor", () => {
    // 135000 * 1000 / 10000 = 13500 exactly; use a case that floors:
    // 100000 * 333 / 10000 = 3330.0 ; 100000 * 334 / 10000 = 3340.0
    // Force a remainder: 100003 * 1000 / 10000 = 10000.3 -> floor 10000
    expect(calculatePercentageDiscount(100003, 1000)).toBe(10000);
    expect(calculateCouponDiscount({
      discountType: "percentage",
      discountValue: 1000,
      originalPriceAmount: 100003,
      maximumDiscountAmount: null,
    }).discountAmount).toBe(10000);
  });

  test("10. maximum discount cap applies after percentage", () => {
    const result = calculateCouponDiscount({
      discountType: "percentage",
      discountValue: 2000, // 20%
      originalPriceAmount: 135000, // raw 27000
      maximumDiscountAmount: 20000,
    });
    expect(result.discountAmount).toBe(20000);
    expect(result.finalPriceAmount).toBe(115000);
  });

  test("11. fixed discount below price", () => {
    const result = calculateCouponDiscount({
      discountType: "fixed_amount",
      discountValue: 10000,
      originalPriceAmount: 50000,
      maximumDiscountAmount: null,
    });
    expect(result.discountAmount).toBe(10000);
    expect(result.finalPriceAmount).toBe(40000);
  });

  test("12. fixed discount above price clamps to price", () => {
    const result = calculateCouponDiscount({
      discountType: "fixed_amount",
      discountValue: 90000,
      originalPriceAmount: 50000,
      maximumDiscountAmount: null,
    });
    expect(result.discountAmount).toBe(50000);
    expect(result.finalPriceAmount).toBe(0);
  });

  test("13. final amount never negative", () => {
    const result = calculateCouponDiscount({
      discountType: "percentage",
      discountValue: 10000, // 100%
      originalPriceAmount: 50000,
      maximumDiscountAmount: null,
    });
    expect(result.discountAmount).toBe(50000);
    expect(result.finalPriceAmount).toBe(0);
  });
});

describe("minimum purchase and dates", () => {
  test("14. minimum purchase validation", () => {
    expect(meetsMinimumPurchaseAmount(50000, 30000)).toBe(true);
    expect(meetsMinimumPurchaseAmount(30000, 30000)).toBe(true);
    expect(meetsMinimumPurchaseAmount(29999, 30000)).toBe(false);
    expect(meetsMinimumPurchaseAmount(50000, null)).toBe(true);
    expect(meetsMinimumPurchaseAmount(50000, undefined)).toBe(true);
  });

  test("15. date-window validation", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    expect(isWithinDateWindow(null, null, now)).toBe(true);
    expect(isWithinDateWindow("2026-08-01T00:00:00Z", null, now)).toBe(true);
    expect(isWithinDateWindow(null, "2026-08-02T00:00:00Z", now)).toBe(true);
    expect(isWithinDateWindow("2026-08-02T00:00:00Z", null, now)).toBe(false);
    expect(isWithinDateWindow(null, "2026-07-31T00:00:00Z", now)).toBe(false);
    expect(isWithinDateWindow("2026-07-01T00:00:00Z", "2026-08-01T13:00:00Z", now)).toBe(true);
  });
});

describe("error mapping and idempotency", () => {
  test("16. usage-limit result mapping", () => {
    const err = mapCouponRpcError("coupon_usage_limit_reached");
    expect(err.status).toBe(409);
    expect(err.message).toContain("سقف استفاده");
  });

  test("17. package-eligibility result mapping", () => {
    const err = mapCouponRpcError("coupon_package_not_eligible");
    expect(err.status).toBe(409);
    expect(err.message).toContain("بسته");
  });

  test("18. safe public error mapping for purchase errors", () => {
    expect(mapCouponRpcError("coupon_purchase_not_owner").status).toBe(403);
    expect(mapCouponRpcError("coupon_purchase_not_found").status).toBe(404);
    expect(mapCouponRpcError("coupon_already_applied").status).toBe(409);
  });

  test("19. unknown/inactive coupon uses non-enumerating message", () => {
    const messages = new Set(
      ["coupon_not_found", "coupon_inactive", "coupon_not_started", "coupon_expired"].map((c) => {
        return mapCouponRpcError(c).message;
      }),
    );
    expect(messages.size).toBe(1);
    expect(messages.has("این کد تخفیف معتبر نیست.")).toBe(true);
  });

  test("20. idempotency-key validation", () => {
    expect(isValidIdempotencyKey("apply-1")).toBe(true);
    expect(isValidIdempotencyKey(" apply-1 ")).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("   ")).toBe(false);
    expect(isValidIdempotencyKey("123456789")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(256))).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });

  test("21. public serialization excludes raw DB error strings and internal IDs", () => {
    const validation = toCouponValidationResult({
      coupon_id: "c1",
      normalized_code: "WELCOME10",
      discount_type: "percentage",
      original_price_amount: 50000,
      discount_amount: 5000,
      final_price_amount: 45000,
      currency: "IRR",
    });
    expect(validation.normalizedCode).toBe("WELCOME10");
    expect(JSON.stringify(validation)).not.toContain("couponId");
    expect(JSON.stringify(validation)).not.toContain("redemptionId");
    expect(JSON.stringify(validation)).not.toContain("p_");
    expect(JSON.stringify(validation)).not.toContain("rpc");

    const applied = toAppliedCouponResult({
      redemption_id: "r1",
      coupon_id: "c1",
      normalized_code: "VIP_2026",
      discount_type: "fixed_amount",
      discount_value: 10000,
      original_price_amount: 50000,
      discount_amount: 10000,
      final_price_amount: 40000,
      currency: "IRR",
      status: "reserved",
    });
    expect(applied.normalizedCode).toBe("VIP_2026");
    expect(applied.status).toBe("reserved");
    expect(JSON.stringify(applied)).not.toContain("couponId");
    expect(JSON.stringify(applied)).not.toContain("redemptionId");
    expect(JSON.stringify(applied)).not.toContain("p_");
  });

  test("22. IRR amounts remain integers", () => {
    expect(assertIntegerIrAmount(50000)).toBe(50000);
    expect(() => assertIntegerIrAmount(50000.5)).toThrow();
    expect(() => assertIntegerIrAmount(NaN)).toThrow();
  });

  test("23. no Rial/Toman conversion occurs", () => {
    const result = calculateCouponDiscount({
      discountType: "percentage",
      discountValue: 1000,
      originalPriceAmount: 50000,
      maximumDiscountAmount: null,
    });
    // Still in Rials (IRR) — never rescaled by 10 (toman) or any factor.
    expect(result.discountAmount).toBe(5000);
    expect(result.finalPriceAmount).toBe(45000);
    expect(Number.isInteger(result.finalPriceAmount)).toBe(true);
  });
});

describe("payment-attempt compatibility", () => {
  test("24. payment attempt must use the final price", () => {
    expect(payableAmountForPurchase({ final_price_amount: 45000, price_amount: 50000 })).toBe(45000);
    expect(payableAmountForPurchase({ final_price_amount: 0, price_amount: 50000 })).toBe(0);
    expect(payableAmountForPurchase({ final_price_amount: -1, price_amount: 50000 })).toBe(50000);
  });

  test("coupon apply blocked once a payment attempt exists", () => {
    expect(canApplyCouponToPurchase({ status: "pending", active_payment_attempt_id: null })).toBe(true);
    expect(canApplyCouponToPurchase({ status: "pending", active_payment_attempt_id: "x" })).toBe(false);
    expect(canApplyCouponToPurchase({ status: "paid", active_payment_attempt_id: null })).toBe(false);
    expect(canApplyCouponToPurchase({ status: "cancelled", active_payment_attempt_id: null })).toBe(false);
  });
});
