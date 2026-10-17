import "server-only"

import { isAuthApiError, isAuthRetryableFetchError, isAuthSessionMissingError, type SupabaseClient } from "@supabase/supabase-js"
import { DEFAULT_SESSION_POLICY, evaluateSessionPolicy } from "@/lib/identity/session-policy"
import { toVerifiedIdentity, type VerifiedIdentity } from "@/lib/identity/types"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { AuthDeadlineError, createAuthDeadlineFetch, withDeadline } from "./auth-deadline"
import { readSupabaseSessionEvidence } from "./supabase-session-evidence"

/**
 * Supabase Auth adapter: the request's session -> a VERIFIED auth context
 * (V0.1.42, session evidence V0.1.43). Supabase is the temporary identity
 * provider; this file and supabase-session-evidence.ts are the only places
 * that know it.
 *
 * Steps, with ONE provider round trip (two only when the access token has
 * expired and must be refreshed first):
 *   1. getSession()      read the session cookie; refresh if expired (the refresh
 *                        response comes from the provider itself)
 *   2. getUser(token)    the provider verifies EXACTLY that access token
 *                        (signature, expiry, session not revoked)
 *   3. read its claims   only now are they trusted: sub must equal the verified
 *                        user, and amr gives the sign-in time (never iat)
 *   4. 30-day policy     an expired session gets no context, so it can never be
 *                        turned into a backend assertion
 *
 * Returns `{ identity, authenticatedAt }` and nothing else: no tokens, no
 * claims, no email or phone. It never queries PostgreSQL or Supabase tables,
 * never decides a role, never reads auth.sessions. sessions_not_before is
 * enforced by the backend, which owns that data.
 *
 * Bounded: the whole verification has ONE deadline (4 s). A provider outage is
 * `auth_unavailable` (503, retry), never a sign-out (see auth-deadline.ts).
 */

export const AUTH_VERIFY_DEADLINE_MS = 4_000

export interface VerifiedAuthContext {
  identity: VerifiedIdentity
  /** When the user signed in, epoch ms, provider-verified. */
  authenticatedAt: number
}

export type IdentityVerification =
  | { ok: true; context: VerifiedAuthContext }
  /** No session at all: signed out. */
  | { ok: false; reason: "no_session" }
  /** A session the provider rejected, or one without usable sign-in evidence. */
  | { ok: false; reason: "invalid_session" }
  /** Signed in more than 30 days ago: sign in again. */
  | { ok: false; reason: "session_expired" }
  /** The provider could not be reached or did not answer in time. Not a sign-out. */
  | { ok: false; reason: "auth_unavailable" }

type AuthClient = Pick<SupabaseClient, "auth">

export interface SupabaseIdentityDeps {
  deadlineMs?: number
  now?: () => number
  /** Builds the client with the deadline fetch; tests inject a stubbed provider. */
  createClient?: (fetchImpl: typeof fetch) => Promise<AuthClient>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type ErrorReason = Exclude<IdentityVerification, { ok: true }>["reason"]

function classify(error: unknown): ErrorReason {
  if (isAuthSessionMissingError(error)) return "no_session"
  if (isAuthRetryableFetchError(error)) return "auth_unavailable"
  if (isAuthApiError(error)) {
    // 5xx-class answers are outages; 4xx means the provider rejected the session.
    return error.status !== undefined && error.status >= 500 ? "auth_unavailable" : "invalid_session"
  }
  return "invalid_session"
}

async function verify(supabase: AuthClient, now: () => number): Promise<IdentityVerification> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) return { ok: false, reason: classify(sessionError) }
  const accessToken = sessionData?.session?.access_token
  if (typeof accessToken !== "string" || accessToken === "") return { ok: false, reason: "no_session" }

  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data?.user) return { ok: false, reason: error ? classify(error) : "invalid_session" }
  if (!UUID.test(data.user.id)) return { ok: false, reason: "invalid_session" }

  // The provider has just accepted exactly this token: its claims can be read.
  const evidence = readSupabaseSessionEvidence(accessToken)
  if (!evidence || evidence.subject !== data.user.id) return { ok: false, reason: "invalid_session" }

  const decision = evaluateSessionPolicy({ authenticatedAt: evidence.authenticatedAt }, DEFAULT_SESSION_POLICY, now())
  if (decision.status === "expired") return { ok: false, reason: "session_expired" }
  if (decision.status !== "valid") return { ok: false, reason: "invalid_session" }

  return {
    ok: true,
    context: {
      identity: toVerifiedIdentity({ provider: "supabase", subject: data.user.id }),
      authenticatedAt: evidence.authenticatedAt,
    },
  }
}

export async function verifySupabaseIdentity(deps: SupabaseIdentityDeps = {}): Promise<IdentityVerification> {
  const deadlineMs = deps.deadlineMs ?? AUTH_VERIFY_DEADLINE_MS
  const now = deps.now ?? Date.now
  const deadlineFetch = createAuthDeadlineFetch(Date.now() + deadlineMs)
  const createClient = deps.createClient ?? ((fetchImpl) => createServerSupabaseClient({ fetch: fetchImpl }))

  try {
    const supabase = await createClient(deadlineFetch)
    return await withDeadline(verify(supabase, now), deadlineMs)
  } catch (error) {
    if (error instanceof AuthDeadlineError) return { ok: false, reason: "auth_unavailable" }
    // Misconfiguration or an unexpected client failure: unavailable, not "signed out".
    return { ok: false, reason: "auth_unavailable" }
  }
}
