import "server-only";

import { verifySupabaseIdentity, type VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { log } from "@/lib/observability/request-context";

/**
 * The verified caller every parent backend read starts from (V0.1.45, shared
 * since V0.1.46 by the orders LIST and the account reads).
 *
 *   Supabase session cookie -> verifySupabaseIdentity()
 *     provider verifies the token; amr sign-in time; 30 days
 *
 * The result is passed EXPLICITLY to each backend call made for the same
 * request, so one page render or one BFF request verifies the session once,
 * however many backend reads it makes. Nothing is cached across requests and
 * nothing is taken from middleware. Each backend call still gets its own
 * assertion, bound to its own path.
 */

export type ParentCaller =
  | { ok: true; context: VerifiedAuthContext }
  | { ok: false; reason: "unauthenticated" | "session_expired" | "auth_unavailable" };

export async function verifyParentCaller(): Promise<ParentCaller> {
  const verification = await verifySupabaseIdentity();
  if (!verification.ok) {
    const { reason } = verification;
    log(reason === "auth_unavailable" ? "warn" : "info", "AUTH_REJECTED", {
      subsystem: "auth",
      errorCode:
        reason === "auth_unavailable" ? "AUTH_UNAVAILABLE"
        : reason === "no_session" ? "AUTH_MISSING"
        : reason === "session_expired" ? "SESSION_EXPIRED"
        : "AUTH_INVALID",
    });
    if (reason === "auth_unavailable") return { ok: false, reason: "auth_unavailable" };
    if (reason === "session_expired") return { ok: false, reason: "session_expired" };
    return { ok: false, reason: "unauthenticated" };
  }
  return { ok: true, context: verification.context };
}

/** The auth/ownership answers every authenticated parent route can give. */
export type BackendParentRejection =
  | "unauthenticated"
  | "session_expired"
  | "session_invalidated"
  | "identity_not_linked"
  | "forbidden"
  | "parent_profile_not_found";

export type ParentBackendFailure =
  | "session_expired"
  | "session_invalidated"
  | "identity_not_linked"
  | "forbidden"
  | "no_parent_profile"
  | "service_unavailable";

/** Maps a backend 401/403/404 answer to the caller-facing reason, with the same logs everywhere. */
export function mapBackendRejection(error: BackendParentRejection): ParentBackendFailure {
  switch (error) {
    case "session_expired":
    case "session_invalidated":
      log("info", "AUTH_REJECTED", { subsystem: "auth", errorCode: error === "session_expired" ? "SESSION_EXPIRED" : "SESSION_INVALIDATED" });
      return error;
    case "unauthenticated":
      // The backend refusing an assertion we just signed is OUR
      // misconfiguration (secret mismatch, clock skew), not the visitor's session.
      log("error", "AUTH_REJECTED", { subsystem: "auth", errorCode: "AUTH_UNAVAILABLE", reason: "assertion_rejected" });
      return "service_unavailable";
    case "identity_not_linked":
    case "forbidden":
      log("info", "AUTH_REJECTED", { subsystem: "auth", errorCode: error === "forbidden" ? "AUTH_FORBIDDEN" : "IDENTITY_NOT_LINKED" });
      return error;
    case "parent_profile_not_found":
      return "no_parent_profile";
  }
}
