import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { InMemoryRateLimitStore } from "@/lib/rate-limit/memory-store"
import { enforceRateLimit, setRateLimitStore, rateLimitedResponse } from "@/lib/rate-limit/enforce"
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit/policies"
import { clientIpRateLimitKey, normalizeIp, trustedClientIp, FALLBACK_IP_KEY } from "@/lib/rate-limit/client-ip"
import type { RateLimitPolicy, RateLimitStore } from "@/lib/rate-limit/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"
import { withObservability } from "@/lib/observability/request-context"
import { NextResponse } from "next/server"

const P: RateLimitPolicy = { name: "t_policy", limit: 3, windowMs: 60_000 }

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe("InMemoryRateLimitStore", () => {
  it("allows the first N, rejects N+1, and reports remaining", async () => {
    const c = clock()
    const s = new InMemoryRateLimitStore({ now: c.now })
    const r = [await s.consume("a", P), await s.consume("a", P), await s.consume("a", P), await s.consume("a", P)]
    expect(r.map((x) => x.allowed)).toEqual([true, true, true, false])
    expect(r.map((x) => x.remaining)).toEqual([2, 1, 0, 0])
    expect(r[3]).toMatchObject({ limit: 3, policy: "t_policy" })
  })

  it("resets when the window expires", async () => {
    const c = clock()
    const s = new InMemoryRateLimitStore({ now: c.now })
    for (let i = 0; i < 3; i++) await s.consume("a", P)
    expect((await s.consume("a", P)).allowed).toBe(false)
    c.advance(59_999)
    expect((await s.consume("a", P)).allowed).toBe(false)
    c.advance(1)
    const fresh = await s.consume("a", P)
    expect(fresh).toMatchObject({ allowed: true, remaining: 2 })
  })

  it("Retry-After is whole seconds to the window end, at least 1", async () => {
    const c = clock()
    const s = new InMemoryRateLimitStore({ now: c.now })
    for (let i = 0; i < 3; i++) await s.consume("a", P)
    expect((await s.consume("a", P)).retryAfterSeconds).toBe(60)
    c.advance(30_500)
    expect((await s.consume("a", P)).retryAfterSeconds).toBe(30)
    c.advance(29_499)
    const last = await s.consume("a", P)
    expect(last.retryAfterSeconds).toBe(1)
    expect(last.resetAt).toBe(1_000_000 + 60_000)
  })

  it("denied attempts are not counted, so hammering does not extend the lockout", async () => {
    const c = clock()
    const s = new InMemoryRateLimitStore({ now: c.now })
    for (let i = 0; i < 3; i++) await s.consume("a", P)
    for (let i = 0; i < 100; i++) await s.consume("a", P)
    c.advance(60_000)
    expect((await s.consume("a", P)).allowed).toBe(true)
  })

  it("isolates keys and policies from each other", async () => {
    const s = new InMemoryRateLimitStore({ now: clock().now })
    for (let i = 0; i < 3; i++) await s.consume("user-1", P)
    expect((await s.consume("user-1", P)).allowed).toBe(false)
    expect((await s.consume("user-2", P)).allowed).toBe(true)
    expect((await s.consume("user-1", { ...P, name: "other_policy" })).allowed).toBe(true)
  })

  it("is atomic under concurrency: exactly `limit` of N simultaneous calls pass", async () => {
    const s = new InMemoryRateLimitStore({ now: clock().now })
    const results = await Promise.all(Array.from({ length: 50 }, () => s.consume("a", P)))
    expect(results.filter((r) => r.allowed)).toHaveLength(3)
  })

  it("sweeps expired buckets opportunistically so stale keys do not accumulate", async () => {
    const c = clock()
    const s = new InMemoryRateLimitStore({ now: c.now, sweepIntervalMs: 1000 })
    for (let i = 0; i < 500; i++) await s.consume(`k${i}`, P)
    expect(s.size).toBe(500)
    c.advance(61_000)
    await s.consume("fresh", P) // triggers the sweep
    expect(s.size).toBe(1)
  })

  it("hard-caps memory under a flood of distinct live keys (oldest evicted)", async () => {
    const s = new InMemoryRateLimitStore({ now: clock().now, maxBuckets: 100 })
    for (let i = 0; i < 10_000; i++) await s.consume(`flood-${i}`, P)
    expect(s.size).toBeLessThanOrEqual(100)
  })

  it("truncates an attacker-sized key rather than storing it", async () => {
    const s = new InMemoryRateLimitStore({ now: clock().now })
    for (let i = 0; i < 3; i++) await s.consume("x".repeat(100_000) + "a", P)
    // Same first 160 chars -> same bucket; proves no 100 KB key is retained distinctly.
    expect((await s.consume("x".repeat(100_000) + "b", P)).allowed).toBe(false)
  })

  it("is deterministic with an injected clock and starts no timers", async () => {
    vi.useFakeTimers()
    try {
      const s = new InMemoryRateLimitStore({ now: clock().now })
      await s.consume("a", P)
      await s.consume("b", P)
      expect(vi.getTimerCount()).toBe(0) // opportunistic cleanup only: no interval keeps the process alive
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("enforceRateLimit + 429 contract", () => {
  let records: LogRecord[]
  let restoreSink: () => void
  let c: ReturnType<typeof clock>
  beforeEach(() => {
    records = []
    restoreSink = setLogSink((r) => records.push(r))
    c = clock()
    setRateLimitStore(new InMemoryRateLimitStore({ now: c.now }))
  })
  afterEach(() => { restoreSink(); delete process.env.RATE_LIMIT_DISABLED })

  it("returns null while allowed, then the exact 429 contract", async () => {
    for (let i = 0; i < 3; i++) expect(await enforceRateLimit("u1", P)).toBeNull()
    const res = (await enforceRateLimit("u1", P))!
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: "rate_limited" })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.get("Retry-After")).toBe("60")
    expect(res.headers.get("X-RateLimit-Limit")).toBe("3")
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0")
    expect(res.headers.get("X-RateLimit-Reset")).toBe(String(Math.ceil((1_000_000 + 60_000) / 1000)))
  })

  it("response never carries key material", async () => {
    const res = rateLimitedResponse({ allowed: false, policy: "p", limit: 1, remaining: 0, resetAt: 5000, retryAfterSeconds: 3 })
    expect(JSON.stringify([...res.headers.entries()]) + (await res.text())).not.toMatch(/user|ip:|key/i)
  })

  it("multiple policies: the first denial wins and reports that policy", async () => {
    const burst = { name: "burst", limit: 2, windowMs: 60_000 }
    const hourly = { name: "hourly", limit: 3, windowMs: 3_600_000 }
    expect(await enforceRateLimit("u", burst, hourly)).toBeNull()
    expect(await enforceRateLimit("u", burst, hourly)).toBeNull()
    expect((await enforceRateLimit("u", burst, hourly))!.headers.get("X-RateLimit-Limit")).toBe("2")
    c.advance(61_000)
    expect(await enforceRateLimit("u", burst, hourly)).toBeNull() // 3rd hourly
    const hr = (await enforceRateLimit("u", burst, hourly))!
    expect(hr.headers.get("X-RateLimit-Limit")).toBe("3")
    expect(Number(hr.headers.get("Retry-After"))).toBeGreaterThan(3000)
  })

  it("RATE_LIMITED is logged exactly once per rejection with only safe fields", async () => {
    const handler = withObservability("POST /api/thing", async () => (await enforceRateLimit("secret-user-id-123", { ...P, limit: 1 })) ?? NextResponse.json({}))
    const req = () => new Request("http://x/api/thing", { method: "POST", headers: { "x-request-id": "req-abcdefgh", cookie: "sb=TOKEN", authorization: "Bearer TOKEN" } })
    await handler(req())
    records.length = 0
    const res = await handler(req())
    expect(res.status).toBe(429)
    expect(res.headers.get("X-Request-Id")).toBe("req-abcdefgh")
    const limited = records.filter((r) => r.event === "RATE_LIMITED")
    expect(limited).toHaveLength(1)
    expect(limited[0]).toMatchObject({
      level: "warn", requestId: "req-abcdefgh", route: "POST /api/thing", method: "POST",
      status: 429, policy: "t_policy", retryAfterSeconds: 60, errorCode: "RATE_LIMITED",
    })
    expect(records.filter((r) => r.event === "REQUEST_COMPLETED")).toHaveLength(1)
    expect(JSON.stringify(records)).not.toMatch(/secret-user-id|TOKEN|ip:/)
  })

  it("fails OPEN and logs RATE_LIMITER_FAILED when the store throws, without leaking the error", async () => {
    const broken: RateLimitStore = { consume: async () => { throw new Error("redis password=hunter2 down") } }
    setRateLimitStore(broken)
    expect(await enforceRateLimit("u1", P)).toBeNull()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: "warn", event: "RATE_LIMITER_FAILED", reason: "store_error" })
    expect(JSON.stringify(records)).not.toMatch(/hunter2|redis/)
  })

  it("an empty or oversized key fails open (never shares a bucket or grows one) and is logged", async () => {
    expect(await enforceRateLimit("", P)).toBeNull()
    expect(await enforceRateLimit("k".repeat(1000), P)).toBeNull()
    expect(records.filter((r) => r.event === "RATE_LIMITER_FAILED")).toHaveLength(2)
  })

  it("RATE_LIMIT_DISABLED=1 bypasses (operator escape hatch)", async () => {
    process.env.RATE_LIMIT_DISABLED = "1"
    for (let i = 0; i < 10; i++) expect(await enforceRateLimit("u", P)).toBeNull()
  })

  it("MVP policies are the documented values", () => {
    const p = RATE_LIMIT_POLICIES
    expect([p.requestSubmitBurst.limit, p.requestSubmitBurst.windowMs]).toEqual([5, 60_000])
    expect([p.requestSubmitHourly.limit, p.requestSubmitHourly.windowMs]).toEqual([30, 3_600_000])
    expect([p.finalMediaSign.limit, p.couponValidate.limit, p.couponApply.limit, p.candyPurchaseMutation.limit]).toEqual([30, 20, 10, 10])
    const names = Object.values(p).map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("client IP key (unauthenticated endpoints)", () => {
  afterEach(() => { delete process.env.RATE_LIMIT_TRUSTED_IP_HEADER; delete process.env.RATE_LIMIT_HASH_SECRET })
  const h = (o: Record<string, string>) => new Headers(o)

  it("trusts NO header by default: spoofed X-Forwarded-For cannot choose a bucket", async () => {
    expect(await clientIpRateLimitKey(h({ "x-forwarded-for": "1.2.3.4" }))).toBe(FALLBACK_IP_KEY)
    expect(await clientIpRateLimitKey(h({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" }))).toBe(FALLBACK_IP_KEY)
  })

  it("with an operator-trusted header, uses it; the key is a fixed-length opaque digest, never the IP", async () => {
    process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "x-real-ip"
    const a = await clientIpRateLimitKey(h({ "x-real-ip": "203.0.113.7" }))
    const b = await clientIpRateLimitKey(h({ "x-real-ip": "203.0.113.7" }))
    const other = await clientIpRateLimitKey(h({ "x-real-ip": "203.0.113.8" }))
    expect(a).toBe(b)
    expect(a).not.toBe(other)
    expect(a).toMatch(/^ip:[0-9a-f]{32}$/)
    expect(a).not.toContain("203")
  })

  it("keys from different secrets differ (HMAC, not a bare hash of the IP)", async () => {
    process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "x-real-ip"
    process.env.RATE_LIMIT_HASH_SECRET = "a".repeat(32)
    const a = await clientIpRateLimitKey(h({ "x-real-ip": "203.0.113.7" }))
    process.env.RATE_LIMIT_HASH_SECRET = "b".repeat(32)
    expect(await clientIpRateLimitKey(h({ "x-real-ip": "203.0.113.7" }))).not.toBe(a)
  })

  it("X-Forwarded-For uses the RIGHTMOST entry (client-prepended values are ignored)", () => {
    process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "x-forwarded-for"
    expect(trustedClientIp(h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }))).toBe("203.0.113.9")
    expect(trustedClientIp(h({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it.each(["", "garbage", "999.1.1.1", "1.2.3", "1.2.3.4.5", "<script>", "a".repeat(600), ",,,", "::g", "1:2:3:4:5:6:7:8:9"])(
    "malformed forwarded value %j falls back deterministically",
    async (bad) => {
      process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "x-forwarded-for"
      expect(await clientIpRateLimitKey(h({ "x-forwarded-for": bad }))).toBe(FALLBACK_IP_KEY)
    },
  )

  it("a malformed configured header NAME is ignored", async () => {
    process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "x forwarded\nfor"
    expect(await clientIpRateLimitKey(h({ "x-forwarded-for": "1.2.3.4" }))).toBe(FALLBACK_IP_KEY)
  })

  it("normalizes: ports, brackets, IPv4-mapped IPv6, and collapses IPv6 to its /64", () => {
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7")
    expect(normalizeIp("[2001:db8:1:2:aaaa:bbbb:cccc:dddd]:443")).toBe("2001:db8:1:2::/64")
    expect(normalizeIp("2001:db8:1:2:1::1")).toBe("2001:db8:1:2::/64")
    expect(normalizeIp("2001:DB8:1:2:ffff::")).toBe("2001:db8:1:2::/64")
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7")
    expect(normalizeIp("not an ip")).toBeNull()
  })

  it("never logs or leaks the raw IP through the limiter", async () => {
    process.env.RATE_LIMIT_TRUSTED_IP_HEADER = "x-real-ip"
    const records: LogRecord[] = []
    const restore = setLogSink((r) => records.push(r))
    const store = new InMemoryRateLimitStore({ now: clock().now })
    setRateLimitStore(store)
    const key = await clientIpRateLimitKey(h({ "x-real-ip": "203.0.113.77" }))
    await enforceRateLimit(key, { ...P, limit: 1 })
    await enforceRateLimit(key, { ...P, limit: 1 })
    restore()
    expect(JSON.stringify(records)).not.toContain("203.0.113.77")
    expect(JSON.stringify(records)).not.toContain(key)
  })

  it("unbounded distinct spoofed headers cannot create unbounded buckets (fallback + store cap)", async () => {
    const store = new InMemoryRateLimitStore({ now: clock().now, maxBuckets: 50 })
    for (let i = 0; i < 1000; i++) {
      const key = await clientIpRateLimitKey(h({ "x-forwarded-for": `10.0.${i % 250}.${i % 200}` }))
      await store.consume(key, P)
    }
    expect(store.size).toBe(1)
  })
})
