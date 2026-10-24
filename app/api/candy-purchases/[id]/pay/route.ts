import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { withObservability } from "@/lib/observability/request-context"
import { rejectUnsafeBrowserWrite, expectedOrigins } from "@/lib/security/csrf"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { startPayment } from "@/lib/candy-purchases/backend-purchases"
import { backendFailure, callerFailure, errorJson, NO_STORE, readJsonBody } from "@/lib/candy-purchases/route-helpers"
import { configuredPaymentProvider } from "@/lib/payments/providers/registry"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 512
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/candy-purchases/[id]/pay (V0.1.51) - start, or resume, paying a
 * pending (or failed) purchase. Body exactly { idempotency_key } (the client
 * mints it once per pay click and reuses it on a retry).
 *
 *   attempt in PostgreSQL (amount = the purchase's payable snapshot)
 *   -> provider session (server-to-server; the provider secret never leaves Next)
 *   -> session recorded -> 200 { checkoutUrl }
 *
 * This credits NOTHING: the wallet changes only when the provider proves the
 * payment (webhook signature or server-side verification). 503
 * payment_unavailable when no provider is configured (production today).
 */
export const POST = withObservability("POST /api/candy-purchases/[id]/pay", handlePost)

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const caller = await verifyParentCaller()
  if (!caller.ok) return callerFailure("coded", caller.reason)

  const limited = await enforceRateLimit(caller.context.identity.subject, RATE_LIMIT_POLICIES.candyPurchaseMutation)
  if (limited) return limited

  const body = await readJsonBody(request, MAX_BODY_BYTES, "coded")
  if (body instanceof NextResponse) return body
  const keys = Object.keys(body)
  const key = body.idempotency_key
  if (keys.length !== 1 || keys[0] !== "idempotency_key" || typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    return errorJson("coded", "INVALID_REQUEST", "درخواست نامعتبر است.", 400)
  }
  const { id } = await params
  if (!id || !UUID.test(id)) return errorJson("coded", "INVALID_PURCHASE_ID", "شناسه خرید نامعتبر است.", 400)
  const purchaseId = id.toLowerCase()

  const provider = configuredPaymentProvider()
  const origin = expectedOrigins()?.[0]
  if (!provider || !origin) {
    return errorJson("coded", "PAYMENT_UNAVAILABLE", "پرداخت آنلاین در حال حاضر فعال نیست.", 503)
  }

  const result = await startPayment(caller.context, provider, {
    purchaseId,
    idempotencyKey: key,
    // Configured origin only (never Host / forwarded headers).
    returnUrl: `${origin}/api/payments/return/${provider.id}`,
  })
  if (result.ok) return NextResponse.json({ checkoutUrl: result.checkoutUrl }, { headers: NO_STORE })
  if (result.kind === "provider_unavailable") {
    return errorJson("coded", "PAYMENT_PROVIDER_UNAVAILABLE", "اتصال به درگاه پرداخت برقرار نشد. لطفاً دوباره تلاش کنید.", 503)
  }
  if (result.kind === "refused") {
    switch (result.error) {
      case "attempt_purchase_not_found":
      case "attempt_purchase_not_owner":
        return errorJson("coded", "PURCHASE_NOT_FOUND", "خرید مورد نظر یافت نشد.", 404)
      case "attempt_purchase_not_retryable":
        return errorJson("coded", "PURCHASE_NOT_PAYABLE", "این خرید قابل پرداخت نیست.", 409)
      case "attempt_nothing_to_charge":
        return errorJson("coded", "NOTHING_TO_CHARGE", "مبلغ نهایی این خرید صفر شده است. تکمیل این نوع خرید پس از افزودن جریان تأیید رایگان فعال خواهد شد.", 409)
      default:
        return errorJson("coded", "PAYMENT_START_FAILED", "شروع پرداخت انجام نشد. لطفاً دوباره تلاش کنید.", 409)
    }
  }
  return backendFailure("coded", result)
}
