import "server-only";
import { NextResponse } from "next/server";
import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { verifyParentCaller } from "@/lib/parent/backend-caller";
import { backendGetJson, backendWriteJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId } from "@/lib/observability/request-context";
import type {
  AdminCouponCreateInput,
  AdminCouponDetail,
  AdminCouponUpdateInput,
} from "@/lib/admin/coupons/types";
import { mapAdminCouponRpcError } from "@/lib/admin/coupons/errors";

/**
 * Admin coupon writes (V0.1.51): Next verifies the Supabase session, the
 * backend checks the ADMIN role (requireWriteAuth admin|super_admin, v3) and
 * create/update_coupon_trusted re-check it in PostgreSQL. No Supabase table
 * or RPC is used. Error shapes and Persian messages are unchanged.
 */

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: JSON_HEADERS },
  );
}

/** Structured failure — lets callers build the exact error shape. */
export interface AdminCouponRpcFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
}

/**
 * The verified caller of an admin coupon route. The ROLE is decided by the
 * backend on every call (a non-admin gets 403 there), never here.
 */
export async function requireAdminCouponsAuth(): Promise<
  | { ok: true; context: VerifiedAuthContext }
  | { ok: false; response: NextResponse }
> {
  const caller = await verifyParentCaller();
  if (!caller.ok) {
    if (caller.reason === "auth_unavailable") {
      return { ok: false, response: jsonError("بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.", 503) };
    }
    return { ok: false, response: jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401) };
  }
  // The role comes from PostgreSQL (GET /v1/auth/me), never from Supabase or the
  // browser; every admin coupon backend route checks it again.
  let role: unknown = null;
  try {
    const { data } = await backendGetJson({
      operation: "admin_coupons_role",
      path: "/v1/auth/me",
      requestId: currentRequestId(),
      auth: caller.context,
      acceptStatuses: [401, 403],
      parse: (json: unknown, status: number) => ({ status, role: (json as { role?: unknown } | null)?.role ?? null }),
    });
    if (data.status === 200) role = data.role;
    else if (data.status === 401) return { ok: false, response: jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401) };
  } catch (error) {
    if (!isBackendClientError(error)) throw error;
    return { ok: false, response: jsonError("این عملیات موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.", 503) };
  }
  if (role !== "admin" && role !== "super_admin") {
    return { ok: false, response: jsonError("شما مجوز انجام این عملیات را ندارید.", 403) };
  }
  return { ok: true, context: caller.context };
}

type Out = { status: number; body: Record<string, unknown> };
const relay = (json: unknown, status: number): Out => {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body");
  return { status, body: json as Record<string, unknown> };
};

async function write(
  context: VerifiedAuthContext,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  fallbackMessage: string,
): Promise<{ ok: true; coupon: AdminCouponDetail } | AdminCouponRpcFailure> {
  let out: Out;
  try {
    ({ data: out } = await backendWriteJson({
      operation: method === "POST" ? "admin_coupon_create" : "admin_coupon_update",
      method,
      path,
      body,
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: [400, 401, 403, 404, 409, 422],
      parse: relay,
    }));
  } catch (error) {
    if (!isBackendClientError(error)) throw error;
    return { ok: false, code: "COUPON_UNKNOWN_ERROR", message: fallbackMessage, status: 503 };
  }
  if (out.status === 200 || out.status === 201) {
    const coupon = out.body.coupon as AdminCouponDetail | null;
    if (coupon) return { ok: true, coupon };
    return { ok: false, code: "COUPON_UNKNOWN_ERROR", message: fallbackMessage, status: 500 };
  }
  if (out.status === 401) return { ok: false, code: "COUPON_INVALID", message: "لطفاً ابتدا وارد حساب خود شوید.", status: 401 };
  const error = typeof out.body.error === "string" ? out.body.error : "unknown_error";
  if (error === "forbidden" || error === "identity_not_linked") {
    return { ok: false, code: "COUPON_INVALID", message: "شما مجوز انجام این عملیات را ندارید.", status: 403 };
  }
  if (error === "invalid_request") return { ok: false, code: "COUPON_INVALID", message: "اطلاعات کد تخفیف معتبر نیست.", status: 422 };
  const mapped = mapAdminCouponRpcError(error);
  return { ok: false, code: mapped.code, message: mapped.message, status: mapped.status };
}

export async function createCouponViaTrustedRpc(
  context: VerifiedAuthContext,
  input: AdminCouponCreateInput,
): Promise<{ ok: true; coupon: AdminCouponDetail } | AdminCouponRpcFailure> {
  return write(context, "POST", "/v1/admin/coupons", input, "ایجاد کد تخفیف انجام نشد.");
}

export async function updateCouponViaTrustedRpc(
  context: VerifiedAuthContext,
  couponId: string,
  input: AdminCouponUpdateInput,
): Promise<{ ok: true; coupon: AdminCouponDetail } | AdminCouponRpcFailure> {
  return write(context, "PATCH", `/v1/admin/coupons/${couponId.toLowerCase()}`, input, "ذخیره تغییرات انجام نشد.");
}
