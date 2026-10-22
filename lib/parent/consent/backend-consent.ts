import "server-only";

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { backendGetJson, backendWriteJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId, log } from "@/lib/observability/request-context";
import { mapBackendRejection, verifyParentCaller, type ParentBackendFailure } from "../backend-caller";
import {
  CONSENT_READ_ACCEPT_STATUSES,
  CONSENT_WRITE_ACCEPT_STATUSES,
  parseBackendConsent,
  type BackendConsentOutcome,
} from "./consent-response";

/**
 * The ONE consent source for every Next caller (V0.1.48): the /login
 * decision (via GET /api/parent/consent), the /parent-consent page, the
 * /complete-request gate, the POST /api/requests gate, and the consent write.
 *
 *   Supabase session cookie -> verifyParentCaller()   (provider verifies; amr; 30 days)
 *   -> backendGetJson / backendWriteJson              (v2 read / v3 write: body digest + nonce)
 *   -> Fastify GET|POST /v1/parent/consent            (parent only; profile from the assertion)
 *   -> PostgreSQL parent_profiles / record_parent_consent_trusted()
 *
 * No Supabase table is read or written here; Supabase is only the identity
 * provider. No browser-supplied user or profile id exists anywhere on this
 * path. Nothing is cached: each call is one fresh backend request.
 *
 * Reads distinguish "not consented" from "could not determine consent": an
 * outage is `service_unavailable`, never `not_granted`, so no gate turns an
 * outage into a redirect to /parent-consent (and back again).
 */

export type ParentConsentStatus =
  | "granted"
  | "not_granted"
  /** No parent_profiles row. Every gate treats it as not consented, as before V0.1.48. */
  | "no_profile";

export type ParentConsentFailure =
  | "unauthenticated" //   no session, or the provider rejected it
  | "auth_unavailable" //  identity provider down or too slow (never a sign-out)
  | Exclude<ParentBackendFailure, "no_parent_profile">;

export type ParentConsentRead =
  | { ok: true; status: ParentConsentStatus; consentGrantedAt: string | null }
  | { ok: false; reason: ParentConsentFailure };

function rejectionToFailure(outcome: Extract<BackendConsentOutcome, { kind: "rejected" }>): ParentConsentFailure {
  // 409 only exists on the write; the write handles it before reaching here.
  if (outcome.error === "replayed_request" || outcome.error === "parent_profile_not_found") return "service_unavailable";
  const mapped = mapBackendRejection(outcome.error);
  return mapped === "no_parent_profile" ? "service_unavailable" : mapped;
}

/** One v2 read of the caller's consent, for an already verified caller. */
export async function fetchParentConsent(context: VerifiedAuthContext): Promise<ParentConsentRead> {
  let outcome: BackendConsentOutcome;
  try {
    ({ data: outcome } = await backendGetJson({
      operation: "parent_consent",
      path: "/v1/parent/consent",
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: CONSENT_READ_ACCEPT_STATUSES,
      parse: parseBackendConsent,
    }));
  } catch (error) {
    // Timeout, refused connection, 5xx (incl. the backend's database 503),
    // not configured, or an invalid body: consent could not be determined.
    if (isBackendClientError(error)) return { ok: false, reason: "service_unavailable" };
    throw error;
  }
  if (outcome.kind === "value") {
    const { consentGranted, consentGrantedAt } = outcome.value;
    return { ok: true, status: consentGranted ? "granted" : "not_granted", consentGrantedAt };
  }
  if (outcome.error === "parent_profile_not_found") return { ok: true, status: "no_profile", consentGrantedAt: null };
  return { ok: false, reason: rejectionToFailure(outcome) };
}

/** Verify the session (once), then read consent. For pages and routes that need nothing else. */
export async function loadParentConsent(): Promise<ParentConsentRead> {
  const caller = await verifyParentCaller();
  if (!caller.ok) return caller;
  return fetchParentConsent(caller.context);
}

export type ParentConsentWrite =
  | {
      ok: true;
      consentGrantedAt: string | null;
      /** "write": the backend confirmed it. "read_after_uncertain": the write's answer was lost, a fresh read found consent granted. */
      confirmedBy: "write" | "read_after_uncertain";
    }
  | { ok: false; reason: ParentConsentFailure | "no_parent_profile" | "outcome_unknown" };

/**
 * Grant consent: ONE v3 write (fresh nonce, body digest), never retried.
 *
 * When the answer is lost after the request may have reached the backend
 * (timeout, reset, 5xx, unreadable 2xx, or 409: its nonce was already used,
 * which can only mean this very request arrived before), the write may have
 * committed. The same assertion is NEVER re-sent. Instead consent is re-read
 * with a new read assertion: granted -> success; anything else ->
 * `outcome_unknown`, which the UI reports as "could not confirm", never as
 * "failed". A later user retry is a new request with a new nonce, and safe:
 * granting is one-way and keeps the first grant's time.
 */
export async function grantParentConsent(context: VerifiedAuthContext): Promise<ParentConsentWrite> {
  let outcome: BackendConsentOutcome;
  try {
    ({ data: outcome } = await backendWriteJson({
      operation: "parent_consent_grant",
      method: "POST",
      path: "/v1/parent/consent",
      body: { consentGranted: true },
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: CONSENT_WRITE_ACCEPT_STATUSES,
      parse: parseBackendConsent,
    }));
  } catch (error) {
    if (!isBackendClientError(error)) throw error;
    // Never sent (not configured) or a definite non-5xx refusal: not written.
    if (!error.outcomeUnknown) return { ok: false, reason: "service_unavailable" };
    return confirmAfterUncertainWrite(context);
  }

  if (outcome.kind === "value") {
    return { ok: true, consentGrantedAt: outcome.value.consentGrantedAt, confirmedBy: "write" };
  }
  if (outcome.error === "replayed_request") return confirmAfterUncertainWrite(context);
  if (outcome.error === "parent_profile_not_found") return { ok: false, reason: "no_parent_profile" };
  return { ok: false, reason: rejectionToFailure(outcome) };
}

async function confirmAfterUncertainWrite(context: VerifiedAuthContext): Promise<ParentConsentWrite> {
  const read = await fetchParentConsent(context);
  if (read.ok && read.status === "granted") {
    log("info", "CONSENT_CONFIRMED_AFTER_UNCERTAIN_WRITE", { subsystem: "backend", operation: "parent_consent_grant" });
    return { ok: true, consentGrantedAt: read.consentGrantedAt, confirmedBy: "read_after_uncertain" };
  }
  log("warn", "CONSENT_OUTCOME_UNKNOWN", {
    subsystem: "backend",
    operation: "parent_consent_grant",
    outcomeUnknown: true,
    reason: read.ok ? read.status : read.reason,
  });
  return { ok: false, reason: "outcome_unknown" };
}
