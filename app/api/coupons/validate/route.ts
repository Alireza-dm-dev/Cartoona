import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { withObservability } from "@/lib/observability/request-context"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { validateCoupon } from "@/lib/candy-purchases/backend-purchases"
import { backendFailure, callerFailure, errorJson, NO_STORE, readJsonBody } from "@/lib/candy-purchases/route-helpers"
import { isValidRawCouponCode, normalizeCouponCode } from "@/lib/coupons/rules"
import { toCouponValidationResult } from "@/lib/coupons/types"
import { mapCouponRpcError } from "@/lib/coupons/errors"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 1024
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/coupons/validate - read-only preview of a coupon on a pending
 * purchase (V0.1.51: PostgreSQL, validate_coupon_for_purchase_trusted through
 * a v2 read). Body { purchase_id, code }; same response and error contract.
 * The browser never supplies a parent id, package or amount.
 */
export const POST = withObservability("POST /api/coupons/validate", handlePost)

async function handlePost(request: Request) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const caller = await verifyParentCaller()
  if (!caller.ok) return callerFailure("coded", caller.reason)

  // Per parent, before the validation read. Also bounds coupon-code guessing.
  const limited = await enforceRateLimit(caller.context.identity.subject, RATE_LIMIT_POLICIES.couponValidate)
  if (limited) return limited

  const body = await readJsonBody(request, MAX_BODY_BYTES, "coded")
  if (body instanceof NextResponse) return body
  const keys = Object.keys(body).sort()
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "purchase_id") {
    return errorJson("coded", "UNKNOWN_FIELDS", "فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }
  const purchaseId: unknown = body.purchase_id
  if (typeof purchaseId !== "string" || !UUID_REGEX.test(purchaseId.trim())) {
    return errorJson("coded", "INVALID_PURCHASE_ID", "شناسه خرید نامعتبر است.", 400)
  }
  const code: unknown = body.code
  if (typeof code !== "string" || !isValidRawCouponCode(code)) {
    return errorJson("coded", "INVALID_CODE", "فرمت کد تخفیف نامعتبر است.", 400)
  }

  const result = await validateCoupon(caller.context, purchaseId.trim().toLowerCase(), normalizeCouponCode(code))
  if (result.ok) {
    return NextResponse.json(
      { coupon: toCouponValidationResult(result.coupon as unknown as Parameters<typeof toCouponValidationResult>[0]) },
      { headers: NO_STORE },
    )
  }
  if (result.kind === "refused") {
    const mapped = mapCouponRpcError(result.error)
    return errorJson("coded", mapped.code, mapped.message, mapped.status)
  }
  return backendFailure("coded", result)
}
