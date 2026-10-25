import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * V0.1.53: the authoritative server-side page gates. The role comes from
 * resolveCallerRole() (verified identity -> backend -> PostgreSQL); nothing here
 * reads a Supabase table. redirect() throws, so nothing after a failed gate renders.
 */

const m = vi.hoisted(() => ({ resolve: vi.fn(), end: vi.fn() }))
vi.mock("@/lib/auth/backend-role", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/backend-role")>()),
  resolveCallerRole: m.resolve,
}))
vi.mock("@/lib/auth/end-parent-session", () => ({ endParentSession: m.end }))
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

import { gateAdminPage, gateParentPage } from "@/lib/auth/page-gates"

const ok = (role: string) => ({ ok: true, role, userId: "u", context: { identity: { provider: "supabase", subject: "u" }, authenticatedAt: 1 } })
const fail = (reason: string) => ({ ok: false, reason })
const to = async (p: Promise<unknown>) => p.then(() => "no-redirect", (e: Error) => e.message)

beforeEach(() => {
  m.resolve.mockReset()
  m.end.mockReset()
})

describe("gateAdminPage", () => {
  it("admin and super_admin pass", async () => {
    for (const role of ["admin", "super_admin"]) {
      m.resolve.mockResolvedValue(ok(role))
      expect((await gateAdminPage()).ok).toBe(true)
    }
  })
  it("a parent is sent to /dashboard (never sees admin markup)", async () => {
    m.resolve.mockResolvedValue(ok("parent"))
    expect(await to(gateAdminPage())).toBe("REDIRECT:/dashboard")
  })
  it.each([
    ["unauthenticated", "REDIRECT:/admin-login?from=%2Fadmin"],
    ["identity_not_linked", "REDIRECT:/dashboard"],
    ["forbidden", "REDIRECT:/dashboard"],
  ])("%s -> %s", async (reason, expected) => {
    m.resolve.mockResolvedValue(fail(reason))
    expect(await to(gateAdminPage())).toBe(expected)
  })
  it("an expired session is ended and sent to the admin login", async () => {
    m.resolve.mockResolvedValue(fail("session_expired"))
    expect(await to(gateAdminPage())).toBe("REDIRECT:/admin-login?reason=session_expired&from=%2Fadmin")
    expect(m.end).toHaveBeenCalledTimes(1)
  })
  it("an outage is neither access nor a sign-out: unavailable", async () => {
    m.resolve.mockResolvedValue(fail("unavailable"))
    expect(await gateAdminPage()).toEqual({ ok: false, unavailable: true })
    expect(m.end).not.toHaveBeenCalled()
  })
})

describe("gateParentPage", () => {
  it("a parent passes; an admin passes /dashboard but is redirected from parent-only steps", async () => {
    m.resolve.mockResolvedValue(ok("parent"))
    expect((await gateParentPage("/dashboard")).ok).toBe(true)
    m.resolve.mockResolvedValue(ok("admin"))
    expect((await gateParentPage("/dashboard")).ok).toBe(true)
    expect(await to(gateParentPage("/complete-request", { adminTo: "/admin" }))).toBe("REDIRECT:/admin")
  })
  it("an unlinked identity goes to /parent-consent, except on that page itself (no loop)", async () => {
    m.resolve.mockResolvedValue(fail("identity_not_linked"))
    expect(await to(gateParentPage("/dashboard"))).toBe("REDIRECT:/parent-consent")
    expect(await gateParentPage("/parent-consent", { allowUnlinked: true })).toEqual({ ok: true, resolution: null })
  })
  it("signed out / deleted -> /login with the return path; expired -> ended + login with the reason", async () => {
    m.resolve.mockResolvedValue(fail("unauthenticated"))
    expect(await to(gateParentPage("/dashboard"))).toBe("REDIRECT:/login?from=%2Fdashboard")
    m.resolve.mockResolvedValue(fail("forbidden"))
    expect(await to(gateParentPage("/dashboard"))).toBe("REDIRECT:/login?from=%2Fdashboard")
    m.resolve.mockResolvedValue(fail("session_expired"))
    expect(await to(gateParentPage("/dashboard"))).toBe("REDIRECT:/login?reason=session_expired&from=%2Fdashboard")
    expect(m.end).toHaveBeenCalledTimes(1)
  })
  it("a backend/provider outage is unavailable (retry), never access", async () => {
    m.resolve.mockResolvedValue(fail("unavailable"))
    expect(await gateParentPage("/dashboard")).toEqual({ ok: false, unavailable: true })
  })
})
