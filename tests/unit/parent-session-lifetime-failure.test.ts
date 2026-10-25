import { describe, test, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { AuthRetryableFetchError, AuthApiError } from "@supabase/supabase-js"
import { checkParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import {
  createParentSessionFailureResponse,
  SESSION_CHECK_UNAVAILABLE_BODY,
} from "@/lib/auth/expired-parent-session-response"
import { accessToken, DAY_MS, getSessionResult, type SessionKind } from "../helpers/supabase-jwt"

// ─────────────────────────────────────────────────────────────────────────────
// A failed session-lifetime lookup (transient network / Supabase error) must
// fail closed WITHOUT revoking the session. Only a definite expiry or missing
// session may call signOut. These tests pin lookup_failed != expired.
//
// V0.1.43: the lifetime comes from the verified session's sign-in time (amr),
// read locally through getSession() - no RPC, no auth.sessions.
// ─────────────────────────────────────────────────────────────────────────────

const USER = "u1"

/** auth.getSession() answering each call from the queue (last entry repeats). */
function sessionReader(kinds: SessionKind[], user = USER) {
  const queue = [...kinds]
  return {
    getSession: vi.fn(async () => getSessionResult(queue.length > 1 ? queue.shift()! : queue[0], user)),
  }
}

describe("checkParentSessionLifetime outcomes", () => {
  test("valid: started at the verified sign-in time, expires 30 days later", async () => {
    const now = Date.UTC(2026, 9, 17, 12)
    const authenticatedAt = now - 2 * DAY_MS
    const getSession = vi.fn(async () => ({ data: { session: { access_token: accessToken({ sub: USER, authenticatedAt }) } }, error: null }))
    const r = await checkParentSessionLifetime({ auth: { getSession } }, USER, now)
    expect(r).toEqual({
      valid: true,
      sessionStartedAt: new Date(Math.floor(authenticatedAt / 1000) * 1000).toISOString(),
      expiresAt: new Date(Math.floor(authenticatedAt / 1000) * 1000 + 30 * DAY_MS).toISOString(),
    })
  })
  test("expired (signed in 31 days ago)", async () => {
    expect(await checkParentSessionLifetime({ auth: sessionReader(["expired"]) }, USER)).toEqual({ valid: false, reason: "expired" })
  })
  test("missing_session (no session)", async () => {
    expect(await checkParentSessionLifetime({ auth: sessionReader(["missing"]) }, USER)).toEqual({ valid: false, reason: "missing_session" })
  })
  test("session read/refresh failure is lookup_failed, never expired", async () => {
    expect(await checkParentSessionLifetime({ auth: sessionReader(["transient"]) }, USER)).toEqual({ valid: false, reason: "lookup_failed" })
  })
  test("a thrown session read is lookup_failed", async () => {
    const getSession = vi.fn(async () => { throw new TypeError("fetch failed") })
    expect(await checkParentSessionLifetime({ auth: { getSession } }, USER)).toEqual({ valid: false, reason: "lookup_failed" })
  })
  test("a token for ANOTHER user than the verified one is missing_session (fail closed)", async () => {
    expect(await checkParentSessionLifetime({ auth: sessionReader(["valid"], "someone-else") }, USER)).toEqual({ valid: false, reason: "missing_session" })
  })
  test.each([
    ["no amr", []],
    ["string-only amr (no timestamps)", ["otp"]],
    ["amr with only a token_refresh entry", [{ method: "token_refresh", timestamp: 1_700_000_000 }]],
  ])("%s -> missing_session (no usable sign-in evidence: sign in again)", async (_label, amr) => {
    const getSession = vi.fn(async () => ({ data: { session: { access_token: accessToken({ sub: USER, authenticatedAt: Date.now(), amr }) } }, error: null }))
    expect(await checkParentSessionLifetime({ auth: { getSession } }, USER)).toEqual({ valid: false, reason: "missing_session" })
  })
  test("makes no network call of its own (one local session read)", async () => {
    const reader = sessionReader(["valid"])
    await checkParentSessionLifetime({ auth: reader }, USER)
    expect(reader.getSession).toHaveBeenCalledTimes(1)
  })
})

describe("createParentSessionFailureResponse", () => {
  const mk = () => ({ auth: { signOut: vi.fn(async () => ({})) } })

  test("lookup_failed -> retryable 503, signOut NOT called, not session_expired", async () => {
    const sb = mk()
    const res = await createParentSessionFailureResponse(sb, { valid: false, reason: "lookup_failed" })
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBeTruthy()
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = await res.json()
    expect(body.code).toBe("SESSION_CHECK_UNAVAILABLE")
    expect(body.code).not.toBe("PARENT_SESSION_EXPIRED")
    expect(body).toEqual(SESSION_CHECK_UNAVAILABLE_BODY)
    expect(sb.auth.signOut).not.toHaveBeenCalled()
  })

  test("expired -> existing 401 PARENT_SESSION_EXPIRED + local signOut", async () => {
    const sb = mk()
    const res = await createParentSessionFailureResponse(sb, { valid: false, reason: "expired" })
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("PARENT_SESSION_EXPIRED")
    expect(sb.auth.signOut).toHaveBeenCalledWith({ scope: "local" })
  })

  test("missing_session -> existing 401 + local signOut", async () => {
    const sb = mk()
    const res = await createParentSessionFailureResponse(sb, { valid: false, reason: "missing_session" })
    expect(res.status).toBe(401)
    expect(sb.auth.signOut).toHaveBeenCalledTimes(1)
  })

  test("response never leaks internal error text", async () => {
    const res = await createParentSessionFailureResponse(mk(), { valid: false, reason: "lookup_failed" })
    expect(JSON.stringify(await res.json())).not.toMatch(/fetch failed|supabase|rpc/i)
  })
})

// ── Real API route: GET /api/parent/gallery (V0.1.52: verified through verifyParentCaller) ──
const galleryMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  end: vi.fn(),
  getParentGalleryMedia: vi.fn(),
}))
vi.mock("@/lib/parent/backend-caller", () => ({ verifyParentCaller: galleryMocks.verify }))
vi.mock("@/lib/auth/end-parent-session", () => ({ endParentSession: galleryMocks.end }))
vi.mock("@/lib/parent/gallery/queries", () => ({
  getParentGalleryMedia: galleryMocks.getParentGalleryMedia,
}))
const GALLERY_CONTEXT = { identity: { provider: "supabase", subject: "u1" }, authenticatedAt: 1 }

describe("API route: an identity-provider outage fails closed, keeps session, retry works", () => {
  beforeEach(() => {
    galleryMocks.getParentGalleryMedia.mockReset()
    galleryMocks.verify.mockReset()
    galleryMocks.end.mockReset()
  })

  test("auth_unavailable: 503, no sign-out, no protected data; retry on SAME session succeeds", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    galleryMocks.getParentGalleryMedia.mockResolvedValue({ ok: true, media: [{ id: "m1" }] })
    galleryMocks.verify
      .mockResolvedValueOnce({ ok: false, reason: "auth_unavailable" })
      .mockResolvedValueOnce({ ok: true, context: GALLERY_CONTEXT })

    const first = await GET(new Request("http://x/api/parent/gallery"))
    expect(first.status).toBe(503)
    expect((await first.json()).code).toBe("SESSION_CHECK_UNAVAILABLE")
    expect(galleryMocks.end).not.toHaveBeenCalled()
    expect(galleryMocks.getParentGalleryMedia).not.toHaveBeenCalled() // fails closed

    const second = await GET(new Request("http://x/api/parent/gallery"))
    expect(second.status).toBe(200)
    expect((await second.json()).media).toEqual([{ id: "m1" }])
    expect(galleryMocks.end).not.toHaveBeenCalled()
  })

  test("definite expiry still returns 401 and signs out", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    galleryMocks.verify.mockResolvedValue({ ok: false, reason: "session_expired" })
    const res = await GET(new Request("http://x/api/parent/gallery"))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("PARENT_SESSION_EXPIRED")
    expect(galleryMocks.end).toHaveBeenCalledTimes(1)
    expect(galleryMocks.getParentGalleryMedia).not.toHaveBeenCalled()
  })

  test("valid session -> allowed, and the verified context (never a browser value) reaches the loader", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    galleryMocks.getParentGalleryMedia.mockResolvedValue({ ok: true, media: [], nextCursor: null })
    galleryMocks.verify.mockResolvedValue({ ok: true, context: GALLERY_CONTEXT })
    expect((await GET(new Request("http://x/api/parent/gallery?parentId=evil"))).status).toBe(200)
    expect(galleryMocks.getParentGalleryMedia.mock.calls[0][0]).toBe(GALLERY_CONTEXT)
  })

  test("no session -> 401 authentication failure (unchanged), no sign-out", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    galleryMocks.verify.mockResolvedValue({ ok: false, reason: "unauthenticated" })
    expect((await GET(new Request("http://x/api/parent/gallery"))).status).toBe(401)
    expect(galleryMocks.end).not.toHaveBeenCalled()
  })
})

// ── Real middleware ──────────────────────────────────────────────────────────
const mw = vi.hoisted(() => ({ factory: vi.fn() }))
vi.mock("@supabase/ssr", () => ({ createServerClient: mw.factory }))

interface FakeOpts {
  user?: { id: string } | null
  getUserError?: unknown
  getUserThrows?: boolean
  role?: string | null
  sessions?: SessionKind[]
}
function fakeSupabase(o: FakeOpts) {
  const reader = sessionReader(o.sessions ?? ["valid"])
  const client = {
    auth: {
      getUser: vi.fn(async () => {
        if (o.getUserThrows) throw new TypeError("fetch failed")
        return { data: { user: o.user === undefined ? { id: "u1" } : o.user }, error: o.getUserError ?? null }
      }),
      ...reader,
      signOut: vi.fn(async () => ({})),
    },
    rpc: vi.fn(),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: o.role === null ? null : { role: o.role ?? "parent", consent_granted: true }, error: null }),
        }),
      }),
    })),
  }
  mw.factory.mockReturnValue(client)
  return client
}
const req = (path: string) =>
  new NextRequest(`http://localhost${path}`, { headers: { cookie: "sb-x-auth-token=base64-VALIDSESSION" } })

describe("middleware", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon"
    mw.factory.mockReset()
  })

  test("valid session -> protected request allowed", async () => {
    fakeSupabase({})
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard/orders"))
    expect(res.status).toBe(200)
    expect(res.headers.get("location")).toBeNull()
  })

  test("V0.1.53: the middleware no longer reads the session lifetime or a role - those are the page gates' (backend) job", async () => {
    const c = fakeSupabase({ sessions: ["expired"] })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard/orders"))
    expect(res.status).toBe(200) // a session exists; the 30-day decision is made by gateParentPage() against PostgreSQL
    expect(c.auth.getSession).not.toHaveBeenCalled()
    expect(c.auth.signOut).not.toHaveBeenCalled()
    expect(c.from).not.toHaveBeenCalled()
  })

  test("definite unauthenticated (no user) -> login redirect, not 503", async () => {
    fakeSupabase({ user: null, getUserError: new AuthApiError("invalid JWT", 401, "bad_jwt") })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard/orders"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
  })

  test("getUser network failure (retryable) -> 503, no signOut, not a login redirect", async () => {
    const c = fakeSupabase({ user: null, getUserError: new AuthRetryableFetchError("fetch failed", 0) })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard/orders"))
    expect(res.status).toBe(503)
    expect(res.headers.get("location")).toBeNull()
    expect(c.auth.signOut).not.toHaveBeenCalled()
  })

  test("getUser throwing -> 503, no signOut", async () => {
    const c = fakeSupabase({ getUserThrows: true })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard/orders"))
    expect(res.status).toBe(503)
    expect(c.auth.signOut).not.toHaveBeenCalled()
  })

  test("admin route: a signed-in caller passes the Edge with no lookup (the layout gate decides the role)", async () => {
    const c = fakeSupabase({ role: "parent", sessions: ["transient"] })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/admin/requests"))
    expect(res.status).toBe(200)
    expect(c.from).not.toHaveBeenCalled()
    expect(c.auth.getSession).not.toHaveBeenCalled()
    expect(c.auth.signOut).not.toHaveBeenCalled()
  })

  test("admin route: definite unauthenticated still goes to admin-login", async () => {
    fakeSupabase({ user: null })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/admin/requests"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin-login")
  })

  test("no redirect loop: the login page is outside the middleware matcher", async () => {
    const { config } = await import("@/middleware")
    const matchesLogin = config.matcher.some((m: string) => new RegExp(`^${m.replace(/:path\*/g, ".*")}$`).test("/login"))
    expect(matchesLogin).toBe(false)
  })
})
