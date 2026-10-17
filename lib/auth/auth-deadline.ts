import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout"
import { SUPABASE_REQUEST_TIMEOUT_MS } from "@/lib/supabase/timeout-fetch"

/**
 * One deadline for a whole server-side identity check (V0.1.42).
 *
 * Why: when a session cookie holds an EXPIRED access token, `getUser()` first
 * refreshes it, and auth-js retries a failing refresh with exponential backoff
 * inside a 30 s budget. With the provider down, every request carrying such a
 * cookie - public pages included, through the header account lookup - waited
 * ~26 s (measured V0.1.36). The per-request fetch timeout cannot fix that: each
 * attempt is bounded, the loop of attempts is not.
 *
 * How, without touching auth-js internals:
 *  - `createDeadlineFetch(deadlineAt)` is the client's fetch. Each call gets
 *    min(remaining budget, the usual 10 s per-request bound); once the
 *    deadline has passed it throws immediately WITHOUT a network call.
 *  - `withDeadline(promise, ms)` stops the CALLER waiting at the deadline.
 *
 * Why a thrown error and never a fake response: auth-js wraps any fetch
 * exception as AuthRetryableFetchError, and a retryable failure KEEPS the
 * session. A synthetic HTTP error would be non-retryable, and a non-retryable
 * refresh failure with an expired access token makes auth-js delete the session
 * (`_removeSession`), which would turn an outage into a sign-out. After the
 * deadline the library's own loop may keep sleeping in the background until
 * its 30 s budget ends, but it sends nothing more and nobody waits for it.
 */

export class AuthDeadlineError extends Error {
  constructor() {
    super("auth verification deadline exceeded")
    this.name = "AuthDeadlineError"
  }
}

export function createDeadlineFetch(deadlineAt: number, fetchImpl?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw new AuthDeadlineError()
    return fetchWithTimeout(input, init, Math.min(remaining, SUPABASE_REQUEST_TIMEOUT_MS), fetchImpl)
  }
}

export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthDeadlineError()), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
    // The abandoned work must never surface as an unhandled rejection.
    work.catch(() => {})
  }
}
