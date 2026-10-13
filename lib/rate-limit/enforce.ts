import "server-only"
import { NextResponse } from "next/server"
import { InMemoryRateLimitStore } from "./memory-store"
import type { RateLimitPolicy, RateLimitResult, RateLimitStore } from "./types"
import { log } from "@/lib/observability/request-context"

/**
 * The only entry point routes use:
 *
 *   const limited = await enforceRateLimit(user.id, RATE_LIMIT_POLICIES.couponValidate)
 *   if (limited) return limited
 *
 * Several policies may be passed (e.g. per-minute + per-hour). They are checked
 * in order and the first denial wins. Trade-off: an attempt denied by a later
 * policy has already counted against the earlier ones; for abuse protection
 * that slight over-counting is harmless and avoids a two-phase commit.
 */

let store: RateLimitStore = new InMemoryRateLimitStore()

/** Swap the backing store (a distributed adapter in production; a fake in tests). */
export function setRateLimitStore(next: RateLimitStore): RateLimitStore {
  const previous = store
  store = next
  return previous
}

/** Emergency / e2e switch. Never set in production unless you mean it. */
function disabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === "1"
}

// Identity keys come from verified server-side values (a user id) or from
// clientIpRateLimitKey; never from raw headers, cookies or tokens. This guards
// against a caller passing something unexpectedly large or empty.
function usableKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && key.length <= 160
}

export function rateLimitedResponse(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: "rate_limited" },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
      },
    },
  )
}

/**
 * Returns a 429 response when limited, otherwise null.
 *
 * Fail-OPEN: if the limiter itself throws, the request proceeds and a safe
 * RATE_LIMITER_FAILED event is logged. A limiter outage must not take the app
 * down for legitimate users; the cost is that abuse protection is briefly off,
 * which the log makes visible.
 */
export async function enforceRateLimit(
  key: string,
  ...policies: RateLimitPolicy[]
): Promise<NextResponse | null> {
  if (disabled()) return null
  if (!usableKey(key)) {
    log("warn", "RATE_LIMITER_FAILED", { subsystem: "request", errorCode: "INTERNAL_ERROR", reason: "invalid_key" })
    return null
  }

  try {
    for (const policy of policies) {
      const result = await store.consume(key, policy)
      if (!result.allowed) {
        // Once per rejected request. Policy name and timing only - never the key.
        log("warn", "RATE_LIMITED", {
          subsystem: "request",
          status: 429,
          errorCode: "RATE_LIMITED",
          policy: policy.name,
          retryAfterSeconds: result.retryAfterSeconds,
        })
        return rateLimitedResponse(result)
      }
    }
    return null
  } catch {
    log("warn", "RATE_LIMITER_FAILED", { subsystem: "request", errorCode: "INTERNAL_ERROR", reason: "store_error" })
    return null
  }
}
