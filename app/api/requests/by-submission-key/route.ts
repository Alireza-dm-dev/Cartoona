import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { lookupRequestBySubmissionKey } from "@/lib/requests/backend-request"
import { isValidSubmissionKey } from "@/lib/requests/submission-key"
import { withObservability } from "@/lib/observability/request-context"

/**
 * GET /api/requests/by-submission-key?submissionKey=<uuid> (V0.1.50)
 *
 * The recovery read for an uncertain submission: "did my submit create an
 * order?". Browser -> Supabase Auth verification -> v2 assertion -> Fastify
 * GET /v1/parent/requests/by-submission-key -> PostgreSQL.
 *
 *   200 { found: false }
 *   200 { found: true, orderId, type, status, candyCost, paymentSource }
 *   400 invalid_submission_key        the query is exactly one UUID `submissionKey`
 *   401 unauthenticated | PARENT_SESSION_EXPIRED
 *   403 forbidden | no_parent_profile
 *   503 service_unavailable           could not determine - NOT "not found"
 *
 * The backend resolves the parent from the assertion and searches only that
 * parent's orders: another parent's key answers `found: false`, exactly like
 * an unused key, so it cannot be used to probe. No user or profile id is
 * accepted and nothing is written. Never cached; no CSRF check (no side
 * effect).
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const
const RETRY = { ...NO_STORE, "Retry-After": "2" } as const

const json = (body: unknown, status: number, headers: Record<string, string> = NO_STORE) =>
  NextResponse.json(body, { status, headers })

async function handleGet(request: Request) {
  const params = new URL(request.url).searchParams
  const names = [...params.keys()]
  const key = params.get("submissionKey")
  if (names.length !== 1 || names[0] !== "submissionKey" || !isValidSubmissionKey(key)) {
    return json({ error: "شناسه درخواست نامعتبر است.", code: "invalid_submission_key" }, 400)
  }

  const caller = await verifyParentCaller()
  if (!caller.ok) {
    switch (caller.reason) {
      case "session_expired":
        await endParentSession()
        return json({ error: "برای ادامه دوباره وارد حساب شوید.", code: "PARENT_SESSION_EXPIRED" }, 401)
      case "auth_unavailable":
        return json(SESSION_CHECK_UNAVAILABLE_BODY, 503, RETRY)
      default:
        return json({ error: "لطفاً ابتدا وارد حساب خود شوید.", code: "unauthenticated" }, 401)
    }
  }

  const result = await lookupRequestBySubmissionKey(caller.context, key)
  if (result.ok) {
    if (!result.found) return json({ found: false }, 200)
    const { orderId, type, status, candyCost, paymentSource } = result.order
    return json({ found: true, orderId, type, status, candyCost, paymentSource }, 200)
  }
  switch (result.reason) {
    case "session_expired":
    case "session_invalidated":
      await endParentSession()
      return json({ error: "برای ادامه دوباره وارد حساب شوید.", code: "PARENT_SESSION_EXPIRED" }, 401)
    case "identity_not_linked":
    case "forbidden":
      return json({ error: "شما مجوز انجام این عملیات را ندارید.", code: "forbidden" }, 403)
    case "no_parent_profile":
      return json({ error: "پروفایل والد یافت نشد.", code: "no_parent_profile" }, 403)
    default:
      return json({ error: "بررسی وضعیت درخواست موقتاً ممکن نیست.", code: "service_unavailable" }, 503, RETRY)
  }
}

export const GET = withObservability("GET /api/requests/by-submission-key", handleGet)
