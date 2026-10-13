import "server-only"
import { isAuthRetryableFetchError } from "@supabase/supabase-js"
import { log } from "./request-context"
import { categorizeError } from "./errors"

/**
 * Record why `auth.getUser()` produced no user, at the right volume.
 *
 *  - infrastructure failure (network / backend / timeout): warn - actionable.
 *  - a definite "no valid user": debug only. Expected traffic; the
 *    REQUEST_COMPLETED 401 already counts it, and it must not look like an
 *    incident.
 *
 * Never logs the token, cookies, user id or error text.
 */
export function logAuthLookup(authError: unknown): void {
  if (authError && isAuthRetryableFetchError(authError as Parameters<typeof isAuthRetryableFetchError>[0])) {
    log("warn", "AUTH_USER_LOOKUP_FAILED", {
      subsystem: "auth",
      errorCode: categorizeError(authError, "auth"),
    })
    return
  }
  log("debug", "AUTH_UNAUTHENTICATED", { subsystem: "auth" })
}
