import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { isParentRole } from "@/lib/auth/parent-access";
import {
  checkCurrentParentSessionLifetime,
  type ParentSessionLifetimeResult,
} from "@/lib/auth/parent-session-lifetime";
import { logAuthLookup } from "@/lib/observability/auth-events";

/**
 * Who is making this request, resolved ONCE and then passed down.
 *
 * Before this existed, one orders page render called `auth.getUser()` twice,
 * and the order detail page repeated user/profile lookups inside every query
 * helper. Each is a network round trip. Here the identity is resolved a single
 * time per request and handed to the query helpers as a plain value.
 *
 * Request-scoped by construction: there is no module-level state and nothing
 * is cached across requests or users. A new request builds a new context.
 *
 * Two verification levels:
 *  - "full"     user + role + lifetime + profile. For API routes, which have no
 *               middleware in front of them for their own checks. Role, profile
 *               and lifetime are independent once the user is known, so they
 *               run in parallel.
 *  - "identity" user + profile only. For /dashboard pages, where middleware has
 *               already enforced role and session lifetime on this very request
 *               (middleware.ts); repeating them would only add round trips.
 *
 * Neither level bypasses RLS: every read stays on the caller's session client.
 */

export interface ParentRequestContext {
  userId: string;
  /** Null at the "identity" level, where middleware owns the role check. */
  role: string | null;
  parentProfileId: string;
}

export type ParentContextFailure =
  /** No valid user. Expected traffic, not an incident. */
  | { reason: "unauthenticated" }
  /** The auth backend could not be reached. Retryable; the session is intact. */
  | { reason: "auth_unavailable" }
  | { reason: "not_parent" }
  /**
   * Lifetime check did not pass. Carries the original result so callers reuse
   * createParentSessionFailureResponse: `lookup_failed` stays a retryable 503
   * that never signs out; only a definite expiry ends the session.
   */
  | {
      reason: "session_invalid";
      lifetime: Extract<ParentSessionLifetimeResult, { valid: false }>;
    }
  | { reason: "no_parent_profile" }
  | { reason: "read_failed" };

export type ParentContextResult =
  | { ok: true; context: ParentRequestContext }
  | ({ ok: false } & ParentContextFailure);

export async function resolveParentRequestContext(
  supabase: SupabaseClient,
  options: { verify: "full" | "identity" },
): Promise<ParentContextResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    logAuthLookup(authError);
    // A transient failure is not "logged out": never send it to the login page.
    if (authError && isAuthRetryableFetchError(authError)) {
      return { ok: false, reason: "auth_unavailable" };
    }
    return { ok: false, reason: "unauthenticated" };
  }

  const profileQuery = supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (options.verify === "identity") {
    const { data: profile, error } = await profileQuery;
    if (error) return { ok: false, reason: "read_failed" };
    if (!profile?.id) return { ok: false, reason: "no_parent_profile" };
    return { ok: true, context: { userId: user.id, role: null, parentProfileId: profile.id } };
  }

  const [roleResult, profileResult, lifetime] = await Promise.all([
    supabase.from("users").select("role").eq("id", user.id).maybeSingle(),
    profileQuery,
    checkCurrentParentSessionLifetime(supabase),
  ]);

  // Order matters: an admin must never be treated as a parent, and a role
  // lookup that failed is not a "wrong role".
  if (roleResult.error) return { ok: false, reason: "read_failed" };
  const role = roleResult.data?.role;
  if (typeof role !== "string" || !isParentRole(role)) return { ok: false, reason: "not_parent" };

  if (!lifetime.valid) return { ok: false, reason: "session_invalid", lifetime };

  if (profileResult.error) return { ok: false, reason: "read_failed" };
  const profileId = profileResult.data?.id;
  if (!profileId) return { ok: false, reason: "no_parent_profile" };

  return { ok: true, context: { userId: user.id, role, parentProfileId: profileId } };
}
