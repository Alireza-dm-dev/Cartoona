import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import {
  createParentSessionFailureResponse,
  createSessionCheckUnavailableResponse,
} from "@/lib/auth/expired-parent-session-response"
import { resolveParentRequestContext } from "@/lib/parent/parent-request-context"
import { readWelcomeImageCredits } from "@/lib/credits/welcome-image-credits"
import { withObservability, log } from "@/lib/observability/request-context"

/**
 * GET /api/parent/welcome-credits
 *
 * { welcomeImageCreditsRemaining: number } for the signed-in parent. A display
 * hint for the creation review and billing screens; the request RPC remains the
 * authority on what actually pays. Nothing about the ledger (ids, grant or usage
 * rows) is exposed.
 */
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const

export const GET = withObservability("GET /api/parent/welcome-credits", handleGet)

async function handleGet() {
  const supabase = await createServerSupabaseClient()
  const ctx = await resolveParentRequestContext(supabase, { verify: "full" })

  if (!ctx.ok) {
    switch (ctx.reason) {
      case "unauthenticated":
        return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401, headers: NO_STORE })
      case "auth_unavailable":
        return createSessionCheckUnavailableResponse()
      case "not_parent":
        return NextResponse.json({ error: "شما مجوز انجام این عملیات را ندارید." }, { status: 403, headers: NO_STORE })
      case "session_invalid":
        return createParentSessionFailureResponse(supabase, ctx.lifetime)
      case "no_parent_profile":
        return NextResponse.json({ welcomeImageCreditsRemaining: 0 }, { headers: NO_STORE })
      default:
        return NextResponse.json({ error: "اعتبار رایگان در دسترس نیست." }, { status: 500, headers: NO_STORE })
    }
  }

  const remaining = await readWelcomeImageCredits(supabase, ctx.context.parentProfileId)
  if (remaining === null) {
    log("warn", "WELCOME_CREDITS_READ_FAILED", { subsystem: "database", errorCode: "DATABASE_UNAVAILABLE" })
    return NextResponse.json({ error: "اعتبار رایگان در دسترس نیست." }, { status: 500, headers: NO_STORE })
  }

  return NextResponse.json({ welcomeImageCreditsRemaining: remaining }, { headers: NO_STORE })
}
