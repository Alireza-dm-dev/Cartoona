import "server-only"

import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import type { CallFailure } from "@/lib/backend/call"

/**
 * Shared answers for browser-facing Next routes that call the backend (V0.1.53:
 * referrals, homepage and examples admin). Persian texts match the routes they
 * replaced. Nothing here reads a role: the BACKEND refuses a caller that may not
 * use the route (403), and these helpers only translate that into the HTTP answer.
 */

export const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const
const RETRY = { ...NO_STORE, "Retry-After": "2" } as const

export function flatError(message: string, status: number, code?: string, headers: Record<string, string> = NO_STORE): NextResponse {
  return NextResponse.json(code ? { error: message, code } : { error: message }, { status, headers })
}

/** Verify the session with the identity provider (no role decision here). */
export async function verifiedCaller(): Promise<{ ok: true; context: VerifiedAuthContext } | { ok: false; response: NextResponse }> {
  const caller = await verifyParentCaller()
  if (caller.ok) return { ok: true, context: caller.context }
  if (caller.reason === "auth_unavailable") return { ok: false, response: NextResponse.json(SESSION_CHECK_UNAVAILABLE_BODY, { status: 503, headers: RETRY }) }
  if (caller.reason === "session_expired") {
    await endParentSession()
    return { ok: false, response: flatError("برای ادامه دوباره وارد حساب خود شوید.", 401, "PARENT_SESSION_EXPIRED") }
  }
  return { ok: false, response: flatError("لطفاً ابتدا وارد حساب خود شوید.", 401) }
}

/** The answer for a failed backend call that is NOT a business refusal (those are mapped per route). */
export async function callFailureResponse(failure: Exclude<CallFailure, { kind: "refused" }>, unavailableMessage: string): Promise<NextResponse> {
  if (failure.kind === "auth") {
    switch (failure.reason) {
      case "unauthenticated":
        return flatError("لطفاً ابتدا وارد حساب خود شوید.", 401)
      case "session_expired":
      case "session_invalidated":
        await endParentSession()
        return flatError("برای ادامه دوباره وارد حساب خود شوید.", 401, "PARENT_SESSION_EXPIRED")
      default:
        return flatError("شما مجوز انجام این عملیات را ندارید.", 403)
    }
  }
  // An uncertain WRITE is never reported as "not saved".
  return flatError(
    failure.outcomeUnknown ? "نتیجه عملیات مشخص نیست. صفحه را دوباره بارگذاری کنید." : unavailableMessage,
    503,
    failure.outcomeUnknown ? "OUTCOME_UNKNOWN" : "SERVICE_UNAVAILABLE",
    RETRY,
  )
}
