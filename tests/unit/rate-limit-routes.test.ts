import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { InMemoryRateLimitStore, setRateLimitStore } from "@/lib/rate-limit"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"
import { getSessionResult } from "../helpers/supabase-jwt"

const MiB = 1024 * 1024
const KEY = "11111111-1111-4111-8111-111111111111"
const OID = "123e4567-e89b-42d3-a456-426614174000"

const m = vi.hoisted(() => ({
  userId: "parent-A",
  role: "parent",
  upload: vi.fn(),
  rpc: vi.fn(),
  adminRpc: vi.fn(),
  existingOrder: null as unknown,
  sign: vi.fn(),
  audit: vi.fn(),
  ownership: vi.fn(),
  now: 1_000_000,
}))

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => healthyClient(),
}))
// V0.1.48: the consent gate reads PostgreSQL through the backend; these tests
// cover the (still Supabase) submission path behind it.
vi.mock("@/lib/parent/consent/backend-consent", () => ({
  loadParentConsent: async () => ({ ok: true, status: "granted", consentGrantedAt: "2026-01-01T00:00:00.000Z" }),
}))
vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ rpc: m.rpc }) }))
vi.mock("@/lib/requests/resolve-character", () => ({ resolveCharacterId: async () => ({ ok: true, characterId: null }) }))
vi.mock("@/lib/requests/request-submission", () => ({
  parseAndValidateDraft: () => ({
    ok: true,
    data: { type: "image", title: null, description: "", characterId: null, durationKey: null, durationChoice: null, videoScript: null, videoStyle: null, animationStyle: null, charactersSpeak: null, fileName: null, childName: null },
  }),
}))
vi.mock("@/lib/audit/final-media-audit", () => ({ recordFinalMediaAudit: m.audit }))
vi.mock("@/lib/parent/orders/final-media-queries", () => ({
  resolveParentOwnsOrder: m.ownership,
  resolveCurrentParentFinalMedia: async () => ({ id: OID, path: "final/x.mp4", mimeType: "video/mp4", fileName: "x.mp4" }),
}))
vi.mock("@/lib/storage/private-signed-url", () => ({
  PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS: 300,
  PRIVATE_UPLOADS_BUCKET: "parent-uploads",
  createPrivateSignedUrl: m.sign,
}))

const chain = (data: unknown) => ({
  select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.existingOrder, error: null }) }), maybeSingle: async () => ({ data, error: null }) }) }),
})
function healthyClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: m.userId } }, error: null }), getSession: async () => getSessionResult("valid", m.userId), signOut: vi.fn() },
    rpc: async () => ({ data: [{ is_valid: true, session_started_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-31T00:00:00Z" }], error: null }),
    from: (t: string) => t === "users" ? chain({ role: m.role }) : t === "parent_profiles" ? chain({ id: "p1" }) : chain(null),
    storage: { from: () => ({ upload: m.upload, remove: async () => ({ error: null }) }) },
  }
}

let records: LogRecord[]
let restoreSink: () => void
beforeEach(() => {
  records = []
  restoreSink = setLogSink((r) => records.push(r))
  m.now = 1_000_000
  setRateLimitStore(new InMemoryRateLimitStore({ now: () => m.now }))
  m.userId = "parent-A"
  m.role = "parent"
  m.existingOrder = null
  m.upload.mockReset().mockResolvedValue({ error: null })
  m.rpc.mockReset().mockResolvedValue({ data: [{ id: OID, type: "image", status: "pending", candy_cost: 1, replayed: false }], error: null })
  m.sign.mockReset().mockResolvedValue("https://signed.example/x?token=abc")
  m.audit.mockReset().mockResolvedValue(undefined)
  m.ownership.mockReset().mockImplementation(async () => ({ ok: true, userId: m.userId }))
})
afterEach(() => restoreSink())

function submit(headers: Record<string, string> = {}) {
  const r = new Request("http://x/api/requests", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", ...headers }, body: "x" })
  const fields: Record<string, unknown> = { draft: "{}", submissionKey: KEY, file: { size: 100, type: "image/png", name: "a.png" }, sourceAssetId: null }
  ;(r as unknown as { formData: unknown }).formData = async () => ({ get: (k: string) => fields[k] ?? null })
  return r
}
const POST = async () => (await import("@/app/api/requests/route")).POST

describe("POST /api/requests rate limiting", () => {
  it("allows 5 submissions per minute per parent, the 6th is a 429 that does no expensive work", async () => {
    const route = await POST()
    for (let i = 0; i < 5; i++) expect((await route(submit())).status).toBe(200)
    expect(m.upload).toHaveBeenCalledTimes(5)
    expect(m.rpc).toHaveBeenCalledTimes(5)

    const res = await route(submit())
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: "rate_limited" })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
    expect(res.headers.get("X-Request-Id")).toBeTruthy()
    // No upload, no storage copy, no order RPC for the rejected request.
    expect(m.upload).toHaveBeenCalledTimes(5)
    expect(m.rpc).toHaveBeenCalledTimes(5)
  })

  it("different parents have separate buckets; the same parent shares one", async () => {
    const route = await POST()
    for (let i = 0; i < 5; i++) await route(submit())
    expect((await route(submit())).status).toBe(429)
    m.userId = "parent-B"
    expect((await route(submit())).status).toBe(200)
    m.userId = "parent-A"
    expect((await route(submit())).status).toBe(429)
  })

  it("the window reopens after a minute", async () => {
    const route = await POST()
    for (let i = 0; i < 5; i++) await route(submit())
    expect((await route(submit())).status).toBe(429)
    m.now += 60_000
    expect((await route(submit())).status).toBe(200)
  })

  it("the hourly cap (30) holds across minute windows", async () => {
    const route = await POST()
    let ok = 0
    for (let minute = 0; minute < 8; minute++) {
      for (let i = 0; i < 5; i++) if ((await route(submit())).status === 200) ok++
      m.now += 61_000
    }
    expect(ok).toBe(30)
  })

  it("is keyed by user id, never by IP: spoofed forwarding headers change nothing", async () => {
    const route = await POST()
    for (let i = 0; i < 5; i++) await route(submit({ "x-forwarded-for": `9.9.9.${i}` }))
    expect((await route(submit({ "x-forwarded-for": "1.1.1.1" }))).status).toBe(429)
  })

  it("rejected requests create no order and the same idempotency key never yields two orders", async () => {
    const route = await POST()
    // A new submission, then replays of the same key (existing order found).
    expect((await route(submit())).status).toBe(200)
    m.existingOrder = { id: OID, type: "image", status: "pending", candy_cost: 1 }
    const replay = await (await route(submit())).json()
    expect(replay).toMatchObject({ orderId: OID, replayed: true })
    for (let i = 0; i < 3; i++) await route(submit())
    // Burn through the limit, then confirm a limited retry creates nothing.
    const rpcCallsBefore = m.rpc.mock.calls.length
    const limited = await route(submit())
    expect(limited.status).toBe(429)
    expect(m.rpc.mock.calls.length).toBe(rpcCallsBefore)
    expect(m.rpc).toHaveBeenCalledTimes(1) // only the very first request ever created an order
    expect(m.upload).toHaveBeenCalledTimes(1)
  })

  it("the oversize guard still runs first, and does not spend the parent's budget", async () => {
    const route = await POST()
    for (let i = 0; i < 20; i++) expect((await route(submit({ "content-length": String(60 * MiB) }))).status).toBe(413)
    expect((await route(submit())).status).toBe(200)
  })

  it("logs RATE_LIMITED once with the request id and no key material", async () => {
    const route = await POST()
    for (let i = 0; i < 5; i++) await route(submit())
    records.length = 0
    const res = await route(submit({ "x-request-id": "client-req-0001" }))
    expect(res.headers.get("X-Request-Id")).toBe("client-req-0001")
    const limited = records.filter((r) => r.event === "RATE_LIMITED")
    expect(limited).toHaveLength(1)
    expect(limited[0]).toMatchObject({ requestId: "client-req-0001", route: "POST /api/requests", method: "POST", status: 429, policy: "request_submit_burst" })
    expect(typeof limited[0].retryAfterSeconds).toBe("number")
    expect(JSON.stringify(records)).not.toMatch(/parent-A|parent-B|ip:/)
  })
})

describe("POST /api/parent/orders/[orderId]/final-media rate limiting", () => {
  const call = async () =>
    (await import("@/app/api/parent/orders/[orderId]/final-media/route")).POST(
      new Request("http://x", { method: "POST" }),
      { params: Promise.resolve({ orderId: OID }) },
    )

  it("30 per minute per parent; the 31st mints no URL and writes no audit row", async () => {
    for (let i = 0; i < 30; i++) expect((await call()).status).toBe(200)
    expect(m.sign).toHaveBeenCalledTimes(30)
    expect(m.audit).toHaveBeenCalledTimes(30)
    const res = await call()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: "rate_limited" })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(m.sign).toHaveBeenCalledTimes(30)
    expect(m.audit).toHaveBeenCalledTimes(30)
  })

  it("ownership checks remain intact: a foreign/missing order is rejected and never reaches signing", async () => {
    m.ownership.mockResolvedValue({ ok: false, reason: "not_found" })
    const res = await call()
    expect(res.status).toBe(404)
    expect(m.sign).not.toHaveBeenCalled()
  })

  it("a limited parent does not affect another parent", async () => {
    for (let i = 0; i < 31; i++) await call()
    m.userId = "parent-B"
    expect((await call()).status).toBe(200)
  })
})

describe("coupon / purchase routes", () => {
  const json = (url: string, body: unknown) =>
    new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  it("coupon validate: business behaviour is unchanged below the limit, 429 at 21 with no RPC", async () => {
    const { POST: validate } = await import("@/app/api/coupons/validate/route")
    const rpcCoupon = { normalized_code: "SAVE10", discount_type: "percent", original_price_amount: 100, discount_amount: 10, final_price_amount: 90, currency: "IRR" }
    m.rpc.mockResolvedValue({ data: [rpcCoupon], error: null })
    const body = { purchase_id: OID, code: "save10" }

    const first = await validate(json("http://x/api/coupons/validate", body))
    expect(first.status).toBe(200)
    expect((await first.json()).coupon).toMatchObject({ normalizedCode: "SAVE10", finalPriceAmount: 90 })
    expect(m.rpc.mock.calls[0][1]).toMatchObject({ p_purchase_id: OID, p_coupon_code: "SAVE10", p_parent_profile_id: "p1" })

    // Existing validation errors still surface as before (and still count).
    const bad = await validate(json("http://x/api/coupons/validate", { purchase_id: OID, code: "!!" }))
    expect(bad.status).toBe(400)

    for (let i = 0; i < 18; i++) await validate(json("http://x/api/coupons/validate", body))
    const callsAtLimit = m.rpc.mock.calls.length
    const limited = await validate(json("http://x/api/coupons/validate", body))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: "rate_limited" })
    expect(m.rpc.mock.calls.length).toBe(callsAtLimit)
  })

  it("coupon apply (10/min) and purchase creation (10/min) are limited before role/RPC work", async () => {
    const { POST: apply } = await import("@/app/api/candy-purchases/[id]/coupon/route")
    const { POST: create } = await import("@/app/api/candy-purchases/route")
    m.role = "admin" // downstream is a cheap, deterministic 403 - proves the limiter ran first and left behaviour alone
    for (let i = 0; i < 10; i++) {
      expect((await apply(json("http://x", { code: "A" }), { params: Promise.resolve({ id: OID }) })).status).toBe(403)
    }
    expect((await apply(json("http://x", { code: "A" }), { params: Promise.resolve({ id: OID }) })).status).toBe(429)

    for (let i = 0; i < 10; i++) expect((await create(json("http://x", { package_id: OID }))).status).toBe(403)
    expect((await create(json("http://x", { package_id: OID }))).status).toBe(429)
    expect(m.rpc).not.toHaveBeenCalled()
  })
})

describe("wiring: every protected route limits after identity and before expensive work", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8")
  const cases: [string, RegExp, RegExp[]][] = [
    ["app/api/requests/route.ts", /auth\.getUser\(\)/, [/request\.formData\(\)/, /\.upload\(/, /\.copy\(/, /\.rpc\(\s*"create_parent_request_trusted"/]],
    ["app/api/coupons/validate/route.ts", /auth\.getUser\(\)/, [/validate_coupon_for_purchase_trusted/]],
    ["app/api/candy-purchases/[id]/coupon/route.ts", /auth\.getUser\(\)/, [/\.rpc\(/]],
    ["app/api/candy-purchases/[id]/complete/route.ts", /auth\.getUser\(\)/, [/\.rpc\(/]],
    ["app/api/candy-purchases/route.ts", /auth\.getUser\(\)/, [/\.insert\(/]],
    ["app/api/parent/password/route.ts", /auth\.getUser\(\)/, [/updateUser|updateUserById|\.auth\.admin/]],
    ["app/api/parent/orders/[orderId]/final-media/route.ts", /resolveParentOwnsOrder\(/, [/createPrivateSignedUrl\(/, /recordFinalMediaAudit\(/]],
  ]
  it.each(cases)("%s", (file, identity, expensive) => {
    const src = read(file)
    const limit = src.lastIndexOf("enforceRateLimit(")
    expect(limit, "enforceRateLimit missing").toBeGreaterThan(-1)
    expect(src.search(identity)).toBeLessThan(limit)
    for (const re of expensive) {
      const at = src.search(re)
      if (at !== -1) expect(limit, `${re} runs before the limiter`).toBeLessThan(at)
    }
  })

  it("reads are not limited (normal navigation / load-more must never 429)", () => {
    for (const f of ["app/api/parent/gallery/route.ts", "app/api/parent/orders/route.ts"]) {
      expect(read(f)).not.toContain("enforceRateLimit")
    }
  })
})
