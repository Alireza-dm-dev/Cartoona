import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { withObservability } from "@/lib/observability/request-context"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { createPurchase, loadPurchaseHistory } from "@/lib/candy-purchases/backend-purchases"
import { backendFailure, callerFailure, errorJson, NO_STORE, readJsonBody } from "@/lib/candy-purchases/route-helpers"
import type { CandyPurchasesListResponse } from "@/lib/candy-purchases/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Candy purchases (V0.1.51: PostgreSQL through the backend; no Supabase table).
 *
 * GET  - the signed-in parent's purchase history ({ purchases }), same shape as
 *        before (package name, coupon snapshot + name, paymentStarted).
 * POST - create a pending purchase. Body exactly { package_id }. Price, candy
 *        amount and currency are taken from the ACTIVE package row in
 *        PostgreSQL by create_candy_purchase_trusted; the browser sends none.
 *        201 { purchase }. Moves no candy: only a provider-verified payment
 *        credits the wallet (POST /api/payments/webhooks/[provider]).
 *
 * Shared CSRF guard on POST; Supabase is the identity provider only.
 */

const MAX_BODY_BYTES = 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const GET = withObservability("GET /api/candy-purchases", handleGet)
export const POST = withObservability("POST /api/candy-purchases", handlePost)

async function handleGet() {
  const caller = await verifyParentCaller()
  if (!caller.ok) return callerFailure("flat", caller.reason)
  const result = await loadPurchaseHistory(caller.context)
  if (!result.ok) {
    if (result.kind === "refused") return errorJson("flat", "PURCHASES_UNAVAILABLE", "دریافت اطلاعات خرید انجام نشد.", 503)
    return backendFailure("flat", result)
  }
  const body: CandyPurchasesListResponse = { purchases: result.purchases }
  return NextResponse.json(body, { headers: NO_STORE })
}

async function handlePost(request: Request) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const caller = await verifyParentCaller()
  if (!caller.ok) return callerFailure("flat", caller.reason)

  // Per parent, after identity is known and before any purchase work.
  const limited = await enforceRateLimit(caller.context.identity.subject, RATE_LIMIT_POLICIES.candyPurchaseMutation)
  if (limited) return limited

  const body = await readJsonBody(request, MAX_BODY_BYTES, "flat")
  if (body instanceof NextResponse) return body
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== "package_id") {
    return errorJson("flat", "UNKNOWN_FIELDS", "فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }
  const packageId = body.package_id
  if (typeof packageId !== "string" || !UUID.test(packageId.trim())) {
    return errorJson("flat", "INVALID_PACKAGE", "شناسه بسته نامعتبر است.", 400)
  }

  const result = await createPurchase(caller.context, packageId.trim().toLowerCase())
  if (result.ok) return NextResponse.json({ purchase: result.purchase }, { status: 201, headers: NO_STORE })
  if (result.kind === "refused") {
    if (result.error === "purchase_package_unavailable") {
      return errorJson("flat", "PACKAGE_UNAVAILABLE", "بسته مورد نظر یافت نشد یا فعال نیست.", 404)
    }
    if (result.error === "purchase_parent_required") return callerFailure("flat", "forbidden")
    return errorJson("flat", "PURCHASE_FAILED", "ایجاد خرید با خطا مواجه شد.", 500)
  }
  return backendFailure("flat", result)
}
