/**
 * Session evidence from a Supabase access token (V0.1.43). The ONLY place that
 * knows Supabase's claim layout; it returns provider-neutral values.
 *
 * TRUST: this decodes, it does not verify. Call it only on a token the
 * provider has just verified in this request: the token passed to
 * `auth.getUser(token)` with a successful answer, or one the provider itself
 * issued in a refresh response. Never on a token taken from the browser without
 * that check.
 *
 * Which claim says when the user signed in (auth-js 2.110 types, Supabase JWT
 * fields): `amr` - "Authentication Methods References", one entry per method
 * the user authenticated with in this session: `{ method, timestamp }`, where
 * timestamp is "when the method was successfully used", unix seconds. The
 * provider keeps these per session and puts the same entries into every access
 * token of that session, refreshed ones included; refreshing is not an
 * authentication method (it is absent from auth-js's AMR method list). So:
 *
 *   authenticatedAt = min(amr[].timestamp)       NOT iat (reset by every refresh)
 *
 * The minimum also means a later step-up (an MFA factor appended to the same
 * session) can never move the session start forward. Entries named
 * "token_refresh" are ignored defensively, in case a provider version ever
 * records refreshes there.
 *
 * Fail closed: no `amr`, string-only `amr` (no timestamps), or a malformed token
 * gives null, which callers treat as an invalid session (sign in again), never
 * as "valid without a lifetime".
 */

export interface SupabaseSessionEvidence {
  subject: string
  sessionId: string
  /** Epoch ms of the earliest authentication in this session. */
  authenticatedAt: number
}

/** base64url -> UTF-8 without Buffer, so this also runs in the middleware runtime. */
function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}
const B64URL = /^[A-Za-z0-9_-]+$/
const MAX_TOKEN_LENGTH = 16 * 1024

export function readSupabaseSessionEvidence(accessToken: unknown): SupabaseSessionEvidence | null {
  if (typeof accessToken !== "string" || accessToken.length > MAX_TOKEN_LENGTH) return null
  const parts = accessToken.split(".")
  if (parts.length !== 3 || !B64URL.test(parts[1])) return null

  let claims: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(parts[1]))
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    claims = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const { sub, session_id: sessionId, amr } = claims
  // The binding that matters is the caller's check that `sub` equals the user
  // the provider just verified; here only shape.
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) return null
  if (typeof sessionId !== "string" || sessionId.trim() === "") return null
  if (!Array.isArray(amr)) return null

  let earliest = Infinity
  for (const entry of amr) {
    if (entry === null || typeof entry !== "object") continue
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown }
    if (method === "token_refresh") continue
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0) continue
    earliest = Math.min(earliest, timestamp)
  }
  if (!Number.isFinite(earliest)) return null

  return { subject: sub, sessionId, authenticatedAt: earliest * 1000 }
}
