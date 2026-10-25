import "server-only"

import { verifySupabaseIdentity, type VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { callGet } from "@/lib/backend/call"
import { isPrincipalRole, type PrincipalRole } from "@/lib/identity/types"
import { log } from "@/lib/observability/request-context"

/**
 * The ONE place Next learns a caller's Cartoona role (V0.1.53).
 *
 *   Supabase Auth verifies WHO (session cookie -> provider-verified subject)
 *   -> v2 assertion -> Fastify GET /v1/auth/me -> user_identities + users in PostgreSQL
 *
 * Nothing reads Supabase `public.users` any more: the role, a deleted account,
 * an unlinked identity and the 30-day / sessions_not_before session policy are
 * all answered by the backend, from PostgreSQL. The Edge middleware cannot do
 * this (no node:crypto, no internal secret) and no longer tries: it only checks
 * that a session exists; every privileged server page and route calls this (or
 * its backend route refuses the role itself).
 *
 * Fail closed. An outage is `unavailable` (retry, never a sign-out and never
 * privileged access); a definite end of session is `session_expired`.
 */

export type RoleFailure =
  | "unauthenticated"
  | "session_expired" //       30-day lifetime over or signed in before sessions_not_before (sign out)
  | "identity_not_linked" //   verified at the provider, no Cartoona account yet
  | "forbidden" //             linked account is deleted / not allowed
  | "unavailable" //           provider or backend/database down: retry

export type RoleResolution =
  | { ok: true; role: PrincipalRole; userId: string; context: VerifiedAuthContext }
  | { ok: false; reason: RoleFailure }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Resolve the role of an already-verified context (the dev route verifies its own temporary session). */
export async function resolveRoleForContext(context: VerifiedAuthContext): Promise<RoleResolution> {
  const result = await callGet(context, "auth_role", "/v1/auth/me")
  if (result.ok) {
    const { userId, role } = result.body
    if (typeof userId !== "string" || !UUID.test(userId) || !isPrincipalRole(role)) {
      log("error", "AUTH_ROLE_MALFORMED", { subsystem: "auth", errorCode: "AUTH_UNAVAILABLE" })
      return { ok: false, reason: "unavailable" }
    }
    return { ok: true, role, userId, context }
  }
  if (result.kind === "auth") {
    switch (result.reason) {
      case "session_expired":
      case "session_invalidated":
        return { ok: false, reason: "session_expired" }
      case "identity_not_linked":
        return { ok: false, reason: "identity_not_linked" }
      case "forbidden":
        return { ok: false, reason: "forbidden" }
      default:
        // The backend refusing an assertion we just signed is OUR misconfiguration, not the visitor's session.
        log("error", "AUTH_REJECTED", { subsystem: "auth", errorCode: "AUTH_UNAVAILABLE", reason: "assertion_rejected" })
        return { ok: false, reason: "unavailable" }
    }
  }
  return { ok: false, reason: "unavailable" }
}

/** Verify the request's session with the provider, then resolve the role from PostgreSQL. */
export async function resolveCallerRole(): Promise<RoleResolution> {
  const verification = await verifySupabaseIdentity()
  if (!verification.ok) {
    switch (verification.reason) {
      case "no_session":
      case "invalid_session":
        return { ok: false, reason: "unauthenticated" }
      case "session_expired":
        return { ok: false, reason: "session_expired" }
      case "auth_unavailable":
        return { ok: false, reason: "unavailable" }
    }
  }
  return resolveRoleForContext((verification as Extract<typeof verification, { ok: true }>).context)
}

export const isAdminPrincipal = (role: PrincipalRole): boolean => role === "admin" || role === "super_admin"
