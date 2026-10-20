import "server-only";

import { verifySupabaseIdentity, type VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { backendGetJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId, log } from "@/lib/observability/request-context";
import type { OrdersListQuery } from "./list-query";
import { parseBackendOrders, type BackendOrdersOutcome } from "./list-response";
import type { ParentOrderSummary } from "./types";

/**
 * The parent orders LIST through the backend (V0.1.45). Shared by the
 * /dashboard/orders first page (server component) and GET /api/parent/orders
 * (load more), so both read the SAME database:
 *
 *   Supabase session cookie
 *     -> verifySupabaseIdentity()   provider verifies the token; amr sign-in time; 30 days
 *     -> backendGetJson()           signed v2 assertion for GET /v1/parent/orders, one attempt, bounded
 *     -> Fastify requireAuth + requireRole("parent") -> parent profile -> PostgreSQL
 *
 * No Supabase table, RPC or PostgreSQL access happens here; Supabase is used
 * only as the identity provider. The caller never supplies an identity: the
 * backend derives the parent from the assertion.
 *
 * The result is a closed set of reasons; callers map them to HTTP or UI.
 */

export type ParentOrdersListFailure =
  | "unauthenticated" //       no session, or the provider rejected it
  | "session_expired" //       signed in more than 30 days ago
  | "session_invalidated" //   signed in before users.sessions_not_before
  | "auth_unavailable" //      identity provider down or too slow (never a sign-out)
  | "identity_not_linked" //   verified, but no Cartoona user mapped
  | "forbidden" //             not a parent account (admin, super_admin) or deleted
  | "no_parent_profile" //     a parent with no profile yet
  | "invalid_request" //       cursor/limit refused by the backend
  | "service_unavailable"; //  backend down, slow, misconfigured, malformed, or the DB failed

export type ParentOrdersListResult =
  | { ok: true; orders: ParentOrderSummary[]; nextCursor: string | null }
  | { ok: false; reason: ParentOrdersListFailure };

export type ParentOrdersCaller =
  | { ok: true; context: VerifiedAuthContext }
  | { ok: false; reason: "unauthenticated" | "session_expired" | "auth_unavailable" };

/**
 * Step 1: verify the session with the identity provider. Separate so the
 * /dashboard/orders page can redirect a signed-out visitor BEFORE it starts
 * streaming, and then fetch the list inside its Suspense boundary.
 */
export async function verifyParentOrdersCaller(): Promise<ParentOrdersCaller> {
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

/** Both steps, for the API route. */
export async function loadParentOrdersPage(query: OrdersListQuery): Promise<ParentOrdersListResult> {
  const caller = await verifyParentOrdersCaller();
  if (!caller.ok) return caller;
  return fetchParentOrdersPage(caller.context, query);
}

/** Step 2: one bounded backend call with a signed assertion for this verified caller. */
export async function fetchParentOrdersPage(
  context: VerifiedAuthContext,
  query: OrdersListQuery,
): Promise<ParentOrdersListResult> {
  let outcome: BackendOrdersOutcome;
  try {
    ({ data: outcome } = await backendGetJson({
      operation: "parent_orders",
      path: "/v1/parent/orders",
      query: {
        cursor: query.cursor ?? undefined,
        limit: query.limit === null ? undefined : String(query.limit),
      },
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: [400, 401, 403, 404],
      parse: parseBackendOrders,
    }));
  } catch (error) {
    // Timeout, refused connection, 5xx (incl. the backend's database 503),
    // not configured, or a body that failed validation: all one safe outcome.
    if (isBackendClientError(error)) return { ok: false, reason: "service_unavailable" };
    throw error;
  }

  if (outcome.kind === "page") return { ok: true, orders: outcome.orders, nextCursor: outcome.nextCursor };

  switch (outcome.error) {
    case "session_expired":
    case "session_invalidated":
      log("info", "AUTH_REJECTED", { subsystem: "auth", errorCode: outcome.error === "session_expired" ? "SESSION_EXPIRED" : "SESSION_INVALIDATED" });
      return { ok: false, reason: outcome.error };
    case "unauthenticated":
      // The backend refusing an assertion we just signed is OUR
      // misconfiguration (secret mismatch, clock skew), not the visitor's session.
      log("error", "AUTH_REJECTED", { subsystem: "auth", errorCode: "AUTH_UNAVAILABLE", reason: "assertion_rejected" });
      return { ok: false, reason: "service_unavailable" };
    case "identity_not_linked":
    case "forbidden":
      log("info", "AUTH_REJECTED", { subsystem: "auth", errorCode: outcome.error === "forbidden" ? "AUTH_FORBIDDEN" : "IDENTITY_NOT_LINKED" });
      return { ok: false, reason: outcome.error };
    case "parent_profile_not_found":
      return { ok: false, reason: "no_parent_profile" };
    case "invalid_request":
      return { ok: false, reason: "invalid_request" };
  }
}
