import { describe, test, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { AuthRetryableFetchError, AuthApiError } from "@supabase/supabase-js"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import {
  createParentSessionFailureResponse,
  SESSION_CHECK_UNAVAILABLE_BODY,
} from "@/lib/auth/expired-parent-session-response"

// ─────────────────────────────────────────────────────────────────────────────
// A failed session-lifetime lookup (transient network / Supabase error) must
// fail closed WITHOUT revoking the session. Only a definite expiry or missing
// session may call signOut. These tests pin lookup_failed != expired.
// ─────────────────────────────────────────────────────────────────────────────

const FUTURE = { is_valid: true, session_started_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-31T00:00:00Z" }
const EXPIRED = { is_valid: false, session_started_at: "2025-01-01T00:00:00Z", expires_at: "2025-01-31T00:00:00Z" }
const MISSING = { is_valid: false, session_started_at: null, expires_at: null }

function rpcClient(outcomes: Array<{ data: unknown; error: { message: string } | null }>) {
  const queue = [...outcomes]
  return {
    rpc: vi.fn(async () => queue.length > 1 ? queue.shift()! : queue[0]),
  }
}
const TRANSIENT = { data: null, error: { message: "fetch failed" } }

describe("checkCurrentParentSessionLifetime outcomes", () => {
  test("valid", async () => {
    const r = await checkCurrentParentSessionLifetime(rpcClient([{ data: [FUTURE], error: null }]))
    expect(r.valid).toBe(true)
  })
  test("expired", async () => {
    const r = await checkCurrentParentSessionLifetime(rpcClient([{ data: [EXPIRED], error: null }]))
    expect(r).toEqual({ valid: false, reason: "expired" })
  })
  test("missing_session", async () => {
    const r = await checkCurrentParentSessionLifetime(rpcClient([{ data: [MISSING], error: null }]))
    expect(r).toEqual({ valid: false, reason: "missing_session" })
  })
  test("RPC/network failure is lookup_failed, never expired", async () => {
    const r = await checkCurrentParentSessionLifetime(rpcClient([TRANSIENT]))
    expect(r).toEqual({ valid: false, reason: "lookup_failed" })
  })
  test("malformed payload is lookup_failed", async () => {
    const r = await checkCurrentParentSessionLifetime(rpcClient([{ data: [], error: null }]))
    expect(r).toEqual({ valid: false, reason: "lookup_failed" })
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

// ── Real API route: GET /api/parent/gallery ──────────────────────────────────
const galleryMocks = vi.hoisted(() => ({
  client: null as unknown,
  getParentGalleryMedia: vi.fn(),
}))
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => galleryMocks.client,
}))
vi.mock("@/lib/parent/gallery/queries", () => ({
  getParentGalleryMedia: galleryMocks.getParentGalleryMedia,
}))

describe("API route: lookup_failed fails closed, keeps session, retry works", () => {
  beforeEach(() => galleryMocks.getParentGalleryMedia.mockReset())

  function sessionClient(rpcOutcomes: Array<{ data: unknown; error: { message: string } | null }>) {
    const rpc = rpcClient(rpcOutcomes)
    return {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })),
        signOut: vi.fn(async () => ({})),
      },
      rpc: rpc.rpc,
    }
  }

  test("lookup_failed: 503, no signOut, no protected data; retry on SAME session succeeds", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    galleryMocks.getParentGalleryMedia.mockResolvedValue({ ok: true, media: [{ id: "m1" }] })
    const client = sessionClient([TRANSIENT, { data: [FUTURE], error: null }])
    galleryMocks.client = client

    const first = await GET(new Request("http://x/api/parent/gallery"))
    expect(first.status).toBe(503)
    expect((await first.json()).code).toBe("SESSION_CHECK_UNAVAILABLE")
    expect(client.auth.signOut).not.toHaveBeenCalled()
    expect(galleryMocks.getParentGalleryMedia).not.toHaveBeenCalled() // fails closed

    // Backend healthy again; same client / same session, no re-login.
    const second = await GET(new Request("http://x/api/parent/gallery"))
    expect(second.status).toBe(200)
    expect((await second.json()).media).toEqual([{ id: "m1" }])
    expect(client.auth.signOut).not.toHaveBeenCalled()
  })

  test("definite expiry still returns 401 and signs out", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    const client = sessionClient([{ data: [EXPIRED], error: null }])
    galleryMocks.client = client
    const res = await GET(new Request("http://x/api/parent/gallery"))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("PARENT_SESSION_EXPIRED")
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" })
    expect(galleryMocks.getParentGalleryMedia).not.toHaveBeenCalled()
  })

  test("valid session -> allowed", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    galleryMocks.getParentGalleryMedia.mockResolvedValue({ ok: true, media: [] })
    galleryMocks.client = sessionClient([{ data: [FUTURE], error: null }])
    expect((await GET(new Request("http://x/api/parent/gallery"))).status).toBe(200)
  })

  test("no user -> 401 authentication failure (unchanged), no signOut", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route")
    const client = sessionClient([{ data: [FUTURE], error: null }])
    client.auth.getUser = vi.fn(async () => ({ data: { user: null }, error: { message: "no" } })) as never
    galleryMocks.client = client
    expect((await GET(new Request("http://x/api/parent/gallery"))).status).toBe(401)
    expect(client.auth.signOut).not.toHaveBeenCalled()
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
  rpcOutcomes?: Array<{ data: unknown; error: { message: string } | null }>
}
function fakeSupabase(o: FakeOpts) {
  const rpc = rpcClient(o.rpcOutcomes ?? [{ data: [FUTURE], error: null }])
  const client = {
    auth: {
      getUser: vi.fn(async () => {
        if (o.getUserThrows) throw new TypeError("fetch failed")
        return { data: { user: o.user === undefined ? { id: "u1" } : o.user }, error: o.getUserError ?? null }
      }),
      signOut: vi.fn(async () => ({})),
    },
    rpc: rpc.rpc,
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

  test("expired -> signOut + login redirect with session_expired (existing UX)", async () => {
    const c = fakeSupabase({ rpcOutcomes: [{ data: [EXPIRED], error: null }] })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard/orders"))
    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.pathname).toBe("/login")
    expect(loc.searchParams.get("reason")).toBe("session_expired")
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: "local" })
  })

  test("missing_session -> login redirect (unauthenticated behaviour kept)", async () => {
    const c = fakeSupabase({ rpcOutcomes: [{ data: [MISSING], error: null }] })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
    expect(c.auth.signOut).toHaveBeenCalledTimes(1)
  })

  test("lookup_failed -> 503, signOut NOT called, no content, no redirect, no cookie clearing", async () => {
    const c = fakeSupabase({ rpcOutcomes: [TRANSIENT] })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/dashboard/orders"))
    expect(res.status).toBe(503)
    expect(res.headers.get("location")).toBeNull() // no redirect, so no loop
    expect(res.headers.get("x-middleware-next")).toBeNull() // request is NOT passed through
    expect(res.headers.get("Retry-After")).toBeTruthy()
    expect(c.auth.signOut).not.toHaveBeenCalled()
    expect(res.cookies.getAll().filter((x) => x.value === "" || x.maxAge === 0)).toHaveLength(0)
    expect(await res.text()).not.toMatch(/fetch failed|rpc/i)
  })

  test("lookup_failed then healthy backend: same session passes with no re-login", async () => {
    const c = fakeSupabase({ rpcOutcomes: [TRANSIENT, { data: [FUTURE], error: null }] })
    const { middleware } = await import("@/middleware")
    expect((await middleware(req("/dashboard/orders"))).status).toBe(503)
    const retry = await middleware(req("/dashboard/orders")) // identical cookie
    expect(retry.status).toBe(200)
    expect(retry.headers.get("location")).toBeNull()
    expect(c.auth.signOut).not.toHaveBeenCalled()
  })

  test("lookup_failed also protects /complete-request", async () => {
    const c = fakeSupabase({ rpcOutcomes: [TRANSIENT] })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/complete-request"))
    expect(res.status).toBe(503)
    expect(c.auth.signOut).not.toHaveBeenCalled()
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

  test("admin route unaffected: no parent lifetime RPC, admin passes", async () => {
    const c = fakeSupabase({ role: "admin", rpcOutcomes: [TRANSIENT] })
    const { middleware } = await import("@/middleware")
    const res = await middleware(req("/admin/requests"))
    expect(res.status).toBe(200)
    expect(c.rpc).not.toHaveBeenCalled()
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
