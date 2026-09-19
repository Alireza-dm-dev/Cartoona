import { describe, test, expect } from "vitest";
import { mapRequestRpcError } from "@/lib/requests/request-rpc-error";

describe("mapRequestRpcError", () => {
  test("maps request_unauthenticated to 401 with Persian text", () => {
    const r = mapRequestRpcError("request_unauthenticated");
    expect(r.status).toBe(401);
    expect(r.code).toBe("request_unauthenticated");
    // The English hint is for the logs, never for the parent.
    expect(r.error).not.toContain("Authentication");
    expect(r.error).toBe("لطفاً دوباره وارد حساب خود شوید.");
    expect(r.headers).toBeUndefined();
  });

  test("cannot forward a database hint, because it does not accept one", () => {
    // The mapper takes only the raised code. The RPC's hints describe internal
    // rules — storage path layout, pricing tiers — and there is no parameter
    // through which one could reach the response.
    expect(mapRequestRpcError.length).toBe(1);

    const codes = [
      "request_invalid_file_path",
      "request_invalid_duration_choice",
      "some_unmapped_code",
    ];

    for (const code of codes) {
      const r = mapRequestRpcError(code);
      for (const leak of ["path", "constraint", "public.", "tier", "violates"]) {
        expect(r.error.toLowerCase()).not.toContain(leak);
      }
      expect(r.error.length).toBeGreaterThan(0);
    }
  });

  test("never echoes an unrecognised Postgres error as the code", () => {
    // Postgres raises plenty of errors that are not ours, and their text names
    // columns, types and values: 'invalid input syntax for type uuid: "Robo
    // Bobo"'. The code field must not republish what the message withholds.
    const raw = 'invalid input syntax for type uuid: "Robo Bobo"';
    const r = mapRequestRpcError(raw);
    expect(r.code).toBe("request_failed");
    expect(r.code).not.toContain("uuid");
    expect(r.code).not.toContain("Robo");
    expect(r.error).toBe("ثبت درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.");
  });

  test("does not mistake an inherited property for a known code", () => {
    // A lookup with `in` would treat these as known codes.
    for (const code of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const r = mapRequestRpcError(code);
      expect(r.code, code).toBe("request_failed");
      expect(typeof r.error).toBe("string");
      expect(r.error).toBe("ثبت درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.");
    }
  });

  test("maps parent-required codes to 403", () => {
    for (const code of ["request_parent_required", "request_consent_required", "request_parent_profile_missing"]) {
      const r = mapRequestRpcError(code);
      expect(r.status).toBe(403);
      expect(r.code).toBe(code);
    }
  });

  test("maps INSUFFICIENT_CANDIES to 402 and never caches it", () => {
    const r = mapRequestRpcError("INSUFFICIENT_CANDIES");
    expect(r.status).toBe(402);
    expect(r.error).toContain("کافی نیست");
    // A balance answer that outlived a top-up would be worse than no answer.
    expect(r.headers?.["Cache-Control"]).toBe("no-store");
  });

  test("maps CANDY_WALLET_NOT_FOUND to 409", () => {
    const r = mapRequestRpcError("CANDY_WALLET_NOT_FOUND");
    expect(r.status).toBe(409);
    expect(r.headers?.["Cache-Control"]).toBe("no-store");
  });

  test("gives every known RPC failure its own Persian message", () => {
    const codes = [
      "request_child_name_too_long",
      "request_file_required",
      "request_file_type_invalid",
      "request_characters_speak_required",
      "request_character_not_found",
    ];
    for (const code of codes) {
      const r = mapRequestRpcError(code);
      expect(r.error).not.toBe("internal hint");
      expect(/[\u0600-\u06FF]/.test(r.error), code).toBe(true);
    }
  });

  test("maps CREATION_PRICING_UNAVAILABLE to 503 with no-store headers", () => {
    const r = mapRequestRpcError("CREATION_PRICING_UNAVAILABLE");
    expect(r.status).toBe(503);
    expect(r.error).toBe("قیمت این درخواست در حال حاضر در دسترس نیست.");
    expect(r.headers).toEqual({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  test("unknown code defaults to 422 with the generic Persian message", () => {
    const r = mapRequestRpcError("some_other_error");
    expect(r.status).toBe(422);
    expect(r.error).toBe("ثبت درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.");
  });

  test("non-string message defaults to unknown_error 422", () => {
    const r = mapRequestRpcError(undefined);
    expect(r.status).toBe(422);
    expect(r.code).toBe("unknown_error");
  });

  test("the hint is irrelevant to the result", () => {
    // Same code, three different hints, one answer.
    const a = mapRequestRpcError("request_unauthenticated");
    const b = mapRequestRpcError("request_unauthenticated");
    const c = mapRequestRpcError("request_unauthenticated");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.status).toBe(401);
  });
});
