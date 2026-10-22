import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import {
  ASSERTION_LIFETIME_SECONDS,
  bodyDigest,
  newWriteNonce,
  signAssertion,
  signWriteAssertion,
  verifyAssertion,
} from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"

/**
 * V0.1.47 write assertions (v3): nonce + body digest on top of the v2 claims,
 * accepted only for writes; v2 accepted only for reads. Pure, no I/O.
 */

const SECRET = Buffer.from("ab".repeat(32), "hex")
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const NOW = 1_800_000_000_000
const AUTHENTICATED_AT = NOW - 86_400_000
const BODY = '{"fullName":"Parent A"}'
const NONCE = "N".repeat(43)

const sign = (over: Partial<{ method: string; path: string; body: string | Uint8Array; nonce: string; now: number; secret: Buffer }> = {}) =>
  signWriteAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }),
    authenticatedAt: AUTHENTICATED_AT,
    requestId: "write-req-000001",
    method: over.method ?? "PATCH",
    path: over.path ?? "/v1/parent/profile",
    body: over.body ?? BODY,
    nonce: over.nonce ?? NONCE,
    secret: over.secret ?? SECRET,
    now: over.now ?? NOW,
  })

const verify = (token: unknown, over: Partial<{ method: string; path: string; body: string | Uint8Array; kind: "read" | "write"; now: number }> = {}) =>
  verifyAssertion({
    token,
    secret: SECRET,
    method: over.method ?? "PATCH",
    path: over.path ?? "/v1/parent/profile",
    now: over.now ?? NOW,
    kind: over.kind ?? "write",
    body: "body" in over ? over.body : BODY,
  })

/** Re-sign an arbitrary payload with the real secret: forgeries that pass the MAC. */
function forge(payload: Record<string, unknown>, version = "v3"): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const mac = createHmac("sha256", SECRET).update(`cartoona-internal-auth\n${version}\n`).update(encoded).digest("base64url")
  return `${version}.${encoded}.${mac}`
}

const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))

describe("v3 format", () => {
  it("round-trips identity, binding, nonce and body digest", () => {
    const token = sign()
    expect(token.startsWith("v3.")).toBe(true)
    expect(verify(token)).toEqual({
      ok: true,
      claims: {
        provider: "supabase",
        subject: SUBJECT,
        authenticatedAt: AUTHENTICATED_AT,
        requestId: "write-req-000001",
        method: "PATCH",
        path: "/v1/parent/profile",
        issuedAt: NOW / 1000,
        expiresAt: NOW / 1000 + ASSERTION_LIFETIME_SECONDS,
        version: 3,
        nonce: NONCE,
        bodyDigest: bodyDigest(BODY),
      },
    })
  })

  it("payload has exactly the v3 keys: no role, user id, profile id or PII", () => {
    expect(Object.keys(payloadOf(sign())).sort()).toEqual(["aat", "bdg", "exp", "iat", "mth", "nce", "prv", "pth", "rid", "sub", "v"])
  })

  it("the digest is SHA-256 over the exact bytes, base64url (43 chars)", () => {
    expect(bodyDigest("")).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")
    expect(bodyDigest(BODY)).toBe(bodyDigest(new TextEncoder().encode(BODY)))
    // Same JSON value, different bytes -> different digest: no canonicalization.
    expect(bodyDigest('{"fullName":"Parent A"}')).not.toBe(bodyDigest('{ "fullName": "Parent A" }'))
  })

  it("fresh nonces are 43-char base64url and unique", () => {
    const nonces = new Set(Array.from({ length: 1000 }, newWriteNonce))
    expect(nonces.size).toBe(1000)
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // Without an injected nonce, every signature carries a new one.
    const a = signWriteAssertion({ identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: AUTHENTICATED_AT, requestId: "write-req-000001", method: "POST", path: "/v1/x", body: BODY, secret: SECRET, now: NOW })
    const b = signWriteAssertion({ identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: AUTHENTICATED_AT, requestId: "write-req-000001", method: "POST", path: "/v1/x", body: BODY, secret: SECRET, now: NOW })
    expect(payloadOf(a).nce).not.toBe(payloadOf(b).nce)
  })

  it("signing refuses read methods, unsafe paths and malformed nonces", () => {
    for (const method of ["GET", "HEAD", "TRACE"]) expect(() => sign({ method })).toThrow(TypeError)
    expect(() => sign({ path: "/v1/parent/profile?x=1" })).toThrow(TypeError)
    for (const nonce of ["", "short", "N".repeat(44), "N".repeat(42) + "/"]) expect(() => sign({ nonce })).toThrow(TypeError)
  })
})

describe("body binding (4)", () => {
  it("body changed after signing -> body_mismatch", () => {
    expect(verify(sign(), { body: '{"fullName":"Parent B"}' })).toEqual({ ok: false, reason: "body_mismatch" })
  })

  it("same assertion with a re-serialized but equal body -> body_mismatch", () => {
    expect(verify(sign(), { body: '{ "fullName": "Parent A" }' })).toEqual({ ok: false, reason: "body_mismatch" })
  })

  it("a write verified without its body is refused", () => {
    expect(verify(sign(), { body: undefined })).toEqual({ ok: false, reason: "binding_mismatch" })
  })

  it("an empty body verifies only against the digest of zero bytes", () => {
    expect(verify(sign({ method: "DELETE", body: "" }), { method: "DELETE", body: new Uint8Array(0) }).ok).toBe(true)
    expect(verify(sign({ method: "DELETE", body: "" }), { method: "DELETE", body: "{}" })).toEqual({ ok: false, reason: "body_mismatch" })
  })
})

describe("method / path / version binding", () => {
  it("rebound to another path or method -> binding_mismatch", () => {
    expect(verify(sign(), { path: "/v1/parent/orders" })).toEqual({ ok: false, reason: "binding_mismatch" })
    expect(verify(sign(), { method: "POST" })).toEqual({ ok: false, reason: "binding_mismatch" })
  })

  it("a write assertion is useless on a GET/read", () => {
    expect(verify(sign(), { kind: "read", method: "GET" })).toEqual({ ok: false, reason: "unsupported_version" })
  })

  it("a v2 read assertion never authorizes a write", () => {
    const v2 = signAssertion({ identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: AUTHENTICATED_AT, requestId: "write-req-000001", method: "GET", path: "/v1/parent/profile", secret: SECRET, now: NOW })
    expect(verify(v2)).toEqual({ ok: false, reason: "unsupported_version" })
    // Relabelled as v3: the MAC context differs, so the v2 MAC fails.
    expect(verify(`v3.${v2.split(".")[1]}.${v2.split(".")[2]}`)).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("v2-shaped claims under a valid v3 MAC are refused (missing nonce/digest)", () => {
    const p = payloadOf(sign())
    delete p.nce
    expect(verify(forge(p))).toEqual({ ok: false, reason: "invalid_claims" })
    const q = payloadOf(sign())
    delete q.bdg
    expect(verify(forge(q))).toEqual({ ok: false, reason: "invalid_claims" })
  })

  it("forged nonce / digest formats, write claims with v:2, and read methods are refused even under a valid MAC", () => {
    expect(verify(forge({ ...payloadOf(sign()), nce: "x" }))).toEqual({ ok: false, reason: "invalid_claims" })
    expect(verify(forge({ ...payloadOf(sign()), bdg: "x" }))).toEqual({ ok: false, reason: "invalid_claims" })
    expect(verify(forge({ ...payloadOf(sign()), v: 2 }))).toEqual({ ok: false, reason: "unsupported_version" })
    expect(verify(forge({ ...payloadOf(sign()), mth: "GET" }), { method: "GET" })).toEqual({ ok: false, reason: "invalid_claims" })
    // Extra keys (e.g. a smuggled role or user id) are refused.
    expect(verify(forge({ ...payloadOf(sign()), role: "admin" }))).toEqual({ ok: false, reason: "invalid_claims" })
  })

  it("a wrong secret -> bad_signature", () => {
    expect(verify(sign({ secret: Buffer.from("cd".repeat(32), "hex") }))).toEqual({ ok: false, reason: "bad_signature" })
  })
})

describe("time", () => {
  it("expired after its 30 s lifetime; not valid from the future beyond skew", () => {
    expect(verify(sign(), { now: NOW + ASSERTION_LIFETIME_SECONDS * 1000 })).toEqual({ ok: false, reason: "expired" })
    expect(verify(sign(), { now: NOW + (ASSERTION_LIFETIME_SECONDS - 1) * 1000 }).ok).toBe(true)
    expect(verify(sign({ now: NOW + 60_000 }))).toEqual({ ok: false, reason: "not_yet_valid" })
  })
})
