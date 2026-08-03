import { NextResponse } from "next/server";
import {
  requireAdminCouponsAuth,
  jsonError,
  createCouponViaTrustedRpc,
} from "@/lib/admin/coupons/service";
import { queryAdminCouponList } from "@/lib/admin/coupons/queries";
import { parseAdminCouponListParams, validateCouponInput } from "@/lib/admin/coupons/validation";
import type { AdminCouponListResponse, AdminCouponErrorResponse } from "@/lib/admin/coupons/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4096;

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function bodyTooLarge(): NextResponse {
  return NextResponse.json(
    { error: "حجم درخواست بیش از حد مجاز است." },
    { status: 413, headers: JSON_HEADERS },
  );
}

/**
 * GET /api/admin/coupons
 * Admin list with search, status, discountType filters and backend pagination.
 * Usage counts are derived from coupon_redemptions. Never returns parent
 * identities or redemption IDs.
 */
export async function GET(request: Request) {
  const auth = await requireAdminCouponsAuth();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const params = parseAdminCouponListParams(url);

  const result = await queryAdminCouponList(auth.supabase, params);
  if (!result) {
    return jsonError("دریافت لیست کدهای تخفیف انجام نشد.", 500);
  }

  const response: AdminCouponListResponse = result;
  return NextResponse.json(response, { headers: JSON_HEADERS });
}

/**
 * POST /api/admin/coupons
 * Creates a coupon through the trusted service-role RPC. Validation errors map
 * to field-level Persian messages; duplicate codes return 409.
 */
export async function POST(request: Request) {
  const auth = await requireAdminCouponsAuth();
  if (!auth.ok) return auth.response;

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("application/json")) {
    return jsonError("فرمت درخواست باید JSON باشد.", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (isNaN(len) || len < 0) return jsonError("درخواست نامعتبر است.", 400);
    if (len > MAX_BODY_BYTES) return bodyTooLarge();
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return bodyTooLarge();
    body = JSON.parse(text);
  } catch {
    return jsonError("فرمت JSON نامعتبر است.", 400);
  }

  const validated = validateCouponInput(body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: "اطلاعات کد تخفیف معتبر نیست.", code: "COUPON_INVALID", errors: validated.errors },
      { status: 422, headers: JSON_HEADERS },
    );
  }

  const result = await createCouponViaTrustedRpc(auth.adminUserId, validated.input);
  if (!result.ok) {
    const errResp: AdminCouponErrorResponse = {
      error: result.message,
      code: result.code as AdminCouponErrorResponse["code"],
    };
    return NextResponse.json(errResp, { status: result.status, headers: JSON_HEADERS });
  }

  return NextResponse.json({ coupon: result.coupon }, { status: 201, headers: JSON_HEADERS });
}
