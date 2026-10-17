import "server-only"

import { isAuthApiError, isAuthRetryableFetchError, isAuthSessionMissingError, type SupabaseClient } from "@supabase/supabase-js"
import { toVerifiedIdentity, type VerifiedIdentity } from "@/lib/identity/types"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { AuthDeadlineError, createDeadlineFetch, withDeadline } from "./auth-deadline"

/**
 * Supabase Auth adapter (V0.1.42): the request's session -> a VERIFIED external
 * identity. Supabase is the temporary identity provider; this file is the only
 * place that knows it.
 *
 * What it does: reads the session from the request cookies through the
 * existing server client, and asks the provider to verify it (`getUser()`,
 * which is a server round trip, so a revoked session is caught). The result is
 * `{ provider: "supabase", subject: <auth user id> }` and nothing else.
 *
 * What it never does: trust a user id from the browser, expose the access or
 * refresh token, query PostgreSQL or Supabase tables, look up a role or a
 * profile, read auth.sessions, or decide authorization. Mapping the identity to
 * a Cartoona user is the backend's job (user_identities).
 *
 * Bounded: the whole verification, refreshes included, has ONE deadline
 * (default 4 s, see auth-deadline.ts). An unreachable provider is
 * `auth_unavailable` (503, retry later), never a sign-out.
 */

export const AUTH_VERIFY_DEADLINE_MS = 4_000

export type IdentityVerification =
  | { ok: true; identity: VerifiedIdentity }
  /** No session at all: signed out. */
  | { ok: false; reason: "no_session" }
  /** A session the provider rejected (expired refresh, revoked, malformed). */
  | { ok: false; reason: "invalid_session" }
  /** The provider could not be reached or did not answer in time. Not a sign-out. */
  | { ok: false; reason: "auth_unavailable" }

export interface SupabaseIdentityDeps {
  deadlineMs?: number
  /** Builds the client with the deadline fetch; tests inject a stubbed provider. */
  createClient?: (fetchImpl: typeof fetch) => Promise<Pick<SupabaseClient, "auth">>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function verifySupabaseIdentity(deps: SupabaseIdentityDeps = {}): Promise<IdentityVerification> {
  const deadlineMs = deps.deadlineMs ?? AUTH_VERIFY_DEADLINE_MS
  const deadlineFetch = createDeadlineFetch(Date.now() + deadlineMs)
  const createClient = deps.createClient ?? ((fetchImpl) => createServerSupabaseClient({ fetch: fetchImpl }))

  try {
    const supabase = await createClient(deadlineFetch)
    const { data, error } = await withDeadline(supabase.auth.getUser(), deadlineMs)

    if (data?.user && !error) {
      if (!UUID.test(data.user.id)) return { ok: false, reason: "invalid_session" }
      return { ok: true, identity: toVerifiedIdentity({ provider: "supabase", subject: data.user.id }) }
    }
    if (!error || isAuthSessionMissingError(error)) return { ok: false, reason: "no_session" }
    if (isAuthRetryableFetchError(error)) return { ok: false, reason: "auth_unavailable" }
    if (isAuthApiError(error)) {
      // 5xx-class answers are outages; 4xx means the provider rejected the session.
      return error.status !== undefined && error.status >= 500
        ? { ok: false, reason: "auth_unavailable" }
        : { ok: false, reason: "invalid_session" }
    }
    return { ok: false, reason: "invalid_session" }
  } catch (error) {
    if (error instanceof AuthDeadlineError) return { ok: false, reason: "auth_unavailable" }
    // Misconfiguration or an unexpected client failure: unavailable, not "signed out".
    return { ok: false, reason: "auth_unavailable" }
  }
}
