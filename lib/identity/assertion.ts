import { createHmac, timingSafeEqual } from "node:crypto"
import { isSafeRequestId } from "@/lib/observability/request-id"
import { isIdentityProvider, isValidSubject, type IdentityProvider, type VerifiedIdentity } from "./types"

/**
 * Internal identity assertion: how the Next.js server tells the Fastify backend
 * WHO is calling, without the backend trusting a browser or calling the identity
 * provider itself (V0.1.42).
 *
 *   Next (verified the Supabase session) --signs--> assertion --header--> Fastify
 *   Fastify --verifies--> (provider, subject) --user_identities--> AuthPrincipal
 *
 * Format (one header, `X-Cartoona-Internal-Auth`):
 *
 *   v2.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 *
 * Payload, exactly these keys:
 *   v    2                       format version
 *   prv  "supabase"              identity provider
 *   sub  provider subject        (Supabase: auth user UUID)
 *   aat  authenticated at, unix seconds: when the user SIGNED IN, as verified by
 *        the provider (V0.1.43). The backend checks it against the 30-day
 *        lifetime and users.sessions_not_before. Never a token issue time.
 *   iat  issued at, unix seconds
 *   exp  expires at, unix seconds   (exp - iat <= 60; issued with 30)
 *   rid  request id               (the X-Request-Id of the call it rides on)
 *   mth  HTTP method              bound: verified against the request
 *   pth  backend path             bound: verified against the request (no query)
 *
 * NOT in it, ever: email, phone, names, profile data, provider access/refresh
 * tokens, Cartoona user id or role. The backend derives the user and role
 * from its own database.
 *
 * Versioning: v1 (V0.1.42) carried no session evidence and is REJECTED
 * (unsupported_version): an authenticated request without a sign-in time
 * cannot be checked against the session policy, so it is never accepted.
 * Both sides deploy together; there is no mixed-version window to support.
 *
 * The MAC covers a fixed context string plus the encoded payload, keyed with
 * CARTOONA_INTERNAL_AUTH_SECRET (>= 32 random bytes as hex), and is compared in
 * constant time. Shared by both sides; neutral: node:crypto only.
 *
 * Replay: an assertion is a bearer value for <= 60 s, valid for ONE method + path.
 * It travels only server-to-server on the private network and is never shown to
 * a browser. There is no replay cache (that would need shared state such as
 * Redis); short expiry plus method/path binding is the accepted bound, and every
 * route that uses it is idempotent today (GET). Revisit before a
 * non-idempotent route relies on it.
 */

export const INTERNAL_AUTH_HEADER = "X-Cartoona-Internal-Auth"
export const ASSERTION_VERSION = 2
export const ASSERTION_LIFETIME_SECONDS = 30
export const ASSERTION_MAX_LIFETIME_SECONDS = 60
/** Tolerated clock difference between Next and Fastify hosts. */
export const ASSERTION_CLOCK_SKEW_SECONDS = 5
export const ASSERTION_MAX_LENGTH = 1024

const MAC_CONTEXT = "cartoona-internal-auth\nv2\n"
const SECRET_FORMAT = /^[0-9a-fA-F]{64,256}$/
const B64URL = /^[A-Za-z0-9_-]+$/
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
const PATH = /^(\/[A-Za-z0-9_-]+)+$/
const PAYLOAD_KEYS = ["aat", "exp", "iat", "mth", "prv", "pth", "rid", "sub", "v"]

export class InternalAuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InternalAuthConfigError"
  }
}

/**
 * CARTOONA_INTERNAL_AUTH_SECRET as key bytes. Hex, 64-256 characters
 * (`openssl rand -hex 32`). No default. The message never echoes the value.
 */
export function readInternalAuthSecret(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.CARTOONA_INTERNAL_AUTH_SECRET?.trim()
  if (!raw) throw new InternalAuthConfigError("CARTOONA_INTERNAL_AUTH_SECRET is not set.")
  if (!SECRET_FORMAT.test(raw) || raw.length % 2 !== 0) {
    throw new InternalAuthConfigError("CARTOONA_INTERNAL_AUTH_SECRET must be 64-256 hex characters (openssl rand -hex 32).")
  }
  return Buffer.from(raw, "hex")
}

export interface AssertionClaims {
  provider: IdentityProvider
  subject: string
  /** Provider-verified sign-in time, epoch ms (whole seconds). */
  authenticatedAt: number
  requestId: string
  method: string
  path: string
  issuedAt: number
  expiresAt: number
}

export interface SignAssertionInput {
  identity: VerifiedIdentity
  /** Provider-verified sign-in time, epoch ms. Carried at second precision. */
  authenticatedAt: number
  requestId: string
  method: string
  path: string
  secret: Buffer
  /** Unix ms; injectable for tests. */
  now?: number
}

function mac(secret: Buffer, encodedPayload: string): Buffer {
  return createHmac("sha256", secret).update(MAC_CONTEXT).update(encodedPayload).digest()
}

export function signAssertion(input: SignAssertionInput): string {
  if (!isIdentityProvider(input.identity.provider) || !isValidSubject(input.identity.provider, input.identity.subject)) {
    throw new TypeError("assertion: invalid identity")
  }
  if (!isSafeRequestId(input.requestId)) throw new TypeError("assertion: invalid request id")
  if (!METHODS.has(input.method)) throw new TypeError("assertion: invalid method")
  if (!PATH.test(input.path)) throw new TypeError("assertion: invalid path")

  const iat = Math.floor((input.now ?? Date.now()) / 1000)
  const aat = Math.floor(input.authenticatedAt / 1000)
  if (!Number.isSafeInteger(aat) || aat <= 0 || aat > iat + ASSERTION_CLOCK_SKEW_SECONDS) {
    throw new TypeError("assertion: invalid authenticatedAt")
  }
  const payload = {
    v: ASSERTION_VERSION,
    prv: input.identity.provider,
    sub: input.identity.subject,
    aat,
    iat,
    exp: iat + ASSERTION_LIFETIME_SECONDS,
    rid: input.requestId,
    mth: input.method,
    pth: input.path,
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `v2.${encoded}.${mac(input.secret, encoded).toString("base64url")}`
}

export type AssertionFailure =
  | "malformed"
  | "bad_signature"
  | "unsupported_version"
  | "unsupported_provider"
  | "invalid_claims"
  | "expired"
  | "not_yet_valid"
  | "binding_mismatch"

export type VerifyResult =
  | { ok: true; claims: AssertionClaims }
  | { ok: false; reason: AssertionFailure }

export interface VerifyAssertionInput {
  token: unknown
  secret: Buffer
  /** What the request actually is; the assertion must have been signed for exactly this. */
  method: string
  path: string
  now?: number
}

/**
 * Verify an assertion. Order matters: structure, then the MAC (constant time)
 * over the exact received bytes, and only then is the payload parsed - nothing
 * unauthenticated is ever JSON-parsed or acted on.
 */
export function verifyAssertion(input: VerifyAssertionInput): VerifyResult {
  const fail = (reason: AssertionFailure): VerifyResult => ({ ok: false, reason })
  const token = input.token
  if (typeof token !== "string" || token.length === 0 || token.length > ASSERTION_MAX_LENGTH) return fail("malformed")

  const parts = token.split(".")
  if (parts.length !== 3) return fail("malformed")
  const [version, encoded, signature] = parts
  if (version !== "v2") return fail("unsupported_version")
  if (!B64URL.test(encoded) || !B64URL.test(signature)) return fail("malformed")

  const expected = mac(input.secret, encoded)
  const received = Buffer.from(signature, "base64url")
  // Canonical encoding only: a re-encoded signature must be byte-identical.
  if (received.length !== expected.length || received.toString("base64url") !== signature) return fail("bad_signature")
  if (!timingSafeEqual(received, expected)) return fail("bad_signature")

  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("invalid_claims")
    payload = parsed as Record<string, unknown>
  } catch {
    return fail("malformed")
  }

  if (Object.keys(payload).sort().join(",") !== PAYLOAD_KEYS.join(",")) return fail("invalid_claims")
  if (payload.v !== ASSERTION_VERSION) return fail("unsupported_version")
  if (!isIdentityProvider(payload.prv)) return fail("unsupported_provider")
  const { prv, sub, aat, iat, exp, rid, mth, pth } = payload as {
    prv: IdentityProvider; sub: unknown; aat: unknown; iat: unknown; exp: unknown; rid: unknown; mth: unknown; pth: unknown
  }
  if (!isValidSubject(prv, sub)) return fail("invalid_claims")
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return fail("invalid_claims")
  const issuedAt = iat as number
  const expiresAt = exp as number
  if (expiresAt <= issuedAt || expiresAt - issuedAt > ASSERTION_MAX_LIFETIME_SECONDS) return fail("invalid_claims")
  if (!Number.isSafeInteger(aat) || (aat as number) <= 0 || (aat as number) > issuedAt + ASSERTION_CLOCK_SKEW_SECONDS) {
    return fail("invalid_claims")
  }
  if (!isSafeRequestId(rid)) return fail("invalid_claims")
  if (typeof mth !== "string" || !METHODS.has(mth) || typeof pth !== "string" || !PATH.test(pth)) return fail("invalid_claims")

  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000)
  if (issuedAt > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS) return fail("not_yet_valid")
  if (nowSeconds >= expiresAt) return fail("expired")

  if (mth !== input.method || pth !== input.path) return fail("binding_mismatch")

  return {
    ok: true,
    claims: {
      provider: prv,
      subject: sub,
      authenticatedAt: (aat as number) * 1000,
      requestId: rid,
      method: mth,
      path: pth,
      issuedAt,
      expiresAt,
    },
  }
}
