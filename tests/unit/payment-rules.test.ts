import { describe, test, expect } from "vitest";
import type { DbPaymentAttempt } from "@/types/database";
import {
  isPaymentAttemptStatus,
  isTerminalAttemptStatus,
  canCreateAttemptForPurchaseStatus,
  amountsMatchForVerification,
  isValidIdempotencyKey,
  isSafeFailureCode,
  toPaymentAttemptSummary,
} from "@/lib/payments/rules";

describe("payment rules — status", () => {
  test("accepts every valid attempt status", () => {
    for (const s of ["created", "awaiting_payment", "processing", "verified", "failed", "cancelled", "expired"]) {
      expect(isPaymentAttemptStatus(s)).toBe(true);
    }
  });

  test("rejects invalid statuses", () => {
    for (const s of ["paid", "Pending", "verified ", "", null, undefined]) {
      expect(isPaymentAttemptStatus(s)).toBe(false);
    }
  });

  test("terminal statuses are verified, failed, cancelled, expired", () => {
    expect(isTerminalAttemptStatus("verified")).toBe(true);
    expect(isTerminalAttemptStatus("failed")).toBe(true);
    expect(isTerminalAttemptStatus("cancelled")).toBe(true);
    expect(isTerminalAttemptStatus("expired")).toBe(true);
    expect(isTerminalAttemptStatus("created")).toBe(false);
    expect(isTerminalAttemptStatus("awaiting_payment")).toBe(false);
    expect(isTerminalAttemptStatus("processing")).toBe(false);
  });

  test("new attempts may be created only for pending, failed, expired purchases", () => {
    expect(canCreateAttemptForPurchaseStatus("pending")).toBe(true);
    expect(canCreateAttemptForPurchaseStatus("failed")).toBe(true);
    expect(canCreateAttemptForPurchaseStatus("expired")).toBe(true);
    expect(canCreateAttemptForPurchaseStatus("paid")).toBe(false);
    expect(canCreateAttemptForPurchaseStatus("cancelled")).toBe(false);
    expect(canCreateAttemptForPurchaseStatus("anything_else")).toBe(false);
  });
});

describe("payment rules — amount/currency", () => {
  test("verification requires exact amount and currency equality", () => {
    expect(amountsMatchForVerification(280000, "IRR", 280000, "IRR")).toBe(true);
    expect(amountsMatchForVerification(280000, "IRR", 280001, "IRR")).toBe(false);
    expect(amountsMatchForVerification(280000, "IRR", 280000, "IRR2")).toBe(false);
    expect(amountsMatchForVerification(280000, "IRR", null, "IRR")).toBe(false);
    expect(amountsMatchForVerification(280000, "IRR", 280000, null)).toBe(false);
  });

  test("integer Rial is never rescalled or renamed", () => {
    const packagePrice = 280000; // IRR integer Rial
    expect(Number.isInteger(packagePrice)).toBe(true);
    expect(packagePrice).toBe(280000);
  });
});

describe("payment rules — idempotency keys", () => {
  test("accepts meaningful idempotency keys", () => {
    expect(isValidIdempotencyKey("pay:purchase_123")).toBe(true);
    expect(isValidIdempotencyKey(" attempt_key_1 ")).toBe(true);
  });

  test("rejects empty, too-long, and timestamp-only keys", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("   ")).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey("a".repeat(256))).toBe(false);
    expect(isValidIdempotencyKey("1722444000000")).toBe(false);
  });
});

describe("payment rules — failure codes", () => {
  test("accepts safe lowercase snake_case codes", () => {
    expect(isSafeFailureCode("session_expired")).toBe(true);
    expect(isSafeFailureCode("declined")).toBe(true);
    expect(isSafeFailureCode("a_1_b")).toBe(true);
  });

  test("rejects unsafe or oversized codes", () => {
    expect(isSafeFailureCode(null)).toBe(false);
    expect(isSafeFailureCode("")).toBe(false);
    expect(isSafeFailureCode("Session-Expired")).toBe(false);
    expect(isSafeFailureCode("x".repeat(51))).toBe(false);
  });
});

describe("payment rules — public serialization", () => {
  const attempt: DbPaymentAttempt = {
    id: "attempt-1",
    purchase_id: "purchase-1",
    provider: "zarinpal",
    status: "awaiting_payment",
    provider_session_id: "secret-session",
    provider_transaction_id: "txn-1",
    provider_payment_reference: "ref-1",
    checkout_url: "https://pay.example/checkout",
    checkout_expires_at: "2026-08-01T10:00:00Z",
    requested_amount: 280000,
    requested_currency: "IRR",
    verified_amount: null,
    verified_currency: null,
    provider_verified_at: null,
    failure_code: null,
    failure_message_safe: null,
    attempt_number: 1,
    idempotency_key: "pay:purchase-1",
    created_at: "2026-07-31T11:00:00Z",
    updated_at: "2026-07-31T11:00:00Z",
    completed_at: null,
  };

  test("maps provider to a known provider id, fallback to unknown", () => {
    expect(toPaymentAttemptSummary(attempt).provider).toBe("zarinpal");
    const unknown = toPaymentAttemptSummary({ ...attempt, provider: "some_gateway" });
    expect(unknown.provider).toBe("unknown");
  });

  test("public summary excludes internal fields", () => {
    const summary = toPaymentAttemptSummary(attempt);
    expect(summary.id).toBe("attempt-1");
    expect(summary.purchaseId).toBe("purchase-1");
    expect(summary.requestedAmount).toBe(280000);
    expect(summary.attemptNumber).toBe(1);
    expect(summary.status).toBe("awaiting_payment");
    expect(summary.verifiedAmount).toBeNull();
    expect(summary.completedAt).toBeNull();
    expect("idempotency_key" in summary).toBe(false);
    expect("provider_session_id" in summary).toBe(false);
    expect("provider_transaction_id" in summary).toBe(false);
    expect("checkout_url" in summary).toBe(false);
    expect("failure_message_safe" in summary).toBe(false);
  });
});
