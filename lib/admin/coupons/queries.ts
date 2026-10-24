import "server-only";
import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { backendGetJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId } from "@/lib/observability/request-context";
import type {
  AdminCouponDetail,
  AdminCouponListItem,
  AdminCouponPagination,
} from "@/lib/admin/coupons/types";
import type { ParsedAdminCouponListParams } from "@/lib/admin/coupons/validation";

/**
 * Admin coupon reads (V0.1.51: PostgreSQL through the backend, v2 admin
 * assertion; no Supabase table). Coupons moved with purchase redemptions so
 * that definitions, limits and usage counts live in one database. Each
 * function returns null on any failure (not found, not admin, outage): the
 * callers keep their previous "not found / could not load" behaviour.
 */

type Out = { status: number; body: Record<string, unknown> };
const relay = (json: unknown, status: number): Out => {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body");
  return { status, body: json as Record<string, unknown> };
};

async function get(context: VerifiedAuthContext, operation: string, path: string, query?: Record<string, string | undefined>): Promise<Out | null> {
  try {
    const { data } = await backendGetJson({ operation, path, query, requestId: currentRequestId(), auth: context, acceptStatuses: [401, 403, 404], parse: relay });
    return data.status === 200 ? data : null;
  } catch (error) {
    if (isBackendClientError(error)) return null;
    throw error;
  }
}

export async function queryAdminCouponList(
  context: VerifiedAuthContext,
  params: ParsedAdminCouponListParams,
): Promise<{ coupons: AdminCouponListItem[]; pagination: AdminCouponPagination } | null> {
  const out = await get(context, "admin_coupon_list", "/v1/admin/coupons", {
    search: params.search ?? undefined,
    status: params.status,
    discountType: params.discountType,
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (!out || !Array.isArray(out.body.coupons)) return null;
  return { coupons: out.body.coupons as AdminCouponListItem[], pagination: out.body.pagination as AdminCouponPagination };
}

export async function queryAdminCouponPackages(
  context: VerifiedAuthContext,
): Promise<{ id: string; name: string; candyAmount: number; priceAmount: number }[] | null> {
  const out = await get(context, "admin_coupon_packages", "/v1/admin/coupons/packages");
  return out && Array.isArray(out.body.packages) ? (out.body.packages as { id: string; name: string; candyAmount: number; priceAmount: number }[]) : null;
}

export async function queryAdminCouponDetail(context: VerifiedAuthContext, couponId: string): Promise<AdminCouponDetail | null> {
  const out = await get(context, "admin_coupon_detail", `/v1/admin/coupons/${couponId.toLowerCase()}`);
  return out && out.body.coupon && typeof out.body.coupon === "object" ? (out.body.coupon as AdminCouponDetail) : null;
}
