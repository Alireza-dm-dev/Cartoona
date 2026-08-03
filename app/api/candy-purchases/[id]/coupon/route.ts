import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { isParentRole } from "@/lib/auth/parent-access"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"
import { isValidRawCouponCode, isValidIdempotencyKey, normalizeCouponCode } from "@/lib/coupons/rules"
import { toAppliedCouponResult } from "@/lib/coupons/types"
import { mapCouponRpcError } from "@/lib/coupons/errors"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 1024
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

/**
 * POST /api/candy-purchases/[id]/coupon
 * Authenticated parent only. Atomically applies a coupon to a pending purchase
 * via the trusted service-role RPC. No direct table writes in this route.
 * Body: { code, idempotency_key }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("application/json")) {
    return jsonError("INVALID_FORMAT", "فرمت درخواست باید JSON باشد.", 415)
  }

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10)
    if (isNaN(len) || len < 0) return jsonError("INVALID_REQUEST", "درخواست نامعتبر است.", 400)
    if (len > MAX_BODY_BYTES) return jsonError("REQUEST_TOO_LARGE", "حجم درخواست بیش از حد مجاز است.", 413)
  }

  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return jsonError("AUTH_ERROR", "خطای احراز هویت رخ داد.", 500)
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return jsonError("UNAUTHENTICATED", "لطفاً ابتدا وارد حساب خود شوید.", 401)
  }

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow || !isParentRole(userRow.role)) {
    return jsonError("FORBIDDEN", "شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  // Parse and validate body
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
      return jsonError("REQUEST_TOO_LARGE", "حجم درخواست بیش از حد مجاز است.", 413)
    }
    body = JSON.parse(text)
  } catch {
    return jsonError("INVALID_JSON", "فرمت JSON نامعتبر است.", 400)
  }

  const keys = Object.keys(body).sort()
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "idempotency_key") {
    return jsonError("UNKNOWN_FIELDS", "فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }

  const { id: purchaseId } = await params
  if (!purchaseId || !UUID_REGEX.test(purchaseId.trim())) {
    return jsonError("INVALID_PURCHASE_ID", "شناسه خرید نامعتبر است.", 400)
  }

  const code: unknown = body.code
  if (typeof code !== "string" || !isValidRawCouponCode(code)) {
    return jsonError("INVALID_CODE", "فرمت کد تخفیف نامعتبر است.", 400)
  }
  const normalizedCode = normalizeCouponCode(code)

  const idempotencyKey: unknown = body.idempotency_key
  if (typeof idempotencyKey !== "string" || !isValidIdempotencyKey(idempotencyKey)) {
    return jsonError("INVALID_IDEMPOTENCY_KEY", "کلید یکتایی درخواست نامعتبر است.", 400)
  }

  // Resolve parent profile server-side
  const { data: parentProfile } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!parentProfile) {
    return jsonError("PARENT_PROFILE_NOT_FOUND", "پروفایل والد یافت نشد.", 400)
  }

  let admin
  try {
    admin = createAdminSupabaseClient()
  } catch {
    return jsonError("SERVER_CONFIG_ERROR", "خطای پیکربندی سرور.", 500)
  }

  const { data: rpcData, error: rpcError } = await admin
    .rpc("apply_coupon_to_purchase_trusted", {
      p_parent_profile_id: parentProfile.id,
      p_purchase_id: purchaseId.trim(),
      p_coupon_code: normalizedCode,
      p_idempotency_key: idempotencyKey.trim(),
    })

  if (rpcError) {
    const mapped = mapCouponRpcError(rpcError.message)
    return jsonError(mapped.code, mapped.message, mapped.status)
  }

  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as Record<string, unknown> | null
  if (!row) {
    return jsonError("APPLY_FAILED", "اعمال کد تخفیف انجام نشد.", 500)
  }

  return NextResponse.json(
    { coupon: toAppliedCouponResult(row as unknown as Parameters<typeof toAppliedCouponResult>[0]) },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}
