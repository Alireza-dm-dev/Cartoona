import { evaluateSessionPolicy, DEFAULT_SESSION_POLICY, SESSION_ABSOLUTE_LIFETIME_MS } from "@/lib/identity/session-policy";
import { readSupabaseSessionEvidence } from "./supabase-session-evidence";

/**
 * Parent session lifetime for the routes that still run on Supabase (V0.1.43).
 *
 * Replaces the previous lifetime check, whose Supabase RPC read the caller's
 * session row from Supabase's internal auth schema (via the JWT session id):
 * Supabase database internals, and one extra round trip per protected request.
 * Now the same 30-day absolute rule is evaluated by the provider-neutral policy
 * (lib/identity/session-policy.ts) from the session's verified sign-in time,
 * with NO network call.
 *
 * Call it only AFTER `auth.getUser()` succeeded on the same client in the same
 * request (every caller does): that call verified the stored access token
 * with the provider, so its claims are trustworthy. `getSession()` here only
 * reads that same stored session; if the token were about to expire it would
 * be refreshed, and a refreshed token comes straight from the provider. The
 * token's subject must match the verified user.
 *
 * sessions_not_before (forced invalidation) lives in Cartoona's PostgreSQL and
 * is enforced by the backend for backend-authenticated requests; these
 * Supabase-backed routes keep the old guarantee set (absolute lifetime; the
 * provider's own revocation is still caught by getUser).
 *
 * Results are unchanged for callers:
 *   valid            -> continue
 *   expired          -> sign out locally, 401 / login (createParentSessionFailureResponse)
 *   missing_session  -> same as expired (no session, or no usable evidence)
 *   lookup_failed    -> retryable 503, never a sign-out
 */

export const PARENT_SESSION_MAX_DAYS = SESSION_ABSOLUTE_LIFETIME_MS / (24 * 60 * 60 * 1000);

export type ParentSessionLifetimeResult =
  | {
      valid: true;
      sessionStartedAt: string;
      expiresAt: string;
    }
  | {
      valid: false;
      reason: "expired" | "missing_session" | "lookup_failed";
    };

interface SessionReader {
  auth: {
    getSession(): PromiseLike<{
      data: { session: { access_token?: unknown } | null };
      error: unknown;
    }>;
  };
}

export async function checkParentSessionLifetime(
  supabase: SessionReader,
  verifiedUserId: string,
  now: number = Date.now(),
): Promise<ParentSessionLifetimeResult> {
  let session: { access_token?: unknown } | null;
  try {
    const { data, error } = await supabase.auth.getSession();
    // A failed read (a refresh that could not reach the provider) is transient.
    if (error) return { valid: false, reason: "lookup_failed" };
    session = data?.session ?? null;
  } catch {
    return { valid: false, reason: "lookup_failed" };
  }
  if (!session) return { valid: false, reason: "missing_session" };

  const evidence = readSupabaseSessionEvidence(session.access_token);
  if (!evidence || evidence.subject !== verifiedUserId) return { valid: false, reason: "missing_session" };

  const decision = evaluateSessionPolicy({ authenticatedAt: evidence.authenticatedAt }, DEFAULT_SESSION_POLICY, now);
  if (decision.status === "valid") {
    return {
      valid: true,
      sessionStartedAt: new Date(evidence.authenticatedAt).toISOString(),
      expiresAt: new Date(decision.expiresAt).toISOString(),
    };
  }
  if (decision.status === "expired") return { valid: false, reason: "expired" };
  return { valid: false, reason: "missing_session" };
}
