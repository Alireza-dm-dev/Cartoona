import "server-only";

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { backendGetJson, backendWriteJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId, log } from "@/lib/observability/request-context";
import { mapBackendRejection, type ParentBackendFailure } from "@/lib/parent/backend-caller";
import {
  REQUEST_LOOKUP_ACCEPT_STATUSES,
  REQUEST_WRITE_ACCEPT_STATUSES,
  parseBackendRequestLookup,
  parseBackendRequestWrite,
  type BackendCreatedRequest,
  type BackendRequestLookupOutcome,
  type BackendRequestOrder,
  type BackendRequestWriteOutcome,
} from "./backend-request-response";

/**
 * Request submission through the backend (V0.1.50). The ONLY request-business
 * path from Next:
 *
 *   verified Supabase context (the caller already ran verifyParentCaller)
 *   -> backendWriteJson  POST /v1/parent/requests        (v3: body digest + one-time nonce)
 *   -> create_parent_request_trusted() in PostgreSQL     (order + spend + ledger: one transaction)
 *
 * No Supabase table or RPC is touched here. The write is ONE attempt and is
 * never re-sent. When its answer is lost after it may have reached the backend
 * (timeout, reset, 5xx, unreadable 2xx, or 409: the assertion's nonce was used,
 * so this very request arrived before) the request may have COMMITTED, so:
 *
 *   1. look the submission key up with a fresh v2 read (the caller's own order only);
 *   2. found  -> success (the same order a replay would have returned: no new charge);
 *      absent -> `not_created`: the retry is safe because it carries the SAME
 *               submission key (the database replays instead of charging twice);
 *      lookup failed -> `outcome_unknown`: say "could not confirm", never "failed".
 *
 * No assertion is reused and no key is minted here. Safe to retry means: new
 * assertion, new nonce, the SAME submissionKey (the client keeps it).
 */

export interface BackendRequestPayload {
  submissionKey: string;
  orderId: string;
  type: "image" | "video" | "drawing_animation";
  title: string | null;
  description: string | null;
  /** The character NAME (or id) from the draft; the backend resolves it. */
  character: string | null;
  durationKey: string | null;
  durationChoice: string | null;
  videoScript: string | null;
  videoStyle: string | null;
  animationStyle: string | null;
  charactersSpeak: boolean | null;
  childName: string | null;
  /** Storage-derived: set by the route from the object it uploaded or copied, never from the browser. */
  file: { path: string; mimeType: string; originalFilename: string | null } | null;
}

export type BackendRequestCreate =
  | { ok: true; order: BackendCreatedRequest; confirmedBy: "write" | "lookup" }
  /** The backend refused it: nothing was created or charged. `error` is the safe token. */
  | { ok: false; reason: "refused"; error: string }
  | { ok: false; reason: ParentBackendFailure | "unavailable" }
  /** Answer lost; a fresh lookup found no order for this key. Retry with the same key. */
  | { ok: false; reason: "not_created" }
  /** Answer lost and the lookup could not say either. */
  | { ok: false; reason: "outcome_unknown" };

export type BackendRequestLookup =
  | { ok: true; found: false }
  | { ok: true; found: true; order: BackendRequestOrder }
  | { ok: false; reason: ParentBackendFailure };

/** One v2 read: the caller's own order for a submission key. */
export async function lookupRequestBySubmissionKey(
  context: VerifiedAuthContext,
  submissionKey: string,
): Promise<BackendRequestLookup> {
  let outcome: BackendRequestLookupOutcome;
  try {
    ({ data: outcome } = await backendGetJson({
      operation: "parent_request_by_key",
      path: "/v1/parent/requests/by-submission-key",
      query: { submissionKey },
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: REQUEST_LOOKUP_ACCEPT_STATUSES,
      parse: parseBackendRequestLookup,
    }));
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, reason: "service_unavailable" };
    throw error;
  }
  if (outcome.kind === "found") return { ok: true, found: true, order: outcome.value };
  if (outcome.kind === "absent") return { ok: true, found: false };
  if (outcome.error === "invalid_request") return { ok: false, reason: "service_unavailable" };
  return { ok: false, reason: mapBackendRejection(outcome.error as Parameters<typeof mapBackendRejection>[0]) };
}

async function confirmAfterUncertainWrite(context: VerifiedAuthContext, submissionKey: string): Promise<BackendRequestCreate> {
  const read = await lookupRequestBySubmissionKey(context, submissionKey);
  if (read.ok && read.found) {
    log("info", "REQUEST_CONFIRMED_AFTER_UNCERTAIN_WRITE", { subsystem: "backend", operation: "parent_request_create" });
    // Report it as the original order it is: not a "replay" the parent has to understand.
    return { ok: true, order: { ...read.order, replayed: false }, confirmedBy: "lookup" };
  }
  if (read.ok) {
    log("warn", "REQUEST_NOT_FOUND_AFTER_UNCERTAIN_WRITE", { subsystem: "backend", operation: "parent_request_create", outcomeUnknown: true });
    return { ok: false, reason: "not_created" };
  }
  log("warn", "REQUEST_OUTCOME_UNKNOWN", { subsystem: "backend", operation: "parent_request_create", outcomeUnknown: true, reason: read.reason });
  return { ok: false, reason: "outcome_unknown" };
}

/** Create the request: ONE v3 write, never retried. See the header for the uncertain-outcome rules. */
export async function createRequestViaBackend(
  context: VerifiedAuthContext,
  payload: BackendRequestPayload,
): Promise<BackendRequestCreate> {
  let outcome: BackendRequestWriteOutcome;
  try {
    ({ data: outcome } = await backendWriteJson({
      operation: "parent_request_create",
      method: "POST",
      path: "/v1/parent/requests",
      body: payload,
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: REQUEST_WRITE_ACCEPT_STATUSES,
      parse: parseBackendRequestWrite,
    }));
  } catch (error) {
    if (!isBackendClientError(error)) throw error;
    // Never sent (not configured): definitely nothing written.
    if (!error.outcomeUnknown) return { ok: false, reason: "unavailable" };
    return confirmAfterUncertainWrite(context, payload.submissionKey);
  }

  if (outcome.kind === "created") return { ok: true, order: outcome.value, confirmedBy: "write" };

  const { status, error } = outcome;
  // 409 replayed_request: this assertion's nonce was already used, so the
  // request reached the backend before. 503 service_unavailable: a database
  // failure that may have followed the commit. Both are "may have written".
  if (error === "replayed_request" || (status === 503 && error === "service_unavailable")) {
    return confirmAfterUncertainWrite(context, payload.submissionKey);
  }
  if (status === 401 || (status === 403 && (error === "identity_not_linked" || error === "forbidden"))) {
    return { ok: false, reason: mapBackendRejection(error as Parameters<typeof mapBackendRejection>[0]) };
  }
  if (error === "parent_profile_not_found") return { ok: false, reason: "no_parent_profile" };
  return { ok: false, reason: "refused", error };
}
