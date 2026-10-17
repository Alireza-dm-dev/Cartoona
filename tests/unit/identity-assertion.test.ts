import { describe, it, expect, vi } from "vitest"
import crypto from "node:crypto"
import fs from "node:fs"
import {
  ASSERTION_CLOCK_SKEW_SECONDS,
  ASSERTION_LIFETIME_SECONDS,
  InternalAuthConfigError,
  readInternalAuthSecret,
  signAssertion,
  verifyAssertion,
} from "@/lib/identity/assertion"
import { toVerifiedIdentity, type VerifiedIdentity } from "@/lib/identity/types"

/**
 * The internal identity assertion (lib/identity/assertion.ts): signing,
 * constant-time verification, expiry, binding, and what it may contain.
 * Deterministic: the clock is passed in.
 */

const SECRET = Buffer.from("11".repeat(32), "hex")
const OTHER_SECRET = Buffer.from("22".repeat(32), "hex")
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const IDENTITY: VerifiedIdentity = toVerifiedIdentity({ provider: "supabase", subject: SUBJECT })
const RID = "req-0123456789abcdef"
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const BIND = { method: "GET", path: "/v1/auth/me" }

const sign = (over: Partial<Parameters<typeof signAssertion>[0]> = {}) =>
  signAssertion({ identity: IDENTITY, requestId: RID, ...BIND, secret: SECRET, now: NOW, ...over })

const verify = (token: unknown, over: Partial<Parameters<typeof verifyAssertion>[0]> = {}) =>
  verifyAssertion({ token, secret: SECRET, ...BIND, now: NOW, ...over })

const parts = (token: string) => token.split(".") as [string, string, string]
const decode = (encoded: string) => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url")
/** Re-sign an arbitrary payload with the real secret: proves checks beyond the MAC. */
const resign = (payload: unknown, secret = SECRET) => {
  const encoded = encode(payload)
  const mac = crypto.createHmac("sha256", secret).update("cartoona-internal-auth\nv1\n").update(encoded).digest("base64url")
  return `v1.${encoded}.${mac}`
}

describe("1. a valid assertion verifies", () => {
  it("round-trips provider, subject, request id and binding", () => {
    const result = verify(sign())
    expect(result).toEqual({
      ok: true,
      claims: {
        provider: "supabase",
        subject: SUBJECT,
        requestId: RID,
        method: "GET",
        path: "/v1/auth/me",
        issuedAt: NOW / 1000,
        expiresAt: NOW / 1000 + ASSERTION_LIFETIME_SECONDS,
      },
    })
  })

  it("has the documented shape and a 30-second lifetime", () => {
    const [version, encoded, signature] = parts(sign())
    expect(version).toBe("v1")
    expect(Buffer.from(signature, "base64url")).toHaveLength(32) // HMAC-SHA256
    const payload = decode(encoded)
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "mth", "prv", "pth", "rid", "sub", "v"])
    expect(payload.exp - payload.iat).toBe(30)
  })
})

describe("2/3. tampering", () => {
  it("2. any change to the payload fails the signature", () => {
    const [v, encoded, sig] = parts(sign())
    const payload = decode(encoded)
    for (const change of [
      { sub: "00000000-0000-4000-8000-000000000000" },
      { exp: payload.exp + 3600 },
      { pth: "/v1/admin" },
      { mth: "DELETE" },
      { rid: "another-request-id" },
    ]) {
      expect(verify(`${v}.${encode({ ...payload, ...change })}.${sig}`)).toEqual({ ok: false, reason: "bad_signature" })
    }
  })

  it("3. a changed, truncated, extended or re-encoded signature fails", () => {
    const [v, encoded, sig] = parts(sign())
    const flipped = sig.slice(0, -2) + (sig.at(-2) === "A" ? "B" : "A") + sig.at(-1)
    for (const bad of [flipped, sig.slice(0, -1), sig + "A", sig.slice(0, 10), "A".repeat(43)]) {
      expect(verify(`${v}.${encoded}.${bad}`)).toEqual({ ok: false, reason: "bad_signature" })
    }
  })

  it("rejects malformed tokens before any parsing", () => {
    for (const bad of [undefined, null, 42, "", "v1", "v1.abc", "v1.a.b.c", "v1.***.abc", "v1.a b.c", "x".repeat(2000), ["v1", "a", "b"]]) {
      const result = verify(bad)
      expect(result.ok).toBe(false)
    }
  })

  it("a validly signed payload that is not an object, or has extra/missing keys, is rejected", () => {
    const good = decode(parts(sign())[1])
    expect(verify(resign([1, 2]))).toEqual({ ok: false, reason: "invalid_claims" })
    expect(verify(resign({ ...good, role: "admin" }))).toEqual({ ok: false, reason: "invalid_claims" })
    expect(verify(resign({ ...good, uid: SUBJECT }))).toEqual({ ok: false, reason: "invalid_claims" })
    const missing = { ...good }
    delete missing.rid
    expect(verify(resign(missing))).toEqual({ ok: false, reason: "invalid_claims" })
  })
})

describe("4/5. time", () => {
  it("4. expires at exp, not after", () => {
    const token = sign()
    expect(verify(token, { now: NOW + (ASSERTION_LIFETIME_SECONDS - 1) * 1000 }).ok).toBe(true)
    expect(verify(token, { now: NOW + ASSERTION_LIFETIME_SECONDS * 1000 })).toEqual({ ok: false, reason: "expired" })
    expect(verify(token, { now: NOW + 3600_000 })).toEqual({ ok: false, reason: "expired" })
  })

  it("5. a future-issued assertion is rejected beyond the clock-skew allowance", () => {
    const token = sign({ now: NOW + (ASSERTION_CLOCK_SKEW_SECONDS + 1) * 1000 })
    expect(verify(token)).toEqual({ ok: false, reason: "not_yet_valid" })
    expect(verify(sign({ now: NOW + ASSERTION_CLOCK_SKEW_SECONDS * 1000 })).ok).toBe(true)
  })

  it("a long-lived assertion is rejected even when correctly signed", () => {
    const good = decode(parts(sign())[1])
    expect(verify(resign({ ...good, exp: good.iat + 61 }))).toEqual({ ok: false, reason: "invalid_claims" })
    expect(verify(resign({ ...good, exp: good.iat }))).toEqual({ ok: false, reason: "invalid_claims" })
    expect(verify(resign({ ...good, iat: 1.5 }))).toEqual({ ok: false, reason: "invalid_claims" })
  })
})

describe("6/7. version and provider", () => {
  it("6. unsupported versions are rejected", () => {
    const [, encoded, sig] = parts(sign())
    expect(verify(`v2.${encoded}.${sig}`)).toEqual({ ok: false, reason: "unsupported_version" })
    const good = decode(encoded)
    expect(verify(resign({ ...good, v: 2 }))).toEqual({ ok: false, reason: "unsupported_version" })
  })

  it("7. unsupported providers are rejected, and signing refuses them", () => {
    const good = decode(parts(sign())[1])
    for (const prv of ["google", "Supabase", "", null]) {
      expect(verify(resign({ ...good, prv }))).toEqual({ ok: false, reason: "unsupported_provider" })
    }
    expect(() => sign({ identity: toVerifiedIdentity({ provider: "google" as never, subject: SUBJECT }) })).toThrow(TypeError)
  })

  it("a subject that is not a provider-shaped id is rejected", () => {
    const good = decode(parts(sign())[1])
    for (const sub of ["", "admin", "' OR 1=1 --", SUBJECT.toUpperCase(), 42]) {
      expect(verify(resign({ ...good, sub }))).toEqual({ ok: false, reason: "invalid_claims" })
    }
    expect(() => sign({ identity: toVerifiedIdentity({ provider: "supabase", subject: "not-a-uuid" }) })).toThrow(TypeError)
  })
})

describe("8. secrets", () => {
  it("an assertion signed with another secret fails", () => {
    expect(verify(sign({ secret: OTHER_SECRET }))).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("CARTOONA_INTERNAL_AUTH_SECRET: required, hex, >= 32 bytes; never echoed", () => {
    expect(readInternalAuthSecret({ CARTOONA_INTERNAL_AUTH_SECRET: "ab".repeat(32) })).toHaveLength(32)
    for (const bad of [undefined, "", "ab".repeat(31), "zz".repeat(32), "a".repeat(65), "ab".repeat(129)]) {
      let message = ""
      try {
        readInternalAuthSecret({ CARTOONA_INTERNAL_AUTH_SECRET: bad })
      } catch (error) {
        expect(error).toBeInstanceOf(InternalAuthConfigError)
        message = (error as Error).message
      }
      expect(message).toMatch(/CARTOONA_INTERNAL_AUTH_SECRET/)
      if (bad) expect(message).not.toContain(bad)
    }
  })
})

describe("9. method and path binding", () => {
  it("an assertion is valid only for the method and path it was signed for", () => {
    const token = sign()
    expect(verify(token, { path: "/v1/creation-pricing" })).toEqual({ ok: false, reason: "binding_mismatch" })
    expect(verify(token, { path: "/v1/auth/me/x" })).toEqual({ ok: false, reason: "binding_mismatch" })
    expect(verify(token, { method: "POST" })).toEqual({ ok: false, reason: "binding_mismatch" })
    expect(verify(sign({ method: "POST", path: "/v1/orders" }), { method: "POST", path: "/v1/orders" }).ok).toBe(true)
  })

  it("signing refuses unsafe bindings and request ids", () => {
    expect(() => sign({ path: "/v1/../admin" })).toThrow(TypeError)
    expect(() => sign({ path: "/v1/auth/me?x=1" })).toThrow(TypeError)
    expect(() => sign({ method: "TRACE" })).toThrow(TypeError)
    expect(() => sign({ requestId: "bad id" })).toThrow(TypeError)
  })
})

describe("10. no PII or tokens", () => {
  it("the payload holds only provider, subject, times, request id and binding", () => {
    const payload = decode(parts(sign())[1])
    const text = JSON.stringify(payload)
    expect(text).not.toMatch(/@|phone|email|name|token|refresh|access|role|user_?id|profile/i)
    expect(payload).toEqual({
      v: 1, prv: "supabase", sub: SUBJECT, iat: NOW / 1000, exp: NOW / 1000 + 30, rid: RID, mth: "GET", pth: "/v1/auth/me",
    })
  })

  it("signAssertion copies nothing else from the identity object it is given", () => {
    const loaded = { ...IDENTITY, email: "parent@example.com", phone: "+989121234567", accessToken: "eyJhbGciOi" } as VerifiedIdentity
    const text = Buffer.from(parts(sign({ identity: loaded }))[1], "base64url").toString()
    expect(text).not.toMatch(/example\.com|989121234567|eyJhbGciOi/)
  })
})

describe("11. constant-time verification", () => {
  it("the MAC comparison uses crypto.timingSafeEqual", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual")
    try {
      // The module imports timingSafeEqual by name; prove it from the source too.
      verify(sign())
      const src = fs.readFileSync("lib/identity/assertion.ts", "utf8")
      expect(src).toMatch(/import \{ createHmac, timingSafeEqual \} from "node:crypto"/)
      expect(src).toMatch(/timingSafeEqual\(received, expected\)/)
      expect(src).not.toMatch(/received\s*===\s*expected|signature\s*===\s*expected|\.equals\(/)
    } finally {
      spy.mockRestore()
    }
  })

  it("the signature check happens before the payload is parsed", () => {
    const parse = vi.spyOn(JSON, "parse")
    try {
      const [v, encoded] = parts(sign())
      verify(`${v}.${encoded}.${"A".repeat(43)}`)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })
})
