import type { RateLimitPolicy, RateLimitResult, RateLimitStore } from "./types"

/**
 * In-process fixed-window counter store.
 *
 * !! LOCAL / SINGLE-INSTANCE USE ONLY !!
 * State lives in this process's memory. On a deployment with more than one
 * instance (or serverless, where instances come and go) every instance counts
 * separately, so the effective limit is `limit x instances` and resets on every
 * cold start. A shared `RateLimitStore` adapter (Redis/Upstash, a platform
 * limiter, ...) is REQUIRED before multi-instance production. See
 * docs/rate-limiting.md.
 *
 * Fixed window (not sliding): simple, O(1), and maps 1:1 onto INCR+EXPIRE in a
 * distributed store. Its known weakness is a burst of up to 2x `limit` across a
 * window boundary - acceptable for abuse protection, not for billing-grade
 * quotas.
 *
 * Memory is bounded: expired buckets are swept opportunistically (no timers, so
 * nothing keeps a test or the process alive), and a hard cap evicts the oldest
 * buckets if a flood of distinct keys outpaces expiry. Eviction can forget a
 * live bucket, which only ever makes the limiter more lenient - never a memory
 * hazard.
 */

interface Bucket {
  count: number
  resetAt: number
}

export interface InMemoryRateLimitStoreOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number
  /** Hard cap on live buckets. */
  maxBuckets?: number
  /** Sweep expired buckets at most this often. */
  sweepIntervalMs?: number
}

const MAX_KEY_LENGTH = 160

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number
  private readonly maxBuckets: number
  private readonly sweepIntervalMs: number
  private lastSweep = 0

  constructor(options: InMemoryRateLimitStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxBuckets = options.maxBuckets ?? 10_000
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000
    this.lastSweep = this.now()
  }

  /** Live bucket count (diagnostics / tests). */
  get size(): number {
    return this.buckets.size
  }

  // The body is synchronous, so JS's single thread makes each consume atomic;
  // the Promise is only there to satisfy the (possibly networked) interface.
  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = this.now()
    this.maybeSweep(now)

    const bucketKey = `${policy.name}:${key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key}`
    let bucket = this.buckets.get(bucketKey)

    if (!bucket || bucket.resetAt <= now) {
      this.ensureCapacity(bucketKey)
      bucket = { count: 0, resetAt: now + policy.windowMs }
      // Re-insert so Map order tracks creation time (oldest first) for eviction.
      this.buckets.delete(bucketKey)
      this.buckets.set(bucketKey, bucket)
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))

    if (bucket.count >= policy.limit) {
      // Denied attempts are not counted: hammering does not extend the lockout.
      return {
        allowed: false,
        policy: policy.name,
        limit: policy.limit,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterSeconds,
      }
    }

    bucket.count += 1
    return {
      allowed: true,
      policy: policy.name,
      limit: policy.limit,
      remaining: policy.limit - bucket.count,
      resetAt: bucket.resetAt,
      retryAfterSeconds,
    }
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.sweepIntervalMs && this.buckets.size < this.maxBuckets) return
    this.lastSweep = now
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k)
    }
  }

  private ensureCapacity(incomingKey: string): void {
    if (this.buckets.has(incomingKey)) return
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next()
      if (oldest.done) break
      this.buckets.delete(oldest.value)
    }
  }
}
