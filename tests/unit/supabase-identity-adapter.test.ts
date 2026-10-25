import { describe, it, expect, vi, afterEach } from "vitest"
import http from "node:http"
import net from "node:net"

vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }))

import { createServerClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"
import { AUTH_VERIFY_DEADLINE_MS, verifySupabaseIdentity } from "@/lib/auth/supabase-identity-adapter"
import { getPublicHeaderAccount, PUBLIC_HEADER_AUTH_DEADLINE_MS } from "@/lib/auth/public-header-account"
import { supabaseTimeoutFetch } from "@/lib/supabase/timeout-fetch"
import { cookieJar, sessionCookie, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { accessToken, DAY_MS } from "../helpers/supabase-jwt"

/**
 * The Supabase Auth adapter and the public header lookup against the REAL
 * @supabase/ssr / auth-js code and a local stub provider (nothing reaches
 * Supabase). Proves: verification semantics, one bounded deadline even while
 * auth-js retries a refresh, and that an outage never signs the user out.
 */

const USER_ID = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
let stub: StubAuth | null = null

afterEach(async () => {
  await stub?.close()
  stub = null
})

type Jar = ReturnType<typeof cookieJar>

/** The production client shape (createServerClient) over `url` and a test jar. */
function clientFactory(url: string, jar: Jar) {
  return async (fetchImpl: typeof fetch) =>
    createServerClient(url, "anon-key", {
      global: { fetch: fetchImpl },
      cookies: { getAll: jar.getAll, setAll: jar.setAll },
    }) as unknown as SupabaseClient
}

async function closedPortUrl(): Promise<string> {
  const server = net.createServer()
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((r) => server.close(() => r()))
  return `http://127.0.0.1:${port}`
}

async function timed<T>(work: Promise<T>): Promise<{ result: T; ms: number }> {
  const t = performance.now()
  const result = await work
  return { result, ms: performance.now() - t }
}

const refreshCalls = (s: StubAuth) => s.requests.filter((r) => r.path === "/auth/v1/token").length

describe("deadline constants", () => {
  it("verification is bounded at 4 s and the public header at 2.5 s (target range 2-5 s)", () => {
    expect(AUTH_VERIFY_DEADLINE_MS).toBe(4000)
    expect(PUBLIC_HEADER_AUTH_DEADLINE_MS).toBe(2500)
  })
})

describe("verifySupabaseIdentity: outcomes", () => {
  it("a valid session -> the verified external identity, and nothing else", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const jar = cookieJar([stub.cookie()])
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, jar) })
    expect(result).toEqual({ ok: true, context: { identity: { provider: "supabase", subject: USER_ID }, authenticatedAt: expect.any(Number) } })
    // ONE provider round trip, verifying the session's own access token.
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]).toMatchObject({ method: "GET", path: "/auth/v1/user" })
    expect(stub.requests[0].authorization).toMatch(/^Bearer ey/)
    // No email / phone / tokens / claims leave the adapter.
    expect(JSON.stringify(result)).not.toMatch(/example\.com|989|eyJ|refresh-|amr|session_id/)
  })

  it("no session cookie -> no_session, with no network call", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, cookieJar()) })
    expect(result).toEqual({ ok: false, reason: "no_session" })
    expect(stub.requests).toHaveLength(0)
  })

  it("a session the provider rejects -> invalid_session", async () => {
    stub = await startStubAuth({ userId: USER_ID, userMode: "unauthorized" })
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, cookieJar([stub.cookie()])) })
    expect(result).toEqual({ ok: false, reason: "invalid_session" })
  })

  it("provider answering 5xx -> auth_unavailable (not a sign-out)", async () => {
    stub = await startStubAuth({ userId: USER_ID, userMode: "server_error" })
    const jar = cookieJar([stub.cookie()])
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, jar) })
    expect(result).toEqual({ ok: false, reason: "auth_unavailable" })
    expect(jar.cleared("sb-")).toBe(false)
  })

  it("expired access token + working refresh -> verified, and the rotated session is written back", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const jar = cookieJar([stub.cookie({ expired: true })])
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, jar) })
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    expect(refreshCalls(stub)).toBe(1)
    expect(jar.writes.some((w) => w.value.startsWith("base64-"))).toBe(true)
  })

  it("expired + refresh token rejected by the provider -> invalid_session (a genuine sign-out, unchanged)", async () => {
    stub = await startStubAuth({ userId: USER_ID, refreshMode: "invalid_grant" })
    const jar = cookieJar([stub.cookie({ expired: true })])
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, jar) })
    expect(result.ok).toBe(false)
    expect(["invalid_session", "no_session"]).toContain((result as { reason: string }).reason)
  })
})

describe("session evidence (V0.1.43): the sign-in time, verified, and refresh-proof", () => {
  it("11. extracts the original sign-in time (amr), at second precision", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const signedIn = Date.now() - 3 * DAY_MS - 1234
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, cookieJar([stub.cookie({ authenticatedAt: signedIn })])) })
    expect(result.ok && result.context.authenticatedAt).toBe(Math.floor(signedIn / 1000) * 1000)
  })

  it("12. a refreshed access token carries the SAME sign-in time (not its new iat)", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const signedIn = Date.now() - 10 * DAY_MS
    const jar = cookieJar([stub.cookie({ expired: true, authenticatedAt: signedIn })])
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, jar) })
    expect(stub.refreshedTokens).toHaveLength(1) // a refresh really happened
    const refreshedIat = JSON.parse(Buffer.from(stub.refreshedTokens[0].split(".")[1], "base64url").toString()).iat
    expect(refreshedIat * 1000).toBeGreaterThan(signedIn + 9 * DAY_MS) // new token, new iat ...
    expect(result.ok && result.context.authenticatedAt).toBe(Math.floor(signedIn / 1000) * 1000) // ... same sign-in time
  })

  it("13. refreshing never extends the 30-day limit", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const signedIn = Date.now() - 30 * DAY_MS + 60_000 // 1 minute left
    const jar = cookieJar([stub.cookie({ expired: true, authenticatedAt: signedIn })])
    const now = vi.fn(() => Date.now())
    const before = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, jar), now })
    expect(before.ok).toBe(true)
    expect(stub.refreshedTokens).toHaveLength(1)
    // Two minutes later the refreshed (fresh-iat) token is still on the cookie - and the session is over.
    now.mockReturnValue(Date.now() + 120_000)
    const after = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, jar), now })
    expect(after).toEqual({ ok: false, reason: "session_expired" })
  })

  it("a session signed in 31 days ago -> session_expired (no assertion can follow)", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, cookieJar([stub.cookie({ authenticatedAt: Date.now() - 31 * DAY_MS })])) })
    expect(result).toEqual({ ok: false, reason: "session_expired" })
  })

  it.each([
    ["a token the provider did not issue (forged claims)", () => sessionCookie(stub!.url)],
    ["string-only amr (no timestamps)", () => stub!.cookie({ amr: ["otp"] })],
    ["no amr at all", () => stub!.cookie({ amr: [] })],
    ["only a token_refresh amr entry", () => stub!.cookie({ amr: [{ method: "token_refresh", timestamp: Math.floor(Date.now() / 1000) }] })],
  ])("14. %s -> invalid_session, never a verified context", async (_label, cookie) => {
    stub = await startStubAuth({ userId: USER_ID })
    const result = await verifySupabaseIdentity({ createClient: clientFactory(stub.url, cookieJar([cookie()])) })
    expect(result).toEqual({ ok: false, reason: "invalid_session" })
  })

  it("claims are read only from the token the provider just accepted", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    // A browser-edited token: same session, sign-in time moved forward. The provider rejects it.
    const forged = accessToken({ sub: USER_ID, authenticatedAt: Date.now() })
    const cookie = stub.cookie()
    const session = JSON.parse(Buffer.from(cookie.value.slice("base64-".length), "base64url").toString())
    session.access_token = forged
    const tampered = { name: cookie.name, value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` }
    expect(await verifySupabaseIdentity({ createClient: clientFactory(stub.url, cookieJar([tampered])) })).toEqual({ ok: false, reason: "invalid_session" })
  })
})

describe("verifySupabaseIdentity: one bounded deadline, never a sign-out on outage", () => {
  const DEADLINE = 800

  it("provider hangs on /user -> auth_unavailable at the deadline", async () => {
    stub = await startStubAuth({ userId: USER_ID, userMode: "hang" })
    const jar = cookieJar([stub.cookie()])
    const { result, ms } = await timed(verifySupabaseIdentity({ deadlineMs: DEADLINE, createClient: clientFactory(stub.url, jar) }))
    expect(result).toEqual({ ok: false, reason: "auth_unavailable" })
    expect(ms).toBeGreaterThanOrEqual(DEADLINE - 50)
    expect(ms).toBeLessThan(DEADLINE + 600)
    expect(jar.cleared("sb-")).toBe(false)
  })

  it.each([
    ["hangs", "hang" as const],
    ["fails immediately (503)", "server_error" as const],
  ])("expired session, refresh %s -> auth_unavailable at the deadline; session kept", async (_label, refreshMode) => {
    stub = await startStubAuth({ userId: USER_ID, refreshMode })
    const jar = cookieJar([stub.cookie({ expired: true })])
    const { result, ms } = await timed(verifySupabaseIdentity({ deadlineMs: DEADLINE, createClient: clientFactory(stub.url, jar) }))
    expect(result).toEqual({ ok: false, reason: "auth_unavailable" })
    expect(ms).toBeLessThan(DEADLINE + 600)
    expect(jar.cleared("sb-")).toBe(false)

    // auth-js's own retry loop continues in the background, but sends nothing more.
    const attempts = refreshCalls(stub)
    await new Promise((r) => setTimeout(r, 1500))
    expect(refreshCalls(stub)).toBe(attempts)
    expect(jar.cleared("sb-")).toBe(false)
  })

  it("expired session, provider unreachable (connection refused) -> auth_unavailable, bounded, session kept", async () => {
    const url = await closedPortUrl()
    const jar = cookieJar([sessionCookie(url, { expired: true })])
    const { result, ms } = await timed(verifySupabaseIdentity({ deadlineMs: DEADLINE, createClient: clientFactory(url, jar) }))
    expect(result).toEqual({ ok: false, reason: "auth_unavailable" })
    expect(ms).toBeLessThan(DEADLINE + 600)
    expect(jar.cleared("sb-")).toBe(false)
  })
})

describe("public header lookup: bounded, degrades to anonymous", () => {
  it("valid parent session -> the name summary, read from the backend (V0.1.46)", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    // Stands in for Fastify GET /v1/parent/profile; the full chain is parent-account-cutover-db.test.ts.
    const paths: string[] = []
    const backend = http.createServer((req, res) => {
      paths.push(String(req.url))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ fullName: "Sara Ahmadi" }))
    })
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()))
    vi.stubEnv("BACKEND_INTERNAL_URL", `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", "55".repeat(32))
    try {
      const account = await getPublicHeaderAccount({ createClient: clientFactory(stub.url, cookieJar([stub.cookie()])) })
      expect(account).toEqual({ displayName: "Sara Ahmadi", initials: "SA" })
      expect(paths).toEqual(["/v1/parent/profile"])
    } finally {
      vi.unstubAllEnvs()
      await new Promise((r) => backend.close(r))
    }
  })

  it.each([
    ["refresh hangs", "hang" as const],
    ["refresh fails fast", "server_error" as const],
  ])("expired session, %s -> anonymous header within the 2.5 s default (was ~26 s)", async (_label, refreshMode) => {
    stub = await startStubAuth({ userId: USER_ID, refreshMode })
    const jar = cookieJar([stub.cookie({ expired: true })])
    const { result, ms } = await timed(getPublicHeaderAccount({ createClient: clientFactory(stub.url, jar) }))
    expect(result).toBeNull()
    expect(ms).toBeGreaterThanOrEqual(PUBLIC_HEADER_AUTH_DEADLINE_MS - 100)
    expect(ms).toBeLessThan(PUBLIC_HEADER_AUTH_DEADLINE_MS + 700)
    expect(jar.cleared("sb-")).toBe(false)
  })

  it("anonymous visitor -> anonymous header immediately, no provider call", async () => {
    stub = await startStubAuth({ userId: USER_ID })
    const { result, ms } = await timed(getPublicHeaderAccount({ createClient: clientFactory(stub.url, cookieJar()) }))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(300)
    expect(stub.requests).toHaveLength(0)
  })
})

/**
 * Baseline measurement of the pre-V0.1.42 header path (no deadline), opt-in
 * because it takes ~26 s per case: CARTOONA_MEASURE_AUTH_STALL=1.
 */
describe.skipIf(process.env.CARTOONA_MEASURE_AUTH_STALL !== "1")("baseline: the old unbounded header lookup", () => {
  it.each([
    ["refresh fails fast", "server_error" as const],
    ["refresh hangs", "hang" as const],
  ])("expired session, %s", async (label, refreshMode) => {
    stub = await startStubAuth({ userId: USER_ID, refreshMode })
    const jar = cookieJar([stub.cookie({ expired: true })])
    const supabase = await clientFactory(stub.url, jar)(supabaseTimeoutFetch)
    // The pre-V0.1.42 lookup started with an unbounded getUser(); that is where it stalled.
    const { result, ms } = await timed(supabase.auth.getUser().then(({ data }) => data.user?.id ?? null, () => null))
    process.stderr.write(`[auth stall baseline] ${label}: ${(ms / 1000).toFixed(1)} s, ${refreshCalls(stub)} refresh attempts, result=${JSON.stringify(result)}\n`)
    expect(result).toBeNull()
  }, 90_000)
})
