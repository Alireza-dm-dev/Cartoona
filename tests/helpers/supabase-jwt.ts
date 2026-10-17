/**
 * Supabase-shaped access-token fixtures (JWT layout: header.payload.signature).
 * The signature is a placeholder: these are only ever given to code paths where
 * the PROVIDER (a fake or the local stub) decides validity, exactly as in
 * production, where getUser(token) is the verification.
 */
import { AuthRetryableFetchError } from "@supabase/supabase-js"

export const DAY_MS = 24 * 60 * 60 * 1000

export interface TokenClaims {
  sub: string
  /** Sign-in time, epoch ms -> amr[0].timestamp (unix seconds). */
  authenticatedAt: number
  /** Token issue time, epoch ms (defaults to now): a refresh changes ONLY this. */
  issuedAt?: number
  sessionId?: string
  /** Override amr entirely (e.g. string-only, empty, extra entries). */
  amr?: unknown
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

export function accessToken(claims: TokenClaims): string {
  const iat = Math.floor((claims.issuedAt ?? Date.now()) / 1000)
  const payload = {
    aud: "authenticated",
    sub: claims.sub,
    role: "authenticated",
    aal: "aal1",
    session_id: claims.sessionId ?? "5e5e5e5e-0000-4000-8000-000000000001",
    iat,
    exp: iat + 3600,
    amr: claims.amr ?? [{ method: "otp", timestamp: Math.floor(claims.authenticatedAt / 1000) }],
  }
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.fixture-signature`
}

export type SessionKind = "valid" | "expired" | "missing" | "transient"

/** What `auth.getSession()` resolves to for a given kind of session. */
export function getSessionResult(kind: SessionKind, sub: string, now = Date.now()) {
  if (kind === "missing") return { data: { session: null }, error: null }
  if (kind === "transient") {
    return { data: { session: null }, error: new AuthRetryableFetchError("fetch failed", 0) }
  }
  const authenticatedAt = kind === "expired" ? now - 31 * DAY_MS : now - DAY_MS
  return { data: { session: { access_token: accessToken({ sub, authenticatedAt }) } }, error: null }
}
