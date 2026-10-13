import { NextResponse } from "next/server"
import type { ParentSessionLifetimeResult } from "@/lib/auth/parent-session-lifetime"
import { log } from "@/lib/observability/request-context"

const EXPIRED_SESSION_BODY = {
  error: "برای ادامه دوباره وارد حساب شوید.",
  code: "PARENT_SESSION_EXPIRED",
}

async function localSignOut(
  supabase: { auth: { signOut: (opts: { scope: "local" }) => Promise<unknown> } },
): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: "local" })
  } catch {
    // Fail closed — return expired response even if sign-out fails
  }
}

export async function createExpiredParentSessionResponse(
  supabase: { auth: { signOut: (opts: { scope: "local" }) => Promise<unknown> } },
): Promise<NextResponse> {
  await localSignOut(supabase)
  return NextResponse.json(EXPIRED_SESSION_BODY, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

export const SESSION_CHECK_UNAVAILABLE_BODY = {
  error: "بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.",
  code: "SESSION_CHECK_UNAVAILABLE",
}

/**
 * Retryable answer for a lifetime lookup that could not be completed.
 *
 * Fails closed (no protected data) but is NOT an expiry: it never signs the
 * user out, so the still-valid session survives and a retry just works. 503
 * rather than 401, because 401 means "your session is invalid".
 */
export function createSessionCheckUnavailableResponse(): NextResponse {
  return NextResponse.json(SESSION_CHECK_UNAVAILABLE_BODY, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "2",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/**
 * Response for a parent session that did not pass the lifetime check.
 *
 * Only a definite expiry / missing session ends the session. A transient
 * `lookup_failed` must never reach signOut.
 */
export async function createParentSessionFailureResponse(
  supabase: { auth: { signOut: (opts: { scope: "local" }) => Promise<unknown> } },
  lifetime: Extract<ParentSessionLifetimeResult, { valid: false }>,
): Promise<NextResponse> {
  if (lifetime.reason === "lookup_failed") {
    // Infrastructure problem, not an expiry: the session is kept (see above).
    log("warn", "SESSION_LOOKUP_FAILED", {
      subsystem: "auth",
      errorCode: "AUTH_UNAVAILABLE",
      reason: lifetime.reason,
    })
    return createSessionCheckUnavailableResponse()
  }
  log("info", "SESSION_EXPIRED", { subsystem: "auth", reason: lifetime.reason })
  return createExpiredParentSessionResponse(supabase)
}
