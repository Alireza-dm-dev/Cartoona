import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id"
import { verifyAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { encodeOrdersCursor } from "@/lib/parent/orders/pagination"
import type { IdentityVerification } from "@/lib/auth/supabase-identity-adapter"

/**
 * GET /api/parent/orders as a BFF (V0.1.45), in-process: the identity adapter
 * is mocked, the REAL backend client signs real assertions, and `fetch` stands
 * in for Fastify. Proves the request it sends, the response contract it keeps,
 * and the mapping of every auth/backend outcome. The real chain (stub provider
 * -> Next -> Fastify -> PostgreSQL) is parent-orders-cutover-db.test.ts.
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

const SECRET_HEX = "66".repeat(32)
const BASE = "http://backend.internal.test:4000"
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const ORDER = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  requestType: "image",
  createdAt: "2026-09-01T10:00:00.000001+00:00",
  displayTitle: `Order ${n}`,
  status: "submitted",
  candyCost: 12,
  completedAt: null,
  ...extra,
})
const CURSOR = encodeOrdersCursor({ createdAt: "2026-09-01T10:00:00.000001+00:00", id: ORDER(2).id })

let records: LogRecord[]
let restore: () => void
let fetchCalls: { url: string; headers: Record<string, string> }[]
let answer: (signal?: AbortSignal | null) => Promise<Response>

const ok = (): IdentityVerification => ({
  ok: true,
  context: { identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: Date.now() - 3_600_000 },
})
const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

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
  answer = json(200, { orders: [ORDER(1), ORDER(2)], nextCursor: CURSOR })
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    fetchCalls.push({ url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()) })
    return answer(init.signal)
  })
})
afterEach(() => {
  restore()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const GET = async (qs = "", headers: Record<string, string> = {}) =>
  (await import("@/app/api/parent/orders/route")).GET(new Request(`http://localhost:3000/api/parent/orders${qs}`, { headers }))

describe("GET /api/parent/orders -> Fastify GET /v1/parent/orders", () => {
  it("keeps the { orders, nextCursor } contract, no-store, with the request id", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(await res.json()).toEqual({ orders: [ORDER(1), ORDER(2)], nextCursor: CURSOR })
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(fetchCalls[0].headers["x-request-id"])
  })

  it("makes ONE provider verification and ONE backend call, signed for exactly GET /v1/parent/orders", async () => {
    await GET(`?cursor=${encodeURIComponent(CURSOR)}&limit=5`)
    expect(m.verifyCalls).toBe(1)
    expect(fetchCalls).toHaveLength(1)
    const url = new URL(fetchCalls[0].url)
    expect(url.origin + url.pathname).toBe(`${BASE}/v1/parent/orders`)
    expect([...url.searchParams.keys()].sort()).toEqual(["cursor", "limit"])
    expect(url.searchParams.get("cursor")).toBe(CURSOR)
    const verified = verifyAssertion({ token: fetchCalls[0].headers["x-cartoona-internal-auth"], secret: Buffer.from(SECRET_HEX, "hex"), method: "GET", path: "/v1/parent/orders" })
    expect(verified.ok && verified.claims.subject).toBe(SUBJECT)
    expect(Object.keys(fetchCalls[0].headers).sort()).toEqual(["accept", "x-cartoona-internal-auth", "x-request-id"])
  })

  it("browser-supplied identity is never forwarded: X-User-Id, X-Role, cookies, parentProfileId", async () => {
    await GET("?parentProfileId=22222222-3333-4444-8555-666666666666&userId=x", {
      "x-user-id": "99999999-9999-4999-8999-999999999999",
      "x-role": "parent",
      "x-cartoona-internal-auth": "v2.forged.sig",
      cookie: "sb-x-auth-token=abc",
    })
    expect(fetchCalls[0].url).toBe(`${BASE}/v1/parent/orders`)
    expect(fetchCalls[0].headers["x-cartoona-internal-auth"]).not.toBe("v2.forged.sig")
    expect(JSON.stringify(fetchCalls[0].headers)).not.toMatch(/99999999|sb-x-auth-token|forged/)
  })

  it("bad cursor or limit -> 400 before any auth or backend work", async () => {
    for (const qs of ["?cursor=garbage", "?limit=0", "?limit=51", "?limit=abc", "?limit=5&limit=6"]) {
      const res = await GET(qs)
      expect(res.status, qs).toBe(400)
      expect((await res.json()).code).toBe("invalid_request")
    }
    expect(m.verifyCalls).toBe(0)
    expect(fetchCalls).toHaveLength(0)
  })

  it("provider outcomes: signed out / rejected -> 401; expired -> 401 + local sign-out; outage -> 503, no sign-out", async () => {
    const cases: [IdentityVerification, number, string, boolean][] = [
      [{ ok: false, reason: "no_session" }, 401, "unauthenticated", false],
      [{ ok: false, reason: "invalid_session" }, 401, "unauthenticated", false],
      [{ ok: false, reason: "session_expired" }, 401, "session_expired", true],
      [{ ok: false, reason: "auth_unavailable" }, 503, "auth_unavailable", false],
    ]
    for (const [verification, status, code, signedOut] of cases) {
      m.verification = verification
      m.signOut.mockClear()
      const res = await GET()
      expect([res.status, (await res.json()).code], code).toEqual([status, code])
      expect(m.signOut).toHaveBeenCalledTimes(signedOut ? 1 : 0)
      if (signedOut) expect(m.signOut).toHaveBeenCalledWith({ scope: "local" })
    }
    expect(fetchCalls).toHaveLength(0)
  })

  it("backend outcomes map to safe public answers", async () => {
    const cases: [() => Promise<Response>, number, string | null, boolean][] = [
      [json(401, { error: "session_invalidated" }), 401, "session_invalidated", true],
      [json(401, { error: "session_expired" }), 401, "session_expired", true],
      // our own assertion rejected = our misconfiguration, not the visitor's session
      [json(401, { error: "unauthenticated" }), 503, "service_unavailable", false],
      [json(403, { error: "identity_not_linked" }), 403, "identity_not_linked", false],
      [json(403, { error: "forbidden" }), 403, "forbidden", false],
      [json(400, { error: "invalid_request" }), 400, "invalid_request", false],
      [json(503, { error: "service_unavailable" }), 503, "service_unavailable", false],
      [json(500, { message: "Internal Server Error" }), 503, "service_unavailable", false],
      [json(200, { orders: "nope", nextCursor: null }), 503, "service_unavailable", false],
      [json(200, { orders: [ORDER(1, { status: "pending_review" })], nextCursor: null }), 503, "service_unavailable", false],
      [async () => new Response("<html>proxy error</html>", { status: 200 }), 503, "service_unavailable", false],
      [async () => { throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.9:4000") }, 503, "service_unavailable", false],
    ]
    for (const [reply, status, code, signedOut] of cases) {
      answer = reply
      m.signOut.mockClear()
      const res = await GET()
      const body = await res.json()
      expect([res.status, body.code], String(code)).toEqual([status, code])
      expect(res.headers.get("Cache-Control")).toBe("no-store")
      expect(m.signOut).toHaveBeenCalledTimes(signedOut ? 1 : 0)
      expect(JSON.stringify(body)).not.toMatch(/backend\.internal|4000|ECONNREFUSED|proxy error|Internal Server Error|v2\.|6f1c2e7a/)
    }
  })

  it("a parent without a profile keeps the old answer: an empty page", async () => {
    answer = json(404, { error: "parent_profile_not_found" })
    const res = await GET()
    expect([res.status, await res.json()]).toEqual([200, { orders: [], nextCursor: null }])
  })

  it("a hanging backend is cut at the bounded timeout with one attempt -> 503", async () => {
    // Like real fetch, the hanging request rejects when the client aborts it.
    answer = (signal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
    const started = Date.now()
    const res = await GET()
    expect(res.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(fetchCalls).toHaveLength(1)
    expect(records.find((r) => r.event === "BACKEND_TIMEOUT")).toBeTruthy()
  })

  it("logs: one REQUEST_COMPLETED; never the assertion, subject, titles, cursor or backend URL", async () => {
    await GET(`?cursor=${encodeURIComponent(CURSOR)}`)
    const done = records.filter((r) => r.event === "REQUEST_COMPLETED")
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ route: "GET /api/parent/orders", status: 200 })
    const out = JSON.stringify(records)
    expect(out).not.toMatch(new RegExp(`${SUBJECT}|Order 1|backend\\.internal|v2\\.`))
    expect(out).not.toContain(CURSOR)
    expect(out).not.toContain(fetchCalls[0].headers["x-cartoona-internal-auth"])
  })
})
