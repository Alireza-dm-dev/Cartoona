import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { loadParentAccountSummary } from "@/lib/parent/account/backend-account"
import { withObservability } from "@/lib/observability/request-context"

/**
 * GET /api/parent/account-summary (V0.1.46) - the billing page's account
 * values: the candy balance and the welcome image credits. Until V0.1.46 both
 * were part of GET /api/candy-purchases (read from Supabase); they moved here,
 * with the SAME field names, so the purchase history (payment attempts,
 * coupons: still Supabase) and the balance (PostgreSQL) come from separate
 * routes instead of one route reading two databases.
 *
 *   browser -> this route (BFF) -> Supabase Auth verification (once) -> two
 *   signed v2 assertions, in parallel -> Fastify GET /v1/parent/candy-balance
 *   and GET /v1/parent/welcome-credits -> PostgreSQL
 *
 *   200 { wallet: { balance }, welcomeImageCreditsRemaining? }
 *       balance: no wallet row -> 0 (as before). Credits absent when they
 *       could not be read (as before): the note is hidden, billing still works.
 *   400 code no_parent_profile            unchanged message from /api/candy-purchases
 *   401 code unauthenticated              no or rejected session
 *   401 code PARENT_SESSION_EXPIRED       expired or invalidated (local sign-out)
 *   403 code identity_not_linked|forbidden
 *   503 code SESSION_CHECK_UNAVAILABLE    identity provider down/slow (no sign-out)
 *   503 code service_unavailable          balance could not be read (pre-cutover: silently shown as 0)
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const

const LOGIN = "لطفاً ابتدا وارد حساب خود شوید."
const SIGN_IN_AGAIN = "برای ادامه دوباره وارد حساب شوید."
const NOT_ALLOWED = "شما مجوز انجام این عملیات را ندارید."
const NO_PROFILE = "پروفایل والد یافت نشد."
const UNAVAILABLE = "دریافت اطلاعات حساب انجام نشد."

async function handleGet() {
  const result = await loadParentAccountSummary()
  if (result.ok) {
    const { balance, welcomeImageCreditsRemaining } = result.value
    return NextResponse.json(
      { wallet: { balance }, ...(welcomeImageCreditsRemaining !== null ? { welcomeImageCreditsRemaining } : {}) },
      { headers: NO_STORE },
    )
  }

  switch (result.reason) {
    case "no_parent_profile":
      return NextResponse.json({ error: NO_PROFILE, code: "no_parent_profile" }, { status: 400, headers: NO_STORE })
    case "unauthenticated":
      return NextResponse.json({ error: LOGIN, code: "unauthenticated" }, { status: 401, headers: NO_STORE })
    case "session_expired":
    case "session_invalidated":
      await endParentSession()
      return NextResponse.json({ error: SIGN_IN_AGAIN, code: "PARENT_SESSION_EXPIRED" }, { status: 401, headers: NO_STORE })
    case "identity_not_linked":
    case "forbidden":
      return NextResponse.json({ error: NOT_ALLOWED, code: result.reason }, { status: 403, headers: NO_STORE })
    case "auth_unavailable":
      return NextResponse.json(SESSION_CHECK_UNAVAILABLE_BODY, { status: 503, headers: { ...NO_STORE, "Retry-After": "2" } })
    case "service_unavailable":
      return NextResponse.json({ error: UNAVAILABLE, code: "service_unavailable" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "2" } })
  }
}

export const GET = withObservability("GET /api/parent/account-summary", handleGet)
