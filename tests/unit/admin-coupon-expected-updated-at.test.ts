import { describe, test, expect, vi, beforeEach } from "vitest";
import { parseExpectedUpdatedAt } from "@/lib/admin/coupons/validation";

// PostgREST returns timestamptz with microseconds.
const DB_TS = "2026-10-01T10:36:56.090743+00:00";

describe("parseExpectedUpdatedAt", () => {
  test("accepts a microsecond timestamp and returns it byte-for-byte", () => {
    expect(parseExpectedUpdatedAt(DB_TS)).toBe(DB_TS);
  });

  test("does not normalise other valid representations", () => {
    for (const v of [
      "2026-10-01T10:36:56Z",
      "2026-10-01T10:36:56.09Z",
      "2026-10-01 10:36:56.090743+00",
      "2026-10-01T10:36:56.090743123+03:30",
    ]) {
      expect(parseExpectedUpdatedAt(v)).toBe(v);
    }
  });

  test("rejects malformed or non-string values", () => {
    for (const v of [
      "", "garbage", "2026-13-45T99:99:99Z", "2026-10-01", "2026-10-01T10:36:56",
      "2026-10-01T10:36:56Z'; drop table coupons;--", 123, null, undefined, {},
    ]) {
      expect(parseExpectedUpdatedAt(v)).toBeNull();
    }
  });

  test("the old Date round-trip really lost precision (guards the regression)", () => {
    expect(new Date(DB_TS).toISOString()).not.toBe(DB_TS);
    expect(new Date(DB_TS).toISOString()).toBe("2026-10-01T10:36:56.090Z");
  });
});

const rpc = vi.fn();
const updateSpy = vi.fn();

vi.mock("@/lib/admin/coupons/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/coupons/service")>(
    "@/lib/admin/coupons/service",
  );
  return {
    ...actual,
    requireAdminCouponsAuth: async () => ({ ok: true, supabase: {}, adminUserId: "admin-1" }),
    updateCouponViaTrustedRpc: async (...args: unknown[]) => {
      updateSpy(...args);
      return { ok: false, code: "COUPON_CONFLICT", message: "x", status: 409 };
    },
  };
});
vi.mock("@/lib/admin/coupons/queries", () => ({ queryAdminCouponDetail: vi.fn() }));

const ID = "39a0c381-62a1-4d76-bb93-7f677791f438";
const base = {
  code: "gift", name: "Gift", description: null, discountType: "percentage",
  discountValue: 5000, isActive: true, startsAt: null, expiresAt: null,
  globalUsageLimit: null, perParentUsageLimit: 1, minimumPurchaseAmount: null,
  maximumDiscountAmount: null, packageIds: [],
};

async function patch(body: unknown) {
  const { PATCH } = await import("@/app/api/admin/coupons/[id]/route");
  return PATCH(
    new Request("http://x/api/admin/coupons/" + ID, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ID }) },
  );
}

describe("PATCH /api/admin/coupons/[id] expectedUpdatedAt", () => {
  beforeEach(() => updateSpy.mockClear());

  test("forwards the exact microsecond token to the RPC wrapper", async () => {
    await patch({ ...base, expectedUpdatedAt: DB_TS });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][2].expectedUpdatedAt).toBe(DB_TS);
  });

  test("malformed token is rejected with 400 before the RPC", async () => {
    const res = await patch({ ...base, expectedUpdatedAt: "nope" });
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("updateCouponViaTrustedRpc", () => {
  test("passes p_expected_updated_at to the RPC unchanged", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/admin/coupons/service");
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ rpc }) }));
    vi.doMock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => ({}) }));
    rpc.mockResolvedValue({ data: null, error: { message: "coupon_admin_conflict" } });
    const { updateCouponViaTrustedRpc } = await import("@/lib/admin/coupons/service");
    const res = await updateCouponViaTrustedRpc("admin-1", ID, {
      ...base, expectedUpdatedAt: DB_TS,
    } as never);
    expect(rpc).toHaveBeenCalledWith("update_coupon_trusted", expect.objectContaining({
      p_expected_updated_at: DB_TS,
    }));
    // a stale/mismatched token still surfaces as 409
    expect(res).toMatchObject({ ok: false, status: 409 });
  });
});
