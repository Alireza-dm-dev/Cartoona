import { describe, test, expect } from "vitest";
import { mapRequestRpcError } from "@/lib/requests/request-rpc-error";

describe("mapRequestRpcError", () => {
  test("maps request_unauthenticated to 401", () => {
    const r = mapRequestRpcError("request_unauthenticated", "Authentication required.");
    expect(r.status).toBe(401);
    expect(r.code).toBe("request_unauthenticated");
    expect(r.error).toBe("Authentication required.");
    expect(r.headers).toBeUndefined();
  });

  test("maps parent-required codes to 403", () => {
    for (const code of ["request_parent_required", "request_consent_required", "request_parent_profile_missing"]) {
      const r = mapRequestRpcError(code, "Some hint.");
      expect(r.status).toBe(403);
      expect(r.code).toBe(code);
    }
  });

  test("maps INSUFFICIENT_CANDIES to 402", () => {
    const r = mapRequestRpcError("INSUFFICIENT_CANDIES", "موجودی آبنبات شما کافی نیست.");
    expect(r.status).toBe(402);
    expect(r.error).toBe("موجودی آبنبات شما کافی نیست.");
  });

  test("maps CANDY_WALLET_NOT_FOUND to 409", () => {
    const r = mapRequestRpcError("CANDY_WALLET_NOT_FOUND", "کیف پول آبنبات در دسترس نیست.");
    expect(r.status).toBe(409);
  });

  test("maps CREATION_PRICING_UNAVAILABLE to 503 with no-store headers", () => {
    const r = mapRequestRpcError("CREATION_PRICING_UNAVAILABLE", "ignored hint");
    expect(r.status).toBe(503);
    expect(r.error).toBe("قیمت این درخواست در حال حاضر در دسترس نیست.");
    expect(r.headers).toEqual({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  test("unknown code defaults to 422 and keeps the hint", () => {
    const r = mapRequestRpcError("some_other_error", "پیام");
    expect(r.status).toBe(422);
    expect(r.error).toBe("پیام");
  });

  test("non-string message defaults to unknown_error 422", () => {
    const r = mapRequestRpcError(undefined, "hint");
    expect(r.status).toBe(422);
    expect(r.code).toBe("unknown_error");
  });

  test("non-string hint falls back to default message", () => {
    const r = mapRequestRpcError("request_unauthenticated", null);
    expect(r.status).toBe(401);
    expect(r.error).toBe("ثبت درخواست با خطا مواجه شد");
  });
});
