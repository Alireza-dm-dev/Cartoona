import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { withObservability } from "@/lib/observability/request-context"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { applyCoupon } from "@/lib/candy-purchases/backend-purchases"
import { backendFailure, callerFailure, errorJson, NO_STORE, readJsonBody } from "@/lib/candy-purchases/route-helpers"
import { isValidRawCouponCode, isValidIdempotencyKey, normalizeCouponCode } from "@/lib/coupons/rules"
import { toAppliedCouponResult } from "@/lib/coupons/types"
import { mapCouponRpcError } from "@/lib/coupons/errors"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 1024
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/candy-purchases/[id]/coupon - apply a coupon to a pending purchase
 * (V0.1.51: PostgreSQL, apply_coupon_to_purchase_trusted: the coupon row is
 * locked, limits re-counted and the redemption + purchase pricing written in
 * one transaction). Body { code, idempotency_key }; same error contract.
 */
export const POST = withObservability("POST /api/candy-purchases/[id]/coupon", handlePost)

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const caller = await verifyParentCaller()
  if (!caller.ok) return callerFailure("coded", caller.reason)

  const limited = await enforceRateLimit(caller.context.identity.subject, RATE_LIMIT_POLICIES.couponApply)
  if (limited) return limited

  const body = await readJsonBody(request, MAX_BODY_BYTES, "coded")
  if (body instanceof NextResponse) return body
  const keys = Object.keys(body).sort()
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "idempotency_key") {
    return errorJson("coded", "UNKNOWN_FIELDS", "فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }
  const { id: purchaseId } = await params
  if (!purchaseId || !UUID_REGEX.test(purchaseId.trim())) {
    return errorJson("coded", "INVALID_PURCHASE_ID", "شناسه خرید نامعتبر است.", 400)
  }
  const code: unknown = body.code
  if (typeof code !== "string" || !isValidRawCouponCode(code)) {
    return errorJson("coded", "INVALID_CODE", "فرمت کد تخفیف نامعتبر است.", 400)
  }
  const idempotencyKey: unknown = body.idempotency_key
  if (typeof idempotencyKey !== "string" || !isValidIdempotencyKey(idempotencyKey)) {
    return errorJson("coded", "INVALID_IDEMPOTENCY_KEY", "کلید یکتایی درخواست نامعتبر است.", 400)
  }

  const result = await applyCoupon(caller.context, purchaseId.trim().toLowerCase(), normalizeCouponCode(code), idempotencyKey.trim())
  if (result.ok) {
    return NextResponse.json(
      { coupon: toAppliedCouponResult(result.coupon as unknown as Parameters<typeof toAppliedCouponResult>[0]) },
      { headers: NO_STORE },
    )
  }
  if (result.kind === "refused") {
    const mapped = mapCouponRpcError(result.error === "attempt_purchase_not_owner" ? "coupon_purchase_not_found" : result.error)
    return errorJson("coded", mapped.code, mapped.message, mapped.status)
  }
  return backendFailure("coded", result)
}
