import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdminCouponDetail,
  AdminCouponListItem,
  AdminCouponPagination,
} from "@/lib/admin/coupons/types";
import type { ParsedAdminCouponListParams } from "@/lib/admin/coupons/validation";
import { deriveCouponStatus } from "@/lib/admin/coupons/status";
import type { CouponDiscountType, CouponRedemptionStatus } from "@/types/database";

interface CouponRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discount_type: CouponDiscountType;
  discount_value: number;
  is_active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  global_usage_limit: number | null;
  per_parent_usage_limit: number | null;
  minimum_purchase_amount: number | null;
  maximum_discount_amount: number | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PackageRuleRow {
  coupon_id: string;
  package_id: string;
  candy_packages: { name: string } | null;
}

interface RedemptionRow {
  coupon_id: string;
  status: CouponRedemptionStatus;
}

const COUPON_SELECT = [
  "id",
  "code",
  "name",
  "description",
  "discount_type",
  "discount_value",
  "is_active",
  "starts_at",
  "expires_at",
  "global_usage_limit",
  "per_parent_usage_limit",
  "minimum_purchase_amount",
  "maximum_discount_amount",
  "created_at",
  "updated_at",
].join(",");

function usageCounts(rows: RedemptionRow[], couponId: string): {
  reserved: number;
  redeemed: number;
  cancelled: number;
} {
  let reserved = 0;
  let redeemed = 0;
  let cancelled = 0;
  for (const r of rows) {
    if (r.coupon_id !== couponId) continue;
    if (r.status === "reserved") reserved += 1;
    else if (r.status === "redeemed") redeemed += 1;
    else cancelled += 1;
  }
  return { reserved, redeemed, cancelled };
}

function toListItem(
  row: CouponRow,
  rules: PackageRuleRow[],
  redemptions: RedemptionRow[],
): AdminCouponListItem {
  const couponRules = rules.filter((r) => r.coupon_id === row.id);
  const usage = usageCounts(redemptions, row.id);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    isActive: row.is_active,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    status: deriveCouponStatus(row.is_active, row.starts_at, row.expires_at),
    globalUsageLimit: row.global_usage_limit,
    perParentUsageLimit: row.per_parent_usage_limit,
    minimumPurchaseAmount: row.minimum_purchase_amount,
    maximumDiscountAmount: row.maximum_discount_amount,
    packageIds: couponRules.map((r) => r.package_id),
    packageNames: couponRules
      .map((r) => r.candy_packages?.name)
      .filter((n): n is string => Boolean(n)),
    reservedCount: usage.reserved,
    redeemedCount: usage.redeemed,
    cancelledCount: usage.cancelled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Fetches a page of coupons with package rules and usage aggregates.
 * Search (code/name), status (derived), and discount type filters applied in
 * the database. Admin RLS (SELECT only) gates every read.
 */
export async function queryAdminCouponList(
  supabase: SupabaseClient,
  params: ParsedAdminCouponListParams,
): Promise<{ coupons: AdminCouponListItem[]; pagination: AdminCouponPagination } | null> {
  let query = supabase
    .from("coupons")
    .select(COUPON_SELECT, { count: "exact" });

  if (params.search) {
    query = query.or(`code.ilike.%${params.search}%,name.ilike.%${params.search}%`);
  }

  if (params.status === "inactive") {
    query = query.eq("is_active", false);
  } else if (params.status === "active") {
    query = query.eq("is_active", true);
  } else if (params.status === "scheduled") {
    query = query.eq("is_active", true).not("starts_at", "is", null);
  } else if (params.status === "expired") {
    query = query.eq("is_active", true).not("expires_at", "is", null);
  }

  if (params.discountType === "percentage" || params.discountType === "fixed_amount") {
    query = query.eq("discount_type", params.discountType);
  }

  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error || !data) return null;

  const rows = data as unknown as CouponRow[];
  const total = typeof count === "number" ? count : 0;
  const totalPages = total > 0 ? Math.ceil(total / params.pageSize) : 0;

  const couponIds = rows.map((r) => r.id);
  let rules: PackageRuleRow[] = [];
  let redemptions: RedemptionRow[] = [];

  if (couponIds.length > 0) {
    const [rulesRes, redemptionsRes] = await Promise.all([
      supabase
        .from("coupon_package_rules")
        .select("coupon_id, package_id, candy_packages(name)")
        .in("coupon_id", couponIds),
      supabase
        .from("coupon_redemptions")
        .select("coupon_id, status")
        .in("coupon_id", couponIds),
    ]);
    rules = (rulesRes.data ?? []) as unknown as PackageRuleRow[];
    redemptions = (redemptionsRes.data ?? []) as unknown as RedemptionRow[];
  }

  return {
    coupons: rows.map((row) => toListItem(row, rules, redemptions)),
    pagination: { page: params.page, pageSize: params.pageSize, total, totalPages },
  };
}

export async function queryAdminCouponPackages(
  supabase: SupabaseClient,
): Promise<{ id: string; name: string; candyAmount: number; priceAmount: number }[] | null> {
  const { data, error } = await supabase
    .from("candy_packages")
    .select("id, name, candy_amount, price_amount")
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (error || !data) return null;

  return (data as unknown as {
    id: string;
    name: string;
    candy_amount: number;
    price_amount: number;
  }[]).map((r) => ({
    id: r.id,
    name: r.name,
    candyAmount: r.candy_amount,
    priceAmount: r.price_amount,
  }));
}

/**
 * Fetches a single coupon with its package rules, usage aggregates, and the
 * admin who created it. Returns null when not found.
 */
export async function queryAdminCouponDetail(
  supabase: SupabaseClient,
  couponId: string,
): Promise<AdminCouponDetail | null> {
  const { data, error } = await supabase
    .from("coupons")
    .select(COUPON_SELECT)
    .eq("id", couponId)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as unknown as CouponRow;

  const [rulesRes, redemptionsRes] = await Promise.all([
    supabase
      .from("coupon_package_rules")
      .select("coupon_id, package_id, candy_packages(name)")
      .eq("coupon_id", couponId),
    supabase
      .from("coupon_redemptions")
      .select("coupon_id, status")
      .eq("coupon_id", couponId),
  ]);

  let creatorData: { id: string; email: string } | null = null;
  if (row.created_by_user_id) {
    const { data } = await supabase
      .from("users")
      .select("id, email")
      .eq("id", row.created_by_user_id)
      .maybeSingle();
    creatorData = data as { id: string; email: string } | null;
  }

  const rules = (rulesRes.data ?? []) as unknown as PackageRuleRow[];
  const redemptions = (redemptionsRes.data ?? []) as unknown as RedemptionRow[];

  const item = toListItem(row, rules, redemptions);
  return {
    ...item,
    createdBy: creatorData
      ? { id: String(creatorData.id ?? ""), email: String(creatorData.email ?? "") }
      : null,
  };
}
