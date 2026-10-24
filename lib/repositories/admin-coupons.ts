import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Admin coupon management on plain PostgreSQL (V0.1.51). Coupons move with
 * purchase redemptions: the usage limits are counted over coupon_redemptions,
 * which now live here, so a coupon defined (or edited) in another database
 * could price a purchase wrongly or exceed a limit. Writes are the existing
 * trusted functions (create/update_coupon_trusted, which re-check the admin
 * role in PostgreSQL and enforce optimistic concurrency); reads are SELECTs.
 *
 * Timestamps are rendered as fixed microsecond UTC text: `updatedAt` is the
 * optimistic-concurrency token and must round-trip byte-for-byte.
 */

export interface AdminCouponRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discount_type: "percentage" | "fixed_amount";
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
  package_ids: string[];
  package_names: string[];
  reserved_count: number;
  redeemed_count: number;
  cancelled_count: number;
}


export interface AdminCouponListParams {
  search: string | null;
  status: "all" | "active" | "inactive" | "scheduled" | "expired";
  discountType: "all" | "percentage" | "fixed_amount";
  page: number;
  pageSize: number;
}

/** `ILIKE` pattern with the user's wildcards escaped (Supabase's .ilike did not escape; this is stricter). */
function likePattern(search: string): string {
  return "%" + search.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
}

/**
 * One page of coupons + total, with the same filters as the Supabase route:
 * search over code/name; status inactive = is_active false, active = true,
 * scheduled = active with a start date, expired = active with an end date
 * (the final display status is derived per row by deriveCouponStatus).
 * Constant SQL: every filter is a bind parameter ($1 search, $2 status, $3 type).
 */

const COUNT_COUPONS = `SELECT count(*) AS n FROM public.coupons c WHERE
  ($1::text IS NULL OR c.code ILIKE $1 OR c.name ILIKE $1)
  AND ($2::text = 'all'
       OR ($2 = 'inactive' AND c.is_active = false)
       OR ($2 = 'active' AND c.is_active = true)
       OR ($2 = 'scheduled' AND c.is_active = true AND c.starts_at IS NOT NULL)
       OR ($2 = 'expired' AND c.is_active = true AND c.expires_at IS NOT NULL))
  AND ($3::text = 'all' OR c.discount_type = $3)`;
const SELECT_COUPON_PAGE = `SELECT
  c.id, c.code, c.name, c.description, c.discount_type, c.discount_value, c.is_active,
  CASE WHEN c.starts_at IS NULL THEN NULL ELSE to_char(c.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS starts_at,
  CASE WHEN c.expires_at IS NULL THEN NULL ELSE to_char(c.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS expires_at,
  c.global_usage_limit, c.per_parent_usage_limit, c.minimum_purchase_amount, c.maximum_discount_amount,
  c.created_by_user_id, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at, to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at,
  coalesce((SELECT array_agg(r.package_id ORDER BY k.display_order, r.package_id) FROM public.coupon_package_rules r JOIN public.candy_packages k ON k.id = r.package_id WHERE r.coupon_id = c.id), '{}') AS package_ids,
  coalesce((SELECT array_agg(k.name ORDER BY k.display_order, r.package_id) FROM public.coupon_package_rules r JOIN public.candy_packages k ON k.id = r.package_id WHERE r.coupon_id = c.id), '{}') AS package_names,
  (SELECT count(*)::int FROM public.coupon_redemptions x WHERE x.coupon_id = c.id AND x.status = 'reserved') AS reserved_count,
  (SELECT count(*)::int FROM public.coupon_redemptions x WHERE x.coupon_id = c.id AND x.status = 'redeemed') AS redeemed_count,
  (SELECT count(*)::int FROM public.coupon_redemptions x WHERE x.coupon_id = c.id AND x.status = 'cancelled') AS cancelled_count
  FROM public.coupons c WHERE
  ($1::text IS NULL OR c.code ILIKE $1 OR c.name ILIKE $1)
  AND ($2::text = 'all'
       OR ($2 = 'inactive' AND c.is_active = false)
       OR ($2 = 'active' AND c.is_active = true)
       OR ($2 = 'scheduled' AND c.is_active = true AND c.starts_at IS NOT NULL)
       OR ($2 = 'expired' AND c.is_active = true AND c.expires_at IS NOT NULL))
  AND ($3::text = 'all' OR c.discount_type = $3)
  ORDER BY c.created_at DESC, c.id DESC LIMIT $4 OFFSET $5`;

export async function listAdminCoupons(
  db: Queryable,
  params: AdminCouponListParams,
): Promise<{ rows: AdminCouponRow[]; total: number }> {
  const filters = [params.search ? likePattern(params.search) : null, params.status, params.discountType];
  const total = Number((await runQuery<{ n: string }>(db, COUNT_COUPONS, filters))[0].n);
  const rows = await runQuery<AdminCouponRow>(db, SELECT_COUPON_PAGE, [...filters, params.pageSize, (params.page - 1) * params.pageSize]);
  return { rows, total };
}

const SELECT_ONE_COUPON = `SELECT
  c.id, c.code, c.name, c.description, c.discount_type, c.discount_value, c.is_active,
  CASE WHEN c.starts_at IS NULL THEN NULL ELSE to_char(c.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS starts_at,
  CASE WHEN c.expires_at IS NULL THEN NULL ELSE to_char(c.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS expires_at,
  c.global_usage_limit, c.per_parent_usage_limit, c.minimum_purchase_amount, c.maximum_discount_amount,
  c.created_by_user_id, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at, to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at,
  coalesce((SELECT array_agg(r.package_id ORDER BY k.display_order, r.package_id) FROM public.coupon_package_rules r JOIN public.candy_packages k ON k.id = r.package_id WHERE r.coupon_id = c.id), '{}') AS package_ids,
  coalesce((SELECT array_agg(k.name ORDER BY k.display_order, r.package_id) FROM public.coupon_package_rules r JOIN public.candy_packages k ON k.id = r.package_id WHERE r.coupon_id = c.id), '{}') AS package_names,
  (SELECT count(*)::int FROM public.coupon_redemptions x WHERE x.coupon_id = c.id AND x.status = 'reserved') AS reserved_count,
  (SELECT count(*)::int FROM public.coupon_redemptions x WHERE x.coupon_id = c.id AND x.status = 'redeemed') AS redeemed_count,
  (SELECT count(*)::int FROM public.coupon_redemptions x WHERE x.coupon_id = c.id AND x.status = 'cancelled') AS cancelled_count,
  (SELECT u.email FROM public.users u WHERE u.id = c.created_by_user_id) AS creator_email
  FROM public.coupons c WHERE c.id = $1`;

export async function getAdminCoupon(
  db: Queryable,
  couponId: string,
): Promise<(AdminCouponRow & { creator_email: string | null }) | null> {
  const rows = await runQuery<AdminCouponRow & { creator_email: string | null }>(
    db,
    SELECT_ONE_COUPON,
    [requireUuid(couponId, "couponId")],
  );
  return rows[0] ?? null;
}

export async function listAdminCouponPackages(
  db: Queryable,
): Promise<Array<{ id: string; name: string; candyAmount: number; priceAmount: number }>> {
  const rows = await runQuery<{ id: string; name: string; candy_amount: number; price_amount: number }>(
    db,
    `SELECT id, name, candy_amount, price_amount FROM public.candy_packages WHERE is_active = true ORDER BY display_order ASC, id ASC`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, candyAmount: r.candy_amount, priceAmount: r.price_amount }));
}

export interface AdminCouponWriteInput {
  code: string;
  name: string;
  description: string | null;
  discountType: "percentage" | "fixed_amount";
  discountValue: number;
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  globalUsageLimit: number | null;
  perParentUsageLimit: number | null;
  minimumPurchaseAmount: number | null;
  maximumDiscountAmount: number | null;
  packageIds: string[];
}

function writeArgs(i: AdminCouponWriteInput): unknown[] {
  return [
    i.code, i.name, i.description, i.discountType, i.discountValue, i.isActive, i.startsAt, i.expiresAt,
    i.globalUsageLimit, i.perParentUsageLimit, i.minimumPurchaseAmount, i.maximumDiscountAmount,
    i.packageIds.map((id) => requireUuid(id, "packageId")),
  ];
}

export async function createAdminCoupon(db: Queryable, input: { adminUserId: string; coupon: AdminCouponWriteInput }): Promise<string> {
  const rows = await runQuery<{ coupon_id: string }>(
    db,
    `SELECT coupon_id FROM public.create_coupon_trusted($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14::uuid[])`,
    [requireUuid(input.adminUserId, "adminUserId"), ...writeArgs(input.coupon)],
  );
  return rows[0].coupon_id;
}

export async function updateAdminCoupon(
  db: Queryable,
  input: { adminUserId: string; couponId: string; expectedUpdatedAt: string; coupon: AdminCouponWriteInput },
): Promise<void> {
  await runQuery(
    db,
    `SELECT coupon_id FROM public.update_coupon_trusted($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12, $13, $14, $15, $16::uuid[])`,
    [requireUuid(input.adminUserId, "adminUserId"), requireUuid(input.couponId, "couponId"), input.expectedUpdatedAt, ...writeArgs(input.coupon)],
  );
}
