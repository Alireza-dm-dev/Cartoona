import { NextResponse } from "next/server"
import { withObservability, log } from "@/lib/observability/request-context"
import { paymentProviderFor } from "@/lib/payments/providers/registry"
import { isWriteFrozen } from "@/lib/security/csrf"
import { deliverProviderEvent } from "@/lib/candy-purchases/backend-purchases"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/payments/webhooks/[provider] (V0.1.51) - PROVIDER-authenticated.
 *
 * Not a browser route: no CSRF guard, no cookie, no Supabase session. The ONLY
 * authentication is the provider's signature over the RAW body (adapter
 * `verifyWebhook`: HMAC, timestamp tolerance, constant-time compare), checked
 * before the body is parsed. A verified event is handed to the backend with a
 * service assertion (POST /v1/payments/events), where one transaction dedupes
 * it, checks the amount and credits the wallet at most once.
 *
 *   200 { status: <outcome> }        handled (incl. duplicates and mismatches: never retried)
 *   200 { status: "ignored" }        a verified event type we do not act on
 *   401 { error: "invalid_signature" }  forged, tampered or stale
 *   404                              unknown / unconfigured provider
 *   500 { error: "retry" }           the backend did not confirm: the provider retries
 *
 * Nothing from the payload is logged except our outcome token.
 */
const MAX_BODY = 16 * 1024

export const POST = withObservability("POST /api/payments/webhooks/[provider]", handlePost)

async function handlePost(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await params
  const adapter = paymentProviderFor(providerId)
  if (!adapter) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } })

  // Cutover write freeze: not processed, so the provider retries after the freeze.
  if (isWriteFrozen()) return NextResponse.json({ error: "retry" }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "120" } })

  const raw = await request.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413 })
  const verified = adapter.verifyWebhook(raw, request.headers)
  if (!verified.ok) {
    log("warn", "PAYMENT_WEBHOOK_REJECTED", { subsystem: "payment", reason: verified.reason })
    return NextResponse.json({ error: "invalid_signature" }, { status: 401, headers: { "Cache-Control": "no-store" } })
  }
  if (!verified.event) return NextResponse.json({ status: "ignored" }, { headers: { "Cache-Control": "no-store" } })

  const delivered = await deliverProviderEvent(adapter.id, verified.event)
  if (!delivered.ok) {
    log("warn", "PAYMENT_WEBHOOK_NOT_CONFIRMED", { subsystem: "payment" })
    return NextResponse.json({ error: "retry" }, { status: 500, headers: { "Cache-Control": "no-store" } })
  }
  log("info", "PAYMENT_WEBHOOK_HANDLED", { subsystem: "payment", reason: delivered.outcome })
  return NextResponse.json({ status: delivered.outcome }, { headers: { "Cache-Control": "no-store" } })
}
