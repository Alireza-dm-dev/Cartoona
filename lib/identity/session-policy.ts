/**
 * Cartoona session policy (V0.1.43). Pure and provider-neutral: no Next.js,
 * Supabase or PostgreSQL types, and the clock is passed in.
 *
 * Replaces the Supabase-only `get_current_parent_session_policy` RPC (which read
 * auth.uid(), auth.jwt() ->> 'session_id' and auth.sessions.created_at).
 *
 * Evidence: `authenticatedAt`, when the user actually signed in - established
 * by the identity adapter from provider-VERIFIED data. Never a token's issue
 * time: refreshing a session issues a new token but is not a sign-in, and must
 * not extend the lifetime.
 *
 * Rules (all instants are UTC epoch milliseconds):
 *   expired      now >= authenticatedAt + 30 days          (absolute lifetime)
 *   invalidated  authenticatedAt < ceil_to_second(sessionsNotBefore)
 *                - sessionsNotBefore null => never invalidated
 *                - provider sign-in times have whole-second precision, so the
 *                  cut-off is rounded UP to the next whole second: a session
 *                  that began in the same second as the invalidation is
 *                  treated as before it (one extra sign-in, never a survivor).
 *                - equality (authenticatedAt == the rounded cut-off) is VALID.
 *   invalid evidence  non-finite, non-positive, or more than the skew in the future.
 * Invalidation is checked before expiry: an invalidated session reports
 * `invalidated` even if it has also aged out.
 */

export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
/** Clock difference tolerated between the provider and Cartoona. */
export const SESSION_EVIDENCE_SKEW_MS = 5_000

export interface SessionEvidence {
  /** When the user authenticated (signed in), epoch ms, UTC. */
  authenticatedAt: number
}

export interface CartoonaSessionPolicy {
  absoluteLifetimeMs: number
  /** users.sessions_not_before as epoch ms, or null when never set. */
  sessionsNotBefore: number | null
}

export type SessionDecision =
  | { status: "valid"; expiresAt: number }
  | { status: "expired" }
  | { status: "invalidated" }
  | { status: "invalid_evidence" }

export const DEFAULT_SESSION_POLICY: CartoonaSessionPolicy = {
  absoluteLifetimeMs: SESSION_ABSOLUTE_LIFETIME_MS,
  sessionsNotBefore: null,
}

const isInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0

export function evaluateSessionPolicy(
  evidence: SessionEvidence,
  policy: CartoonaSessionPolicy,
  now: number,
): SessionDecision {
  if (!isInstant(now)) throw new TypeError("evaluateSessionPolicy: invalid clock")
  if (!isInstant(policy.absoluteLifetimeMs)) throw new TypeError("evaluateSessionPolicy: invalid lifetime")
  if (policy.sessionsNotBefore !== null && !isInstant(policy.sessionsNotBefore)) {
    throw new TypeError("evaluateSessionPolicy: invalid sessionsNotBefore")
  }

  const authenticatedAt = evidence?.authenticatedAt
  if (!isInstant(authenticatedAt) || authenticatedAt > now + SESSION_EVIDENCE_SKEW_MS) {
    return { status: "invalid_evidence" }
  }

  if (policy.sessionsNotBefore !== null) {
    const cutoff = Math.ceil(policy.sessionsNotBefore / 1000) * 1000
    if (authenticatedAt < cutoff) return { status: "invalidated" }
  }

  const expiresAt = authenticatedAt + policy.absoluteLifetimeMs
  if (now >= expiresAt) return { status: "expired" }
  return { status: "valid", expiresAt }
}

/** Unix seconds (as providers and the internal assertion carry them) -> epoch ms. */
export function secondsToInstant(seconds: number): number {
  return seconds * 1000
}
