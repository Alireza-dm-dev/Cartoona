import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAdminRole } from "@/lib/auth/admin-role";
import type {
  AdminCouponCreateInput,
  AdminCouponDetail,
  AdminCouponUpdateInput,
} from "@/lib/admin/coupons/types";
import { mapAdminCouponRpcError } from "@/lib/admin/coupons/errors";
import { queryAdminCouponDetail } from "@/lib/admin/coupons/queries";

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

/** Structured RPC failure — lets callers build the exact error shape. */
export interface AdminCouponRpcFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
}

function rpcFailure(message: unknown): AdminCouponRpcFailure {
  const mapped = mapAdminCouponRpcError(message);
  return { ok: false, code: mapped.code, message: mapped.message, status: mapped.status };
}

function success(coupon: AdminCouponDetail) {
  return { ok: true as const, coupon };
}

/**
 * Authenticates the request as an admin / super_admin and returns the verified
 * server supabase client plus the user id. On failure returns a NextResponse
 * and null. Admin routes do NOT run the parent session-lifetime check.
 */
export async function requireAdminCouponsAuth(): Promise<
  | { ok: true; supabase: SupabaseClient; adminUserId: string }
  | { ok: false; response: NextResponse }
> {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return { ok: false, response: jsonError("خطای احراز هویت رخ داد.", 500) };
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, response: jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401) };
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (roleError || !roleRow || !isAdminRole(roleRow.role)) {
    return { ok: false, response: jsonError("شما مجوز انجام این عملیات را ندارید.", 403) };
  }

  return { ok: true, supabase, adminUserId: user.id };
}

/**
 * Creates a coupon via the trusted service-role RPC. The browser never touches
 * the coupon tables directly (RLS SELECT-only). The RPC re-verifies the admin
 * role server-side and normalizes the code in the database.
 */
export async function createCouponViaTrustedRpc(
  adminUserId: string,
  input: AdminCouponCreateInput,
): Promise<{ ok: true; coupon: AdminCouponDetail } | AdminCouponRpcFailure> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "COUPON_UNKNOWN_ERROR", message: "ایجاد کد تخفیف انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("create_coupon_trusted", {
    p_admin_user_id: adminUserId,
    p_code: input.code,
    p_name: input.name,
    p_description: input.description,
    p_discount_type: input.discountType,
    p_discount_value: input.discountValue,
    p_is_active: input.isActive,
    p_starts_at: input.startsAt,
    p_expires_at: input.expiresAt,
    p_global_usage_limit: input.globalUsageLimit,
    p_per_parent_usage_limit: input.perParentUsageLimit,
    p_minimum_purchase_amount: input.minimumPurchaseAmount,
    p_maximum_discount_amount: input.maximumDiscountAmount,
    p_package_ids: input.packageIds,
  });

  if (error) {
    return rpcFailure(error.message);
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const couponId = row?.coupon_id;
  if (typeof couponId !== "string") {
    return { ok: false, code: "COUPON_UNKNOWN_ERROR", message: "ایجاد کد تخفیف انجام نشد.", status: 500 };
  }

  const supabase = await createServerSupabaseClient();
  const coupon = await queryAdminCouponDetail(supabase, couponId);
  if (!coupon) {
    return { ok: false, code: "COUPON_UNKNOWN_ERROR", message: "ایجاد کد تخفیف انجام نشد.", status: 500 };
  }

  return success(coupon);
}

/**
 * Updates a coupon via the trusted service-role RPC with optimistic
 * concurrency. Returns the refreshed detail on success.
 */
export async function updateCouponViaTrustedRpc(
  adminUserId: string,
  couponId: string,
  input: AdminCouponUpdateInput,
): Promise<{ ok: true; coupon: AdminCouponDetail } | AdminCouponRpcFailure> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "COUPON_UNKNOWN_ERROR", message: "ذخیره تغییرات انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("update_coupon_trusted", {
    p_admin_user_id: adminUserId,
    p_coupon_id: couponId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_code: input.code,
    p_name: input.name,
    p_description: input.description,
    p_discount_type: input.discountType,
    p_discount_value: input.discountValue,
    p_is_active: input.isActive,
    p_starts_at: input.startsAt,
    p_expires_at: input.expiresAt,
    p_global_usage_limit: input.globalUsageLimit,
    p_per_parent_usage_limit: input.perParentUsageLimit,
    p_minimum_purchase_amount: input.minimumPurchaseAmount,
    p_maximum_discount_amount: input.maximumDiscountAmount,
    p_package_ids: input.packageIds,
  });

  if (error) {
    return rpcFailure(error.message);
  }

  const supabase = await createServerSupabaseClient();
  const coupon = await queryAdminCouponDetail(supabase, couponId);
  if (!coupon) {
    return { ok: false, code: "COUPON_UNKNOWN_ERROR", message: "ذخیره تغییرات انجام نشد.", status: 500 };
  }

  return success(coupon);
}
