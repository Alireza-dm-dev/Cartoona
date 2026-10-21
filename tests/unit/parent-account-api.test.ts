import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id"
import { verifyAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import type { IdentityVerification } from "@/lib/auth/supabase-identity-adapter"

/**
 * GET /api/parent/welcome-credits and GET /api/parent/account-summary as BFFs
 * (V0.1.46), in-process: the identity adapter is mocked, the REAL backend
 * client signs real assertions, and `fetch` stands in for Fastify. Proves the
 * requests they send, the public contracts they keep, and the mapping of every
 * auth/backend outcome. The real chain (stub provider -> Next -> Fastify ->
 * PostgreSQL) is parent-account-cutover-db.test.ts.
 */

const m = vi.hoisted(() => ({
  verification: null as unknown,
  verifyCalls: 0,
  signOut: vi.fn(async () => ({ error: null })),
}))
vi.mock("@/lib/auth/supabase-identity-adapter", () => ({
  verifySupabaseIdentity: async () => {
    m.verifyCalls += 1
    return m.verification
  },
}))
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ auth: { signOut: m.signOut } }),
}))

const SECRET_HEX = "68".repeat(32)
const BASE = "http://backend.internal.test:4000"
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"

let records: LogRecord[]
let restore: () => void
let fetchCalls: { url: string; headers: Record<string, string> }[]
/** Per backend path; default: a healthy parent with 42 candy and 2 credits. */
let answers: Record<string, (signal?: AbortSignal | null) => Promise<Response>>

const ok = (): IdentityVerification => ({
  ok: true,
  context: { identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: Date.now() - 3_600_000 },
})
const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const both = (answer: () => Promise<Response>) => {
  answers["/v1/parent/candy-balance"] = answer
  answers["/v1/parent/welcome-credits"] = answer
}

beforeEach(() => {
  records = []
  restore = setLogSink((r) => records.push(r))
  vi.stubEnv("BACKEND_INTERNAL_URL", BASE)
  vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "300")
  vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", SECRET_HEX)
  m.verification = ok()
  m.verifyCalls = 0
  m.signOut.mockClear()
  fetchCalls = []
  answers = {
    "/v1/parent/candy-balance": json(200, { balance: 42 }),
    "/v1/parent/welcome-credits": json(200, { welcomeImageCreditsRemaining: 2 }),
  }
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    fetchCalls.push({ url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()) })
    return (answers[new URL(String(input)).pathname] ?? json(404, {}))(init.signal)
  })
})
afterEach(() => {
  restore()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const call = async (route: "welcome-credits" | "account-summary", headers: Record<string, string> = {}, qs = "") => {
  const mod = route === "welcome-credits"
    ? await import("@/app/api/parent/welcome-credits/route")
    : await import("@/app/api/parent/account-summary/route")
  const res = await mod.GET(new Request(`http://localhost:3000/api/parent/${route}${qs}`, { headers }))
  return { status: res.status, body: await res.json(), headers: res.headers }
}

describe("GET /api/parent/welcome-credits -> Fastify GET /v1/parent/welcome-credits", () => {
  it("keeps { welcomeImageCreditsRemaining }, no-store, with the request id forwarded and echoed", async () => {
    const res = await call("welcome-credits")
    expect([res.status, res.body]).toEqual([200, { welcomeImageCreditsRemaining: 2 }])
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(fetchCalls[0].headers["x-request-id"])
  })

  it("ONE verification, ONE backend call, signed for exactly GET /v1/parent/welcome-credits, no browser identity forwarded", async () => {
    await call("welcome-credits", {
      "x-user-id": "99999999-9999-4999-8999-999999999999",
      "x-role": "parent",
      "x-parent-profile-id": "22222222-3333-4444-8555-666666666666",
      "x-cartoona-internal-auth": "v2.forged.sig",
      cookie: "sb-x-auth-token=abc",
    }, "?parentProfileId=22222222-3333-4444-8555-666666666666")
    expect(m.verifyCalls).toBe(1)
    expect(fetchCalls.map((c) => c.url)).toEqual([`${BASE}/v1/parent/welcome-credits`])
    const verified = verifyAssertion({ token: fetchCalls[0].headers["x-cartoona-internal-auth"], secret: Buffer.from(SECRET_HEX, "hex"), method: "GET", path: "/v1/parent/welcome-credits" })
    expect(verified.ok && verified.claims.subject).toBe(SUBJECT)
    expect(Object.keys(fetchCalls[0].headers).sort()).toEqual(["accept", "x-cartoona-internal-auth", "x-request-id"])
  })

  it("zero credits and a parent with no profile both read 0 (unchanged)", async () => {
    answers["/v1/parent/welcome-credits"] = json(200, { welcomeImageCreditsRemaining: 0 })
    expect((await call("welcome-credits")).body).toEqual({ welcomeImageCreditsRemaining: 0 })
    answers["/v1/parent/welcome-credits"] = json(404, { error: "parent_profile_not_found" })
    expect(await call("welcome-credits").then((r) => [r.status, r.body])).toEqual([200, { welcomeImageCreditsRemaining: 0 }])
  })

  it.each([
    ["no session", { ok: false, reason: "no_session" }, 401, "unauthenticated"],
    ["rejected session", { ok: false, reason: "invalid_session" }, 401, "unauthenticated"],
    ["provider outage", { ok: false, reason: "auth_unavailable" }, 503, "SESSION_CHECK_UNAVAILABLE"],
    ["30-day expiry (provider evidence)", { ok: false, reason: "session_expired" }, 401, "PARENT_SESSION_EXPIRED"],
  ] as const)("%s -> %i %s, no backend call", async (_label, verification, status, code) => {
    m.verification = verification
    const res = await call("welcome-credits")
    expect([res.status, res.body.code]).toEqual([status, code])
    expect(typeof res.body.error).toBe("string")
    expect(fetchCalls).toEqual([])
    expect(m.signOut).toHaveBeenCalledTimes(code === "PARENT_SESSION_EXPIRED" ? 1 : 0)
  })

  it.each([
    ["session_invalidated", 401, { error: "session_invalidated" }, 401, "PARENT_SESSION_EXPIRED", 1],
    ["session_expired", 401, { error: "session_expired" }, 401, "PARENT_SESSION_EXPIRED", 1],
    ["identity_not_linked", 403, { error: "identity_not_linked" }, 403, "identity_not_linked", 0],
    ["forbidden (admin/deleted)", 403, { error: "forbidden" }, 403, "forbidden", 0],
    ["our assertion rejected", 401, { error: "unauthenticated" }, 503, "service_unavailable", 0],
    ["database down", 503, { error: "service_unavailable" }, 503, "service_unavailable", 0],
    ["malformed 200", 200, { welcomeImageCreditsRemaining: -1 }, 503, "service_unavailable", 0],
    ["widened 200", 200, { welcomeImageCreditsRemaining: "2" }, 503, "service_unavailable", 0],
    ["unknown error body", 403, { error: "admin" }, 503, "service_unavailable", 0],
  ] as const)("backend %s -> %i %s", async (_label, backendStatus, backendBody, status, code, signOuts) => {
    answers["/v1/parent/welcome-credits"] = json(backendStatus, backendBody)
    const res = await call("welcome-credits")
    expect([res.status, res.body.code]).toEqual([status, code])
    expect(m.signOut).toHaveBeenCalledTimes(signOuts)
    expect(JSON.stringify(res.body)).not.toMatch(/backend\.internal|4000|v2\./)
  })

  it("backend refused or hanging -> bounded 503, the session is kept", async () => {
    answers["/v1/parent/welcome-credits"] = async () => { throw new TypeError("fetch failed") }
    expect(await call("welcome-credits").then((r) => [r.status, r.body.code])).toEqual([503, "service_unavailable"])
    // Hangs until the client's own deadline aborts it.
    answers["/v1/parent/welcome-credits"] = (signal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
    const t = Date.now()
    expect(await call("welcome-credits").then((r) => [r.status, r.body.code])).toEqual([503, "service_unavailable"])
    expect(Date.now() - t).toBeLessThan(2_000)
    expect(m.signOut).not.toHaveBeenCalled()
  })

  it("logs nothing sensitive", async () => {
    await call("welcome-credits")
    expect(records.find((r) => r.event === "REQUEST_COMPLETED")).toMatchObject({ route: "GET /api/parent/welcome-credits", status: 200 })
    expect(JSON.stringify(records)).not.toMatch(new RegExp(`${SUBJECT}|v2\\.|${SECRET_HEX}`))
  })
})

describe("GET /api/parent/account-summary -> balance + credits, one verification, two parallel reads", () => {
  it("returns the billing fields with their pre-cutover names: { wallet: { balance }, welcomeImageCreditsRemaining }", async () => {
    const res = await call("account-summary")
    expect([res.status, res.body]).toEqual([200, { wallet: { balance: 42 }, welcomeImageCreditsRemaining: 2 }])
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("verifies the session ONCE and signs one assertion per backend path, sharing the request id", async () => {
    await call("account-summary")
    expect(m.verifyCalls).toBe(1)
    expect(fetchCalls.map((c) => new URL(c.url).pathname).sort()).toEqual(["/v1/parent/candy-balance", "/v1/parent/welcome-credits"])
    for (const c of fetchCalls) {
      const path = new URL(c.url).pathname
      expect(verifyAssertion({ token: c.headers["x-cartoona-internal-auth"], secret: Buffer.from(SECRET_HEX, "hex"), method: "GET", path }).ok, path).toBe(true)
      expect(new URL(c.url).search).toBe("")
    }
    expect(new Set(fetchCalls.map((c) => c.headers["x-request-id"])).size).toBe(1)
  })

  it("the two reads run in parallel, not one after the other", async () => {
    const started: number[] = []
    both(async () => {
      started.push(Date.now())
      await new Promise((r) => setTimeout(r, 100))
      return new Response(JSON.stringify({ balance: 1, welcomeImageCreditsRemaining: 1 }), { status: 200 })
    })
    const t = Date.now()
    const res = await call("account-summary")
    expect(res.status).toBe(200)
    expect(Math.abs(started[0] - started[1])).toBeLessThan(50)
    expect(Date.now() - t).toBeLessThan(190)
  })

  it("zero balance and zero credits: balance 0, credits 0 (the note hides itself at 0)", async () => {
    answers["/v1/parent/candy-balance"] = json(200, { balance: 0 })
    answers["/v1/parent/welcome-credits"] = json(200, { welcomeImageCreditsRemaining: 0 })
    expect((await call("account-summary")).body).toEqual({ wallet: { balance: 0 }, welcomeImageCreditsRemaining: 0 })
  })

  it("a failed credits read omits the field and billing still works (unchanged)", async () => {
    answers["/v1/parent/welcome-credits"] = json(503, { error: "service_unavailable" })
    expect(await call("account-summary").then((r) => [r.status, r.body])).toEqual([200, { wallet: { balance: 42 } }])
  })

  it("a failed balance read -> 503 (pre-cutover it was silently shown as 0)", async () => {
    answers["/v1/parent/candy-balance"] = json(503, { error: "service_unavailable" })
    expect(await call("account-summary").then((r) => [r.status, r.body.code])).toEqual([503, "service_unavailable"])
  })

  it("no parent profile -> 400 with the billing page's existing message", async () => {
    both(json(404, { error: "parent_profile_not_found" }))
    const res = await call("account-summary")
    expect([res.status, res.body]).toEqual([400, { error: "پروفایل والد یافت نشد.", code: "no_parent_profile" }])
  })

  it.each([
    ["no session", { ok: false, reason: "no_session" }, 401, "unauthenticated"],
    ["provider outage", { ok: false, reason: "auth_unavailable" }, 503, "SESSION_CHECK_UNAVAILABLE"],
    ["30-day expiry", { ok: false, reason: "session_expired" }, 401, "PARENT_SESSION_EXPIRED"],
  ] as const)("%s -> %i %s, no backend call", async (_label, verification, status, code) => {
    m.verification = verification
    const res = await call("account-summary")
    expect([res.status, res.body.code]).toEqual([status, code])
    expect(fetchCalls).toEqual([])
  })

  it.each([
    ["session_invalidated", 401, "session_invalidated", 401, "PARENT_SESSION_EXPIRED"],
    ["admin / super_admin / deleted", 403, "forbidden", 403, "forbidden"],
    ["unlinked", 403, "identity_not_linked", 403, "identity_not_linked"],
  ] as const)("backend %s -> %i %s", async (_label, backendStatus, error, status, code) => {
    both(json(backendStatus, { error }))
    const res = await call("account-summary")
    expect([res.status, res.body.code]).toEqual([status, code])
    expect(m.signOut).toHaveBeenCalledTimes(code === "PARENT_SESSION_EXPIRED" ? 1 : 0)
  })

  it("backend down -> 503 service_unavailable, no sign-out", async () => {
    both(async () => { throw new TypeError("fetch failed") })
    expect(await call("account-summary").then((r) => [r.status, r.body.code])).toEqual([503, "service_unavailable"])
    expect(m.signOut).not.toHaveBeenCalled()
  })
})
