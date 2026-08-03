import { NextResponse } from "next/server";
import {
  requireAdminCouponsAuth,
  jsonError,
  updateCouponViaTrustedRpc,
} from "@/lib/admin/coupons/service";
import { queryAdminCouponDetail } from "@/lib/admin/coupons/queries";
import { validateCouponInput, isUuid } from "@/lib/admin/coupons/validation";
import type { AdminCouponErrorResponse } from "@/lib/admin/coupons/types";

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

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "کد تخفیف مورد نظر یافت نشد.", code: "COUPON_NOT_FOUND" },
    { status: 404, headers: JSON_HEADERS },
  );
}

/**
 * GET /api/admin/coupons/[id]
 * Full admin coupon detail including package rules, usage counts, and creator.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminCouponsAuth();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const coupon = await queryAdminCouponDetail(auth.supabase, id);
  if (!coupon) return notFound();

  return NextResponse.json({ coupon }, { headers: JSON_HEADERS });
}

/**
 * PATCH /api/admin/coupons/[id]
 * Updates a coupon with optimistic concurrency (expectedUpdatedAt). 409 on
 * conflict or when an immutable discount field is edited after usage; 422 on
 * field validation errors.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminCouponsAuth();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isUuid(id)) return notFound();

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

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return bodyTooLarge();
    body = JSON.parse(text);
  } catch {
    return jsonError("فرمت JSON نامعتبر است.", 400);
  }

  const expectedUpdatedAt = body.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== "string") {
    return jsonError("درخواست نامعتبر است.", 400);
  }
  const ts = new Date(expectedUpdatedAt);
  if (isNaN(ts.getTime())) {
    return jsonError("درخواست نامعتبر است.", 400);
  }

  const validated = validateCouponInput(body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: "اطلاعات کد تخفیف معتبر نیست.", code: "COUPON_INVALID", errors: validated.errors },
      { status: 422, headers: JSON_HEADERS },
    );
  }

  const result = await updateCouponViaTrustedRpc(auth.adminUserId, id, {
    ...validated.input,
    expectedUpdatedAt: ts.toISOString(),
  });

  if (!result.ok) {
    const errResp: AdminCouponErrorResponse = {
      error: result.message,
      code: result.code as AdminCouponErrorResponse["code"],
    };
    return NextResponse.json(errResp, { status: result.status, headers: JSON_HEADERS });
  }

  return NextResponse.json({ coupon: result.coupon }, { headers: JSON_HEADERS });
}
