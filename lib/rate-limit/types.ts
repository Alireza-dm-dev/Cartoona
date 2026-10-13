/**
 * Provider-neutral rate limiting contracts.
 *
 * Route code depends on these types and on `enforceRateLimit` only. Where the
 * counters live (process memory today; Redis, a platform edge limiter, a
 * database table, ... later) is the `RateLimitStore`'s business and can change
 * without touching any route or policy.
 */

export interface RateLimitPolicy {
  /** Stable machine name: logged, and used to namespace keys. e.g. "request_submit_burst". */
  readonly name: string
  /** Maximum allowed requests per window. */
  readonly limit: number
  readonly windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  policy: string
  limit: number
  /** Requests still allowed in the current window (0 when denied). */
  remaining: number
  /** Epoch milliseconds at which the current window ends. */
  resetAt: number
  /** Whole seconds until the window resets (>= 1 when denied). */
  retryAfterSeconds: number
}

/**
 * Atomically records one attempt against `key` under `policy` and reports the
 * outcome. Implementations MUST be atomic per key (no read-then-write race)
 * and MUST NOT count denied attempts, so a client that keeps hammering does
 * not extend its own lockout.
 *
 * Async on purpose: a distributed store is a network call.
 */
export interface RateLimitStore {
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>
}
