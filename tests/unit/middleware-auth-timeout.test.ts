import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { AuthRetryableFetchError } from "@supabase/supabase-js"

// Middleware + a timed-out auth/session check: must be a retryable 503 and must
// never sign the user out or clear auth cookies.
const m = vi.hoisted(() => ({ client: null as unknown, options: null as unknown }))
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, options: unknown) => {
    m.options = options
    return m.client
  },
}))

const timeoutError = new AuthRetryableFetchError("Request timed out after 10000ms", 0)

function client(over: { getUser?: unknown; rpc?: unknown }) {
  return {
    auth: { getUser: over.getUser, signOut: vi.fn(async () => ({})) },
    rpc: over.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { role: "parent" }, error: null }) }),
      }),
    }),
  }
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon"
})

describe("middleware with timed-out Supabase calls", () => {
  it("getUser() timeout -> 503, no signOut, no redirect, no protected content", async () => {
    const c = client({ getUser: async () => ({ data: { user: null }, error: timeoutError }), rpc: vi.fn() })
    m.client = c
    const { middleware } = await import("@/middleware")
    const res = await middleware(new NextRequest("http://x/dashboard"))
    expect(res.status).toBe(503)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.get("location")).toBeNull()
    expect(c.auth.signOut).not.toHaveBeenCalled()
    expect(c.rpc).not.toHaveBeenCalled()
  })

  it("session-lifetime RPC timeout -> 503, signOut NOT called", async () => {
    const c = client({
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      rpc: vi.fn(async () => ({ data: null, error: { message: "Request timed out after 10000ms" } })),
    })
    m.client = c
    const { middleware } = await import("@/middleware")
    const res = await middleware(new NextRequest("http://x/dashboard"))
    expect(res.status).toBe(503)
    expect(res.headers.get("location")).toBeNull()
    expect(c.auth.signOut).not.toHaveBeenCalled()
  })

  it("the middleware client is built with the timeout-aware fetch", async () => {
    m.client = client({ getUser: async () => ({ data: { user: null }, error: timeoutError }), rpc: vi.fn() })
    const { middleware } = await import("@/middleware")
    await middleware(new NextRequest("http://x/dashboard"))
    const { supabaseTimeoutFetch } = await import("@/lib/supabase/timeout-fetch")
    expect((m.options as { global: { fetch: unknown } }).global.fetch).toBe(supabaseTimeoutFetch)
  })
})
