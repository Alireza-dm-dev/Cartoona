import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { loadParentWelcomeCredits } from "@/lib/parent/account/backend-account"
import { withObservability } from "@/lib/observability/request-context"

/**
 * GET /api/parent/welcome-credits
 *
 * { welcomeImageCreditsRemaining: number } for the signed-in parent. A display
 * hint for the creation review; the request RPC remains the authority on what
 * actually pays. Nothing about the ledger (ids, grant or usage rows) is
 * exposed.
 *
 * V0.1.46: served by the backend.
 *
 *   browser -> this route (BFF) -> Supabase Auth verification -> signed v2
 *   assertion -> Fastify GET /v1/parent/welcome-credits -> PostgreSQL
 *
 * This route reads no business data itself (no Supabase table or RPC, no pg,
 * no repository), and nothing the browser sends can name the caller.
 *
 *   200 { welcomeImageCreditsRemaining }   a parent with no profile or no grant row: 0
 *   401 code unauthenticated               no or rejected session
 *   401 code PARENT_SESSION_EXPIRED        expired or invalidated session (local sign-out), body unchanged
 *   403 code identity_not_linked|forbidden not a linked parent account
 *   503 code SESSION_CHECK_UNAVAILABLE     identity provider down/slow (no sign-out), body unchanged
 *   503 code service_unavailable           backend or database down/slow/malformed (was a 500)
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const

const LOGIN = "لطفاً ابتدا وارد حساب خود شوید"
const SIGN_IN_AGAIN = "برای ادامه دوباره وارد حساب شوید."
const NOT_ALLOWED = "شما مجوز انجام این عملیات را ندارید."
const UNAVAILABLE = "اعتبار رایگان در دسترس نیست."

async function handleGet() {
  const result = await loadParentWelcomeCredits()
  if (result.ok) return NextResponse.json({ welcomeImageCreditsRemaining: result.value }, { headers: NO_STORE })

  switch (result.reason) {
    case "no_parent_profile":
      // Unchanged: a parent who has not finished signup has no credits yet.
      return NextResponse.json({ welcomeImageCreditsRemaining: 0 }, { headers: NO_STORE })
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

export const GET = withObservability("GET /api/parent/welcome-credits", handleGet)
