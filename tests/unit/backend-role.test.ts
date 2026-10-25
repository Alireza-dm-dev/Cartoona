import { describe, it, expect, vi, beforeEach } from "vitest"

const m = vi.hoisted(() => ({ callGet: vi.fn(), verify: vi.fn() }))
vi.mock("@/lib/backend/call", () => ({ callGet: m.callGet }))
vi.mock("@/lib/auth/supabase-identity-adapter", () => ({ verifySupabaseIdentity: m.verify }))
vi.mock("@/lib/observability/request-context", () => ({ log: () => {} }))

import { resolveCallerRole, resolveRoleForContext } from "@/lib/auth/backend-role"

const CTX = { identity: { provider: "supabase", subject: "11111111-1111-4111-8111-111111111111" }, authenticatedAt: 1 } as never
const UID = "22222222-2222-4222-8222-222222222222"

beforeEach(() => {
  m.callGet.mockReset()
  m.verify.mockReset()
})

describe("resolveRoleForContext: the role is what PostgreSQL says (GET /v1/auth/me), nothing else", () => {
  it("returns the role and Cartoona user id", async () => {
    m.callGet.mockResolvedValue({ ok: true, status: 200, body: { authenticated: true, userId: UID, role: "super_admin" } })
    expect(await resolveRoleForContext(CTX)).toMatchObject({ ok: true, role: "super_admin", userId: UID })
    expect(m.callGet.mock.calls[0].slice(0, 1)).toEqual([CTX])
    expect(m.callGet.mock.calls[0][2]).toBe("/v1/auth/me")
  })
  it.each([
    [{ kind: "auth", reason: "session_expired" }, "session_expired"],
    [{ kind: "auth", reason: "session_invalidated" }, "session_expired"],
    [{ kind: "auth", reason: "identity_not_linked" }, "identity_not_linked"],
    [{ kind: "auth", reason: "forbidden" }, "forbidden"],
    [{ kind: "auth", reason: "unauthenticated" }, "unavailable"], // the backend rejecting OUR assertion is a misconfiguration, not the visitor's session
    [{ kind: "unavailable", outcomeUnknown: false }, "unavailable"],
    [{ kind: "refused", status: 400, error: "x", body: {} }, "unavailable"],
  ])("%j -> %s", async (failure, reason) => {
    m.callGet.mockResolvedValue({ ok: false, ...failure })
    expect(await resolveRoleForContext(CTX)).toEqual({ ok: false, reason })
  })
  it("a malformed or widened /v1/auth/me body is unavailable, never a guessed role", async () => {
    for (const body of [{ userId: UID, role: "owner" }, { userId: "nope", role: "parent" }, { role: "admin" }]) {
      m.callGet.mockResolvedValue({ ok: true, status: 200, body })
      expect(await resolveRoleForContext(CTX)).toEqual({ ok: false, reason: "unavailable" })
    }
  })
})

describe("resolveCallerRole: Supabase Auth proves WHO first", () => {
  it.each([
    ["no_session", "unauthenticated"],
    ["invalid_session", "unauthenticated"],
    ["session_expired", "session_expired"],
    ["auth_unavailable", "unavailable"],
  ])("provider %s -> %s, and the backend is not asked", async (providerReason, reason) => {
    m.verify.mockResolvedValue({ ok: false, reason: providerReason })
    expect(await resolveCallerRole()).toEqual({ ok: false, reason })
    expect(m.callGet).not.toHaveBeenCalled()
  })
  it("a verified identity is resolved through the backend", async () => {
    m.verify.mockResolvedValue({ ok: true, context: CTX })
    m.callGet.mockResolvedValue({ ok: true, status: 200, body: { authenticated: true, userId: UID, role: "parent" } })
    expect(await resolveCallerRole()).toMatchObject({ ok: true, role: "parent" })
  })
})
