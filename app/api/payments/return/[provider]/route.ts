import { NextResponse } from "next/server"
import { withObservability, log } from "@/lib/observability/request-context"
import { expectedOrigins } from "@/lib/security/csrf"
import { paymentProviderFor } from "@/lib/payments/providers/registry"
import { PaymentProviderError } from "@/lib/payments/providers/types"
import { deliverProviderEvent } from "@/lib/candy-purchases/backend-purchases"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/payments/return/[provider]?session=<id> (V0.1.51) - where the
 * provider sends the BROWSER back after checkout.
 *
 * The query string is never trusted as a result: it only names a session, and
 * the server asks the PROVIDER (adapter `verifySession`, server-to-server with
 * the provider API key) what happened. A provider-confirmed result is handed to
 * the backend exactly like a webhook (deterministic event id per verification,
 * so repeated returns are duplicates; a webhook for the same payment is
 * `already_paid`). Then 303 to the billing page with a display hint only:
 *
 *   /dashboard/billing?payment=paid | failed | pending | unknown
 *
 * The billing page re-reads the PostgreSQL state; the hint never decides it.
 */
export const GET = withObservability("GET /api/payments/return/[provider]", handleGet)

const SESSION = /^[A-Za-z0-9._:-]{1,200}$/

async function handleGet(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const origin = expectedOrigins()?.[0]
  const back = (hint: string) =>
    NextResponse.redirect(`${origin ?? ""}/dashboard/billing?payment=${hint}`, { status: 303, headers: { "Cache-Control": "no-store" } })
  if (!origin) return NextResponse.json({ error: "not_configured" }, { status: 503 })

  const { provider: providerId } = await params
  const adapter = paymentProviderFor(providerId)
  const session = new URL(request.url).searchParams.get("session")
  if (!adapter || !session || !SESSION.test(session)) return back("unknown")

  let result
  try {
    result = await adapter.verifySession(session)
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error
    log("warn", "PAYMENT_RETURN_VERIFY_FAILED", { subsystem: "payment", errorCode: error.kind })
    return back("unknown")
  }
  if (result.type === "payment.pending") return back("pending")
  const delivered = await deliverProviderEvent(adapter.id, result)
  if (!delivered.ok) return back("unknown")
  log("info", "PAYMENT_RETURN_HANDLED", { subsystem: "payment", reason: delivered.outcome })
  if (result.type === "payment.failed") return back("failed")
  return back(delivered.outcome === "processed" || delivered.outcome === "already_paid" || delivered.outcome === "duplicate_event" ? "paid" : "unknown")
}
