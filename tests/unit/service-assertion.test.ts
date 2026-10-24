import { describe, it, expect } from "vitest"
import { signAssertion, signServiceAssertion, signWriteAssertion, verifyAssertion, verifyServiceAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"

/** V0.1.51 service assertions (s1): provider-authenticated internal writes, never identities. */

const secret = Buffer.alloc(32, 7)
const now = Date.UTC(2026, 9, 24, 12, 0, 0)
const P = "/v1/payments/events"
const body = '{"x":1}'
const sign = (over: Partial<Parameters<typeof signServiceAssertion>[0]> = {}) =>
  signServiceAssertion({ service: "payments", requestId: "req-000001", method: "POST", path: P, body, secret, now, ...over })
const verify = (token: string, over: Partial<Parameters<typeof verifyServiceAssertion>[0]> = {}) =>
  verifyServiceAssertion({ token, secret, method: "POST", path: P, body, now, ...over })

describe("service assertion", () => {
  it("round-trips with body digest and nonce", () => {
    const r = verify(sign())
    expect(r.ok && r.claims).toMatchObject({ service: "payments", method: "POST", path: P })
    expect(r.ok && r.claims.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it.each([
    ["tampered body", { body: '{"x":2}' }, "body_mismatch"],
    ["other path", { path: "/v1/parent/candy-purchases" }, "binding_mismatch"],
    ["other key", { secret: Buffer.alloc(32, 8) }, "bad_signature"],
    ["expired", { now: now + 61_000 }, "expired"],
  ])("refuses %s", (_l, over, reason) => {
    expect(verify(sign(), over as never)).toEqual({ ok: false, reason })
  })

  it("is not interchangeable with identity assertions in either direction", () => {
    const identity = toVerifiedIdentity({ provider: "supabase", subject: "a1000000-0000-4000-8000-000000000001" })
    const v3 = signWriteAssertion({ identity, authenticatedAt: now - 1000, requestId: "req-000001", method: "POST", path: P, body, secret, now })
    const v2 = signAssertion({ identity, authenticatedAt: now - 1000, requestId: "req-000001", method: "GET", path: P, secret, now })
    expect(verify(v3)).toEqual({ ok: false, reason: "unsupported_version" })
    expect(verify(v2)).toEqual({ ok: false, reason: "unsupported_version" })
    const s1 = sign()
    expect(verifyAssertion({ token: s1, secret, method: "POST", path: P, body, now, kind: "write" })).toEqual({ ok: false, reason: "unsupported_version" })
    // Same MAC bytes under another prefix do not verify (domain-separated context).
    const [, payload, mac] = s1.split(".")
    expect(verifyAssertion({ token: `v3.${payload}.${mac}`, secret, method: "POST", path: P, body, now, kind: "write" }).ok).toBe(false)
  })

  it("only known services, only POST", () => {
    expect(() => sign({ service: "admin" as never })).toThrow()
    expect(() => sign({ method: "GET" })).toThrow()
  })
})
