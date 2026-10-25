import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const supabase = vi.hoisted(() => ({ created: 0, updateUser: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => {
    supabase.created += 1
    return {
      auth: { getUser: async () => ({ data: { user: null }, error: null }), updateUser: supabase.updateUser },
      from: () => { throw new Error("no table read expected") },
      rpc: () => { throw new Error("no rpc expected") },
    }
  },
}))
vi.mock("@/lib/observability/request-context", async (orig) => ({ ...(await orig<typeof import("@/lib/observability/request-context")>()), log: () => {} }))
// V0.1.53: the caller is verified by the shared helpers (Supabase Auth + the backend role); signed out here.
vi.mock("@/lib/parent/backend-caller", () => ({ verifyParentCaller: async () => (supabase.created++, { ok: false, reason: "unauthenticated" }) }))
vi.mock("@/lib/auth/backend-role", () => ({ resolveCallerRole: async () => (supabase.created++, { ok: false, reason: "unauthenticated" }) }))

import { POST as passwordPOST } from "@/app/api/parent/password/route"
import { POST as bindPOST } from "@/app/api/referrals/bind/route"
import { PATCH as settingsPATCH } from "@/app/api/admin/referrals/settings/route"

/**
 * V0.1.49: the three pre-V0.1.48 browser writes use the shared CSRF guard
 * (lib/security/csrf.ts) instead of their ad-hoc Origin checks, which
 * accepted a MISSING Origin, any localhost port (also in production) and
 * whatever NEXT_PUBLIC_SITE_URL said. Their auth, role, body and business
 * logic (Supabase Auth for the password, Supabase RPC for referrals) are
 * untouched; a refused request never verifies a session.
 */

const ORIGIN = "http://localhost:3000"
const ROUTES = [
  ["POST /api/parent/password", passwordPOST, "POST", "/api/parent/password", '{"password":"Correct-horse-1","confirmPassword":"Correct-horse-1"}'],
  ["POST /api/referrals/bind", bindPOST, "POST", "/api/referrals/bind", '{"code":"CT0123456789AB"}'],
  ["PATCH /api/admin/referrals/settings", settingsPATCH, "PATCH", "/api/admin/referrals/settings", '{"isEnabled":true}'],
] as const

function call(route: (typeof ROUTES)[number], headers: Record<string, string>) {
  const [, handler, method, path, body] = route
  return handler(new Request(`${ORIGIN}${path}`, { method, headers, body }))
}
const good = { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" }
const without = (key: string) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== key))

beforeEach(() => {
  supabase.created = 0
  supabase.updateUser.mockReset()
  vi.stubEnv("CARTOONA_APP_ORIGIN", "")
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site-url.example")
})
afterEach(() => vi.unstubAllEnvs())

describe.each(ROUTES)("%s", (...route) => {
  it.each([
    ["hostile Origin", { ...good, origin: "https://evil.example" }, 403, "csrf_rejected"],
    ["MISSING Origin (the old check accepted it)", without("origin"), 403, "csrf_rejected"],
    ["another localhost port (the old check accepted it)", { ...good, origin: "http://localhost:3001" }, 403, "csrf_rejected"],
    ["NEXT_PUBLIC_SITE_URL is no longer an allow-list", { ...good, origin: "https://site-url.example" }, 403, "csrf_rejected"],
    ["cross-site fetch metadata", { ...good, "sec-fetch-site": "cross-site" }, 403, "csrf_rejected"],
    ["form post", { ...good, "content-type": "application/x-www-form-urlencoded" }, 415, "unsupported_media_type"],
    ["text/plain", { ...good, "content-type": "text/plain" }, 415, "unsupported_media_type"],
  ])("%s -> %i %s, before any Supabase work", async (_label, headers, status, code) => {
    const res = await call(route, headers as Record<string, string>)
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(supabase.created).toBe(0)
    expect(supabase.updateUser).not.toHaveBeenCalled()
  })

  it("production with CARTOONA_APP_ORIGIN unset -> 503, fail closed", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const res = await call(route, good)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("csrf_not_configured")
    expect(supabase.created).toBe(0)
  })

  it("the same-origin JSON request passes the guard and reaches the unchanged auth check (401 signed out)", async () => {
    const res = await call(route, good)
    expect(res.status).toBe(401)
    expect(supabase.created).toBe(1)
    expect(supabase.updateUser).not.toHaveBeenCalled()
  })

  it("the configured origin is honoured exactly", async () => {
    vi.stubEnv("CARTOONA_APP_ORIGIN", "https://cartoona.example")
    expect((await call(route, { ...good, origin: "https://cartoona.example" })).status).toBe(401)
    expect((await call(route, good)).status).toBe(403)
  })
})
