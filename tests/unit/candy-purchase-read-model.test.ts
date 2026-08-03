import { describe, test, expect } from "vitest";
import {
  toParentCandyPurchaseSummary,
  type PurchaseReadModelRow,
  type ParentCandyPurchaseSummary,
} from "@/lib/candy-purchases/types";

function baseRow(overrides: Partial<PurchaseReadModelRow> = {}): PurchaseReadModelRow {
  return {
    id: "pur-1",
    candy_amount: 300,
    price_amount: 135000,
    original_price_amount: 135000,
    discount_amount: 0,
    final_price_amount: 135000,
    currency: "IRR",
    status: "pending",
    created_at: "2026-07-29T14:00:00Z",
    paid_at: null,
    coupon_code_snapshot: null,
    coupon_status: null,
    coupon_name: null,
    payment_started: false,
    ...overrides,
  };
}

describe("purchase read-model serialization", () => {
  test("1. plain purchase serializes pricing and no coupon/payment state", () => {
    const s: ParentCandyPurchaseSummary = toParentCandyPurchaseSummary(baseRow(), "استارتر");
    expect(s.priceAmount).toBe(135000);
    expect(s.originalPriceAmount).toBe(135000);
    expect(s.discountAmount).toBe(0);
    expect(s.finalPriceAmount).toBe(135000);
    expect(s.couponApplied).toBe(false);
    expect(s.couponCodeSnapshot).toBeNull();
    expect(s.couponName).toBeNull();
    expect(s.couponStatus).toBeNull();
    expect(s.paymentStarted).toBe(false);
  });

  test("2. applied coupon (reserved) sets couponApplied true and snapshots", () => {
    const s = toParentCandyPurchaseSummary(
      baseRow({
        original_price_amount: 135000,
        discount_amount: 13500,
        final_price_amount: 121500,
        coupon_code_snapshot: "WELCOME10",
        coupon_status: "reserved",
        coupon_name: "تخفیف خوشآمد",
      }),
      "رشد",
    );
    expect(s.couponApplied).toBe(true);
    expect(s.couponCodeSnapshot).toBe("WELCOME10");
    expect(s.couponName).toBe("تخفیف خوشآمد");
    expect(s.couponStatus).toBe("reserved");
    expect(s.discountAmount).toBe(13500);
    expect(s.finalPriceAmount).toBe(121500);
  });

  test("3. redeemed coupon keeps couponApplied true", () => {
    const s = toParentCandyPurchaseSummary(
      baseRow({ coupon_code_snapshot: "VIP_2026", coupon_status: "redeemed" }),
      "ممتاز",
    );
    expect(s.couponApplied).toBe(true);
    expect(s.couponStatus).toBe("redeemed");
  });

  test("4. cancelled redemption is not couponApplied", () => {
    const s = toParentCandyPurchaseSummary(
      baseRow({ coupon_code_snapshot: "OLDCODE", coupon_status: "cancelled" }),
      "استارتر",
    );
    expect(s.couponApplied).toBe(false);
    expect(s.couponStatus).toBe("cancelled");
  });

  test("5. paymentStarted reflects payment-attempt existence only", () => {
    const withAttempt = toParentCandyPurchaseSummary(baseRow({ payment_started: true }), "رشد");
    expect(withAttempt.paymentStarted).toBe(true);
    const withoutAttempt = toParentCandyPurchaseSummary(baseRow({ payment_started: false }), "رشد");
    expect(withoutAttempt.paymentStarted).toBe(false);
  });

  test("6. expired status is preserved", () => {
    const s = toParentCandyPurchaseSummary(baseRow({ status: "expired", paid_at: null }), "استارتر");
    expect(s.status).toBe("expired");
  });

  test("7. serialized JSON never exposes internal IDs or DB-only fields", () => {
    const s = toParentCandyPurchaseSummary(
      baseRow({
        coupon_code_snapshot: "WELCOME10",
        coupon_status: "reserved",
        payment_started: true,
      }),
      "رشد",
    );
    const json = JSON.stringify(s);
    expect(json).not.toContain("couponId");
    expect(json).not.toContain("coupon_id");
    expect(json).not.toContain("redemptionId");
    expect(json).not.toContain("paymentAttemptId");
    expect(json).not.toContain("active_payment_attempt_id");
    expect(json).not.toContain("parent_id");
    expect(json).not.toContain("walletId");
    expect(json).not.toContain("provider_session");
    expect(json).not.toContain("checkout_url");
  });

  test("8. discount of zero does NOT imply couponApplied (authoritative redemption)", () => {
    // A valid applied coupon could theoretically produce a zero rounded
    // discount; couponApplied must come from the redemption relationship.
    const zeroDiscountApplied = toParentCandyPurchaseSummary(
      baseRow({
        discount_amount: 0,
        final_price_amount: 135000,
        coupon_code_snapshot: "ZERODISC",
        coupon_status: "reserved",
      }),
      "رشد",
    );
    expect(zeroDiscountApplied.couponApplied).toBe(true);
    expect(zeroDiscountApplied.discountAmount).toBe(0);

    const noCoupon = toParentCandyPurchaseSummary(baseRow({ discount_amount: 0 }), "رشد");
    expect(noCoupon.couponApplied).toBe(false);
  });
});
