import "server-only";

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { backendWriteJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId, log } from "@/lib/observability/request-context";
import { fetchParentConsent } from "../consent/backend-consent";

/**
 * The post-sign-in bootstrap (V0.1.49): make sure the verified Supabase
 * parent exists in Cartoona's PostgreSQL (user, identity, profile, wallet,
 * welcome credits) BEFORE any migrated parent route needs it.
 *
 *   verified caller -> backendWriteJson (v3: body digest + nonce, body {})
 *   -> Fastify POST /v1/auth/provision -> provision_supabase_parent_identity()
 *
 * The body is always `{}`: the backend takes the subject from the assertion
 * and fixes the role itself. Nothing from the browser reaches this call.
 *
 * One write, never re-sent. When its answer is lost (timeout, reset, 5xx,
 * unreadable 2xx, 409 replayed_request: this very request arrived before),
 * provisioning may have committed. A fresh v2 consent read then decides: it
 * answers 200 only for a linked parent WITH a profile, i.e. a complete
 * account. Otherwise `outcome_unknown`; the parent's retry is a new request,
 * and provisioning is idempotent, so it is always safe.
 */

export type ParentAccountSetupFailure =
  | "session_expired"
  | "session_invalidated"
  | "forbidden" //           soft-deleted account, or not a parent
  | "identity_conflict" //   bound to another account: support must look
  | "service_unavailable" // definitely not provisioned now; retry
  | "outcome_unknown"; //    may or may not be provisioned; retry is safe

export type ParentAccountSetup =
  | { ok: true; confirmedBy: "write" | "read_after_uncertain" }
  | { ok: false; reason: ParentAccountSetupFailure };

type BackendProvisionOutcome =
  | { kind: "provisioned" }
  | { kind: "rejected"; error: "unauthenticated" | "session_expired" | "session_invalidated" | "forbidden" | "identity_conflict" | "replayed_request" };

const ERRORS: Record<number, readonly string[]> = {
  401: ["unauthenticated", "session_expired", "session_invalidated"],
  403: ["forbidden"],
  409: ["identity_conflict", "replayed_request"],
};

export const PROVISION_ACCEPT_STATUSES = [401, 403, 409] as const;

/** Strict: 200 must be exactly { provisioned: true }; anything else throws (-> invalid_response). */
export function parseBackendProvision(json: unknown, status: number): BackendProvisionOutcome {
  const body = (json ?? {}) as Record<string, unknown>;
  if (status !== 200) {
    if (typeof body.error === "string" && ERRORS[status]?.includes(body.error)) {
      return { kind: "rejected", error: body.error as Extract<BackendProvisionOutcome, { kind: "rejected" }>["error"] };
    }
    throw new Error("unexpected backend body");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json) || body.provisioned !== true) {
    throw new Error("body");
  }
  return { kind: "provisioned" };
}

export async function provisionParentAccount(context: VerifiedAuthContext): Promise<ParentAccountSetup> {
  let outcome: BackendProvisionOutcome;
  try {
    ({ data: outcome } = await backendWriteJson({
      operation: "parent_provision",
      method: "POST",
      path: "/v1/auth/provision",
      body: {},
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: PROVISION_ACCEPT_STATUSES,
      parse: parseBackendProvision,
    }));
  } catch (error) {
    if (!isBackendClientError(error)) throw error;
    // Never sent (not configured) or a definite non-5xx refusal: not written.
    if (!error.outcomeUnknown) return { ok: false, reason: "service_unavailable" };
    return confirmAfterUncertainProvision(context);
  }

  if (outcome.kind === "provisioned") return { ok: true, confirmedBy: "write" };
  switch (outcome.error) {
    case "replayed_request":
      return confirmAfterUncertainProvision(context);
    case "unauthenticated":
      // The backend refusing an assertion we just signed is OUR
      // misconfiguration (secret, clock), not the visitor's session.
      log("error", "AUTH_REJECTED", { subsystem: "auth", errorCode: "AUTH_UNAVAILABLE", reason: "assertion_rejected" });
      return { ok: false, reason: "service_unavailable" };
    case "identity_conflict":
      log("error", "PROVISION_REJECTED", { subsystem: "backend", operation: "parent_provision", reason: "identity_conflict" });
      return { ok: false, reason: "identity_conflict" };
    default:
      return { ok: false, reason: outcome.error };
  }
}

async function confirmAfterUncertainProvision(context: VerifiedAuthContext): Promise<ParentAccountSetup> {
  const read = await fetchParentConsent(context);
  if (read.ok && (read.status === "granted" || read.status === "not_granted")) {
    log("info", "PROVISION_CONFIRMED_AFTER_UNCERTAIN_WRITE", { subsystem: "backend", operation: "parent_provision" });
    return { ok: true, confirmedBy: "read_after_uncertain" };
  }
  log("warn", "PROVISION_OUTCOME_UNKNOWN", {
    subsystem: "backend",
    operation: "parent_provision",
    outcomeUnknown: true,
    reason: read.ok ? read.status : read.reason,
  });
  return { ok: false, reason: "outcome_unknown" };
}
